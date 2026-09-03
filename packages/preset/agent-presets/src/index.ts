/**
 * Agent Preset：每个 Session 从一份 Preset `cordis.yml` 组合面向模型的插件集。同一 Preset
 * 只在常驻 Scope 下挂载一次，所有使用该名称的 Agent 都加入这份组合。
 *
 * 常驻挂载使 Preset 成为“每个 Preset 一份组合”，而不是“每个 Session 一份组合”。插件
 * 实例、Tool 注册、Prompt 段和投影单元只存在一份，插件内部再按 Session 区分数据。Agent
 * 通过 {@link bindScopeParent} 把自己的 Scope Key 接到常驻挂载下，于是能够看到该挂载的
 * 注册，并让挂载监听器接收自己的事件。没有 Agent 的宿主读取方也能按 Preset id 解析同一
 * 常驻注册。
 *
 * 本包负责 Preset 定义、文件系统发现和受保护的常驻挂载，不决定何时创建 Agent。唯一支持
 * 的调用点是 AgentFactory 的 `setup(agentCtx)`：此时 Agent 尚未发布，组合失败可以回滚
 * 整次创建。
 * @module @deepseek-ai/dsh-agent-presets
 */

import { stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { bindScopeParent, createScope, scopeOf, type Scope, type ScopeKey, type ScopeParentBinding } from '@deepseek-ai/dsh-scope'
// 仅导入类型副作用，使本服务监听的 agent/created 生命周期事件完成类型注册。
import type {} from '@deepseek-ai/dsh-agent'
import { settingsNamespace, type SettingsScope, type default as SettingsService } from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { discoverPresets, USER_PRESET_DIR } from './discovery.ts'
import { copyComposition, deleteComposition, readComposition } from './authoring.ts'
import { mountPreset, serviceForAgent, standingMountFor } from './mount.ts'
import { PresetExistsError } from './authoring.ts'
import { PresetMountError, UnknownPresetError, type AgentPreset, type Config, type PresetRoot } from './preset.ts'
import type {} from './types.ts'

/** Settings namespace carrying the user's chosen default preset. */
export const SETTINGS_NAMESPACE = 'agent-presets'

/** The user-writable slice of this plugin's config. */
export interface AgentPresetSettings {
  /** Preset mounted when a session names none. */
  default?: string
}

/** Runtime schema for the user-writable slice. */
export const AgentPresetSettingsSchema: z<AgentPresetSettings> = z.object({
  default: z.string(),
})

export { COMPOSITION_FILE, discoverPresets, scanRoot } from './discovery.ts'
export {
  METADATA_FILE, readPresetMetadata, renderPresetMetadata, type PresetMetadata,
} from './metadata.ts'
export {
  inactiveRows, leakedServices, livePresetMounts, mountPreset, serviceForAgent, standingMountFor,
  type JoinedPresetMount, type PresetMount,
} from './mount.ts'
export {
  copyComposition, deleteComposition, InvalidPresetIdError, PresetExistsError,
  PresetNotWritableError, readComposition, writableRoot,
} from './authoring.ts'
export { resolveSessionPreset, type PresetBearingSession } from './session.ts'
export { PresetMountError, UnknownPresetError } from './preset.ts'
export type { AgentPreset, Config, PresetRoot, PresetTrust } from './preset.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresets: AgentPresets
  }
}

/**
 * 当前部署的 Agent Preset 注册表。发现结果不缓存：`list()` 和 `resolve()` 每次调用都会
 * 重新读取根目录，使进程运行期间新增的 Preset 立即可见，被删除的 Preset 也会在下一次
 * 读取时消失。
 */
export class AgentPresets extends Service {
  static inject = ['loader']

  /** Runtime schema for the preset roster. */
  static Config = z.object({
    default: z.string().required(),
    roots: z.array(z.object({
      path: z.string().required(),
      trust: z.union(['system', 'user'] as const).default('user'),
    })).default([]),
    includeUserRoot: z.boolean().default(true),
  }) as z<Config>

  /**
   * The roots discovery and authoring actually scan: every configured root in
   * order, then the harness-home user root unless `includeUserRoot` is false.
   *
   * Derived once, because a root set that changed between `list()` and the
   * `copy()` acting on its answer would author into a directory the caller
   * never saw. Appending rather than prepending keeps an earlier configured
   * root winning a duplicate id, so a shipped preset still shadows a
   * locally authored directory that claimed its name.
   */
  private readonly resolvedRoots: readonly PresetRoot[]

  /**
   * The user layer over `config.default`, present only while a settings
   * provider is composed. Held rather than snapshotted so a hot-reloaded
   * document takes effect without a restart.
   */
  private settings: SettingsScope<AgentPresetSettings> | undefined

  /**
   * The settings service behind {@link settings}, held for the one write this
   * service makes: clearing a user default it has just deleted.
   */
  private settingsService: SettingsService | undefined

  /**
   * The service's own untraced context. Methods invoked through the traceable
   * proxy see `this.ctx` rebound to the CALLER's context, which carries a
   * shadow; a subtree minted from it resolves every service through that
   * shadow's fiber instead of each entry's own inject store, so preset rows
   * would fail on the very services they declare. Standing mounts must hang
   * off the untraced original (the `jobs-local` selfCtx precedent).
   */
  private readonly selfCtx: Context

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
    this.selfCtx = ctx
    this.resolvedRoots = config.includeUserRoot
      ? [...config.roots, { path: dshHomePath(USER_PRESET_DIR), trust: 'user' }]
      : [...config.roots]
    // 这里故意不用 installSettingsSection。该帮助函数用于在设置挂载、卸载和变化时重新计算
    // Consumer 从来源派生的缓存结果或注册级信息；这里没有派生状态，defaultId 每次调用都
    // 直接读取当前来源，因此两个 Hook 都只会是空操作。
    ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings.register(
        settingsNamespace(SETTINGS_NAMESPACE),
        AgentPresetSettingsSchema,
        { base: { default: config.default } },
      )
      this.settingsService = settingsCtx.settings
      settingsCtx.effect(() => () => {
        this.settings = undefined
        this.settingsService = undefined
      }, 'agentPresets.settings()')
    })

    // 这里只给出警告，不能致命失败：同步 agent/created 监听器一旦抛错会否决发布，但在预设
    // 清单外创建 Agent 是合法行为；下方 recompose 就会绑定这种裸 Agent，ACP、SDK Server
    // 和 Headless 入口也都会创建。真正的不变量检查在组装阶段明确失败；未加入 Preset 的
    // Agent 为何重要，统一记录在对应架构 Agent Note 中。
    //
    // 已知误报：裸创建后再由 recompose 绑定的 Session 会在首次绑定前收到一次警告。当前
    // 正式流程不会这样做；Web 在 setup 中挂载，子 Agent 在发布前通过 composeFrom 加入。
    ctx.on('agent/created', ({ agent }) => {
      if (this.resolvedRoots.length === 0) return
      if (this.composedPreset(agent.ctx) !== undefined) return
      ctx.logger.warn(
        `agent "${agent.id}" was published without joining an agent preset; `
        + 'its tools, prompt sections, and skill catalog resolve against the empty global layer '
        + '(join through AgentPresets.mount() or composeFrom() in the agent factory setup)',
      )
    })

    // 持久记录是提交点；公开通知只携带客户端需要的稳定身份，不暴露实时 Session 对象。
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent-preset/selected') return
      ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
    })
  }

  /**
   * The preset id mounted when a caller names none.
   *
   * Read per call rather than cached: the settings document is hot-reloaded, so
   * changing the default takes effect on the next session created and leaves
   * every running session on the preset it was composed from.
   */
  get defaultId(): string {
    return this.settings?.get().default ?? this.config.default
  }

  /**
   * Every preset the configured roots currently supply.
   * @returns the presets, first-root-wins per id.
   */
  async list(): Promise<AgentPreset[]> {
    return await discoverPresets(this.resolvedRoots)
  }

  /**
   * Resolve one preset by id.
   *
   * A broken preset resolves — deleting one, reading one, and reporting one
   * all need the row — and the mounting paths refuse it AFTER resolution
   * through {@link resolveMountable}.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved preset.
   * @throws when no configured root supplies that id.
   */
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    const presets = await this.list()
    const found = presets.find(preset => preset.id === wanted)
    if (found === undefined) {
      throw new UnknownPresetError(wanted, presets.map(preset => preset.id))
    }
    return found
  }

  /**
   * Resolve one preset that is about to compose an agent, refusing a broken
   * one with its discovery-reported reason. Failing here rather than inside
   * the loader keeps the answer the same for every unloadable shape — ghost
   * directory, unparsable YAML, rowless list — and spends no mount attempt
   * on a composition discovery already read as unusable.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved, mountable preset.
   * @throws when the preset is unknown or discovery reports it broken.
   */
  private async resolveMountable(id?: string): Promise<AgentPreset> {
    const preset = await this.resolve(id)
    if (preset.broken !== undefined) {
      throw new PresetMountError(preset.id, preset.broken)
    }
    return preset
  }

  /**
   * Standing mounts by preset id, single-flight so two agents racing the
   * first use of one preset share one composition. A settled failure is
   * removed so a later session retries a preset whose file has been fixed; a
   * settled success serves until the composition FILE visibly changes — each
   * generation records its file stamp, and a stale stamp starts the next
   * generation for sessions created afterwards. Sessions already joined keep
   * the generation they run on; a superseded one is never disposed while the
   * process lives (reclaimed only by whole-tree teardown), so editing files
   * is bounded by how often compositions change, not by session count.
   */
  private readonly standing = new Map<string, Promise<StandingMount>>()

  /**
   * Parent bindings of the agents this roster composed, keyed by the agent's
   * scope key. The binding is dsh-scope's only re-link capability; holding it
   * here makes this service the sole authority that can move an agent between
   * standing compositions. WeakMap: entries die with their agents.
   */
  private readonly bindings = new WeakMap<ScopeKey, ScopeParentBinding>()

  /**
   * 使用 Preset 组合一个 Agent：先确保常驻挂载存在，再把 Agent Scope Key 接到该挂载下，
   * 使挂载的注册和监听器覆盖该 Agent。必须从 AgentFactory 的 `setup(agentCtx)` 调用；这里
   * 失败会回滚 Agent 创建，因此损坏的 Preset 不会产生只组合了一半的 Session。
   * @param agentCtx - Agent 的 Scope Context。
   * @param id - Preset id；`undefined` 表示使用 {@link defaultId}。
   * @returns 实际组合的 Preset，供调用方记录。
   * @throws Preset 不存在或组合不可用。
   */
  async mount(agentCtx: Context, id?: string): Promise<AgentPreset> {
    // mount 必须在 AgentFactory 的 unpublished setup 阶段调用。Preset 解析或装载失败时，
    // Agent 创建整体回滚，外部不会看到一个只装好部分工具或 Prompt 的 Agent。
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const preset = await this.resolveMountable(id)
    const standing = await this.ensureStanding(preset)
    // 这是 Agent 父级关系的唯一绑定。binding 是唯一允许重新连接的凭证，保存在本服务内部，
    // 因此外部代码不能把已完成组合的 Agent 移到其他 Preset；后续 recompose 也只能在调用方
    // 持有空 Session 的前提下，通过它重新连接。
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    return preset
  }

  /**
   * Join one agent to the SAME standing composition another already runs on.
   *
   * This is how a child agent inherits its parent's capabilities. It is a bind,
   * not a mount: the parent's generation is already composed, so the child gets
   * that exact instance — the same plugin objects, the same tool registrations,
   * the same prompt sections. Re-resolving the parent's preset by id instead
   * would re-read the roster, and a composition file edited since the parent
   * started would hand the child a DIFFERENT generation than the one its
   * parent's history was produced under (and a preset deleted since would fail
   * the child outright while its parent keeps running).
   *
   * Synchronous, and with no composition failure mode of its own — it reads no
   * roster, mounts nothing, and touches no file — which is what lets a child
   * creation window use it: the two in-process subagent drivers compose their
   * children inside a synchronous `setup`. It still rejects a caller error, as
   * the `@throws` below record.
   *
   * A parent that joined no preset — a rosterless deployment — yields no join
   * and no error: there, the model-facing rows sit in the host composition and
   * the child already sees them through the global layer.
   * @param agentCtx - the joining agent's scope context.
   * @param parentCtx - the scope context of the agent whose composition to join.
   * @returns the preset id joined, or undefined when the parent joined none.
   * @throws when `agentCtx` carries no scope, or has already joined a preset.
   */
  composeFrom(agentCtx: Context, parentCtx: Context): string | undefined {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const standing = standingMountFor(parentCtx)
    if (standing === undefined) return undefined
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    return standing.presetId
  }

  /**
   * The preset one live agent runs on.
   *
   * Read from the live scope chain rather than from the session, so it answers
   * for an agent whose session has not recorded a preset yet — a child agent
   * whose durable header is being built from its parent's composition.
   * @param agentCtx - the agent's scope context.
   * @returns the preset id, or undefined when the agent joined none.
   */
  composedPreset(agentCtx: Context): string | undefined {
    return standingMountFor(agentCtx)?.presetId
  }

  /**
   * The roots this roster scans, which is not `config.roots`: it is every
   * configured root in order, then the harness-home user root unless
   * `includeUserRoot` is false. Read this — not the config field — to answer
   * whether a roster is composed at all, so one derivation decides it.
   */
  get roots(): readonly PresetRoot[] {
    return this.resolvedRoots
  }

  /** Whether this deployment has a root locally authored presets go to. */
  get authorable(): boolean {
    return this.resolvedRoots.some(root => root.trust === 'user')
  }

  /**
   * Read one preset's composition text.
   * @param id - the preset id.
   * @returns the composition exactly as stored.
   * @throws when no configured root supplies that id.
   */
  async read(id: string): Promise<string> {
    return await readComposition(await this.resolve(id))
  }

  /**
   * Create a locally authored preset by copying an existing one whole.
   *
   * Copy is the only authoring write. Composition text never crosses this
   * seam: the source is named by id and its directory is copied as it stands,
   * so the copy is exactly as loadable as its source and authoring grants no
   * capability the roster did not already carry. The copy is NOT mounted to
   * validate — a source that mounts today yields a copy that mounts today.
   * @param from - the preset the copy starts from; shipped presets are the
   * primary source, so any trust is accepted.
   * @param id - the new preset's id, which becomes its directory name.
   * @param name - display name for the copy; absent falls back to the id.
   * @throws when the source is unknown, the id is unusable or already taken,
   * or the deployment configures no writable root.
   */
  async copy(from: string, id: string, name?: string): Promise<void> {
    const source = await this.resolve(from)
    // 预设清单检查会拒绝任意根目录已经提供的 id，包括内置 Preset；因为同名用户目录会被
    // 内置项遮蔽。copyComposition 内部的磁盘检查则只检查可写根目录。
    if ((await this.list()).some(preset => preset.id === id)) {
      throw new PresetExistsError(id)
    }
    await copyComposition(this.resolvedRoots, source, id, name)
    // 若该 id 仍有已完成挂载，只可能是外部绕过 remove 删除文件后留下的旧状态；新 Preset
    // 不能继承它。已经加入的 Session 仍继续使用自己当前运行的组合代。
    this.standing.delete(id)
  }

  /**
   * Delete a locally authored preset.
   * @param id - the preset id.
   * @throws when the preset is unknown or ships with the deployment.
   */
  async remove(id: string): Promise<void> {
    await deleteComposition(this.resolvedRoots, await this.resolve(id))
    // 已使用被删除 Preset 的 Session 保留常驻挂载；只有新 Session 会看到删除后的清单。
    this.standing.delete(id)
    // 允许保存当前尚不存在的默认项是刻意设计：清单来自实时目录，Session 真正请求时该名称
    // 可能已经出现，resolve 会在那时判断。但本次调用刚删除的默认项不同，它已确定不会再由
    // 当前来源提供；若继续保留，所有未显式选择 Preset 的新 Session 都会启动失败。清除后
    // 会露出下层部署默认值，这正是设置分层语义。
    if (this.settings?.get().default !== id) return
    await this.settingsService?.mutate(
      settingsNamespace(SETTINGS_NAMESPACE),
      [{ op: 'unset', path: ['default'] }],
    )
  }

  /**
   * One agent's instance of a service its preset mounted.
   *
   * A preset publishes services behind `isolate` realms, which are invisible
   * outside the group that declares them — including to the host. This is how a
   * caller holding the agent reads one anyway: a request that is ABOUT a
   * session but arrives from outside it, which is every browser RPC.
   *
   * Read addressing only. A host row that `inject`s a service cannot use this,
   * because injection resolves before any session exists and has no agent to
   * key by; such a service belongs on the host plane instead.
   * @param agent - the agent whose composition to look inside.
   * @param name - the service name as the preset's rows resolve it.
   * @returns the agent's instance, or undefined when its preset mounts none.
   */
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    return serviceForAgent(this.ctx, agent, name)
  }

  /**
   * Re-link one agent to a different preset's standing composition.
   *
   * Only valid while the agent has produced nothing: swapping tools mid
   * conversation would leave logged tool calls the new composition cannot
   * make. The CALLER owns that check — this method does not read session
   * history.
   *
   * The swap is a parent re-link, not an unmount: standing mounts are shared
   * and permanent, so the old composition stays for its other agents and the
   * new one is ensured BEFORE the link moves. An unknown or unusable preset
   * therefore throws with the agent exactly as it was — there is no torn-down
   * state to restore. The re-link runs through the binding this roster kept
   * from the agent's mount — dsh-scope's only re-link authority. An agent
   * that never composed one has nothing to re-link: the switch is then the
   * agent's first bind, exactly a mount.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset to compose the agent from instead.
   * @returns the preset now installed.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async recompose(agentCtx: Context, id: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to recompose an unscoped context')
    }
    const preset = await this.resolveMountable(id)
    const standing = await this.ensureStanding(preset)
    const binding = this.bindings.get(agentKey)
    if (binding === undefined) {
      this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    } else {
      binding.rebind(standing.key)
    }
    return preset
  }

  /**
   * The standing scope key of one preset, for a host reader with no agent.
   *
   * A cold transcript read resolves tool presenters against the composition
   * the session recorded, and the standing mount makes that possible without
   * resuming anything: ensuring the mount composes plugins but starts no
   * agent, no session, and no turn.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the standing scope key readers pass as a registry view scope.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async standingKeyFor(id?: string): Promise<ScopeKey> {
    const preset = await this.resolveMountable(id)
    return (await this.ensureStanding(preset)).key
  }

  /** 解析 Preset 的常驻挂载；不存在时以单次并发共享方式创建。 */
  private async ensureStanding(preset: AgentPreset): Promise<StandingMount> {
    // 同一 Preset 的首次并发请求共享一个 Promise，保证只挂载一份。文件发生变化后，新建
    // Agent 使用下一代 composition；已经运行的 Agent 继续绑定原来的稳定版本。
    const pending = this.standing.get(preset.id)
    if (pending !== undefined) {
      const mounted = await pending
      // 文件是组合配置的唯一编辑来源，因此通过文件标记识别变化。文件变化后，本次及后续
      // Session 在这里启动新一代组合；若暂时无法读取标记，则继续使用当前代，因为已经
      // 挂载的组合不能仅因源文件消失或一次 stat 失败而停止服务。
      const current = await compositionStamp(preset.path)
      if (current === undefined || sameStamp(mounted.stamp, current)) return mounted
      // TODO：最后一个仍使用旧版本的 Agent 退出后，应回收被替代的组合代。该子树并非
      // 静止对象，dsh-skill-filesystem 仍在监听根目录，设置页也会把每次保存转成组合变化。
      // 需要在 StandingMount 上记录已连接 Agent 数，并在 mount/composeFrom/recompose 与
      // Agent Scope 销毁时分别增减。删除指针前必须确认没有并发调用方已经创建下一代，
      // 否则会误删新指针并分裂出第三代。
      if (this.standing.get(preset.id) === pending) this.standing.delete(preset.id)
      return this.ensureStanding(preset)
    }
    const created = (async (): Promise<StandingMount> => {
      const key: ScopeKey = { agentPreset: preset.id }
      const scope = createScope(this.selfCtx, key)
      try {
        // 在读取文件前取得标记：如果挂载期间发生编辑，该标记会明确变旧，下一次 Session
        // 就会刷新组合，而不会把比标记更旧的内容误认为当前版本。
        const stamp = await compositionStamp(preset.path)
        if (stamp === undefined) {
          throw new PresetMountError(preset.id, `composition file is unreadable: ${preset.path}`)
        }
        await mountPreset(scope.ctx, preset)
        return { key, scope, stamp }
      } catch (error) {
        this.standing.delete(preset.id)
        await scope.dispose()
        throw error
      }
    })()
    this.standing.set(preset.id, created)
    return created
  }
}

/** The composition file identity one standing generation was mounted from. */
interface CompositionStamp {
  /** Modification time in milliseconds, as `stat` reports it. */
  readonly mtimeMs: number
  /** File size in bytes, the tiebreak for edits within one mtime tick. */
  readonly size: number
}

/** Read one composition file's stamp, or undefined when it cannot be statted. */
async function compositionStamp(path: string): Promise<CompositionStamp | undefined> {
  try {
    const { mtimeMs, size } = await stat(path)
    return { mtimeMs, size }
  } catch {
    // 文件被删除、被不可读条目替换或其他无法 stat 的情况，对调用方含义相同：没有可比较
    // 的文件身份。
    return undefined
  }
}

/** Whether two stamps name the same file state. */
function sameStamp(a: CompositionStamp, b: CompositionStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** One preset's standing composition. */
interface StandingMount {
  /** Scope key agents are parented to; also the mount's registration scope. */
  readonly key: ScopeKey
  /** Disposal boundary; held for whole-tree teardown, never per-session. */
  readonly scope: Scope
  /** Stamp of the composition file this generation was mounted from. */
  readonly stamp: CompositionStamp
}

export default AgentPresets
