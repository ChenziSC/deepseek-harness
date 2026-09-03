/**
 * 所有 `dsh` 交互界面共用的 Profile 启动器：解析 Profile，依次叠加
 * `dsh.profile.bundles` 中的 Bundle、Profile 自身的 `cordis.patch.yml`、
 * `--patch` Overlay 与遥测开关，再把插件树挂载到 Profile 的空根配置上。
 * 它还负责保持用户 Patch 热更新、明确报告启动失败以及执行有时限的关闭。
 *
 * 应用参数不由启动器解释。调用参数通过 `ctx.cmdlineArgs` 交给插件树，所有注入该
 * Service 的应用插件读取同一份不可变快照。
 * @module @deepseek-ai/dsh/profile-boot
 */

// 学习入口：把本文件按“解析 profile → 组合 patch 层 → boot 插件树 → 安装 HMR 与
// 进程关闭”四个区块阅读。这里决定装载哪些能力，但不实现这些能力；组合后的每一行
// 都应继续追到对应 Cordis 插件，而不是把行为归因给启动器。

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  watchUserPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Load a resolved profile for `name`: heal the shared module fallback, then
 * (re)write the empty root config. The root is always rewritten: the whole
 * composition is patch layers, and the vendored Loader's tree write-back (a
 * plugin self-disposing persists the current tree) can bake composed rows
 * into this file — which would duplicate every bundle insert on the next
 * boot. The file exists on disk only because the Loader needs a real include
 * root to anchor `baseUrl` at the profile directory (the config dump anchors
 * on the same file, so both compose over the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers (application order) and the row index of its pre-flag composition. */
interface ComposedProfile {
  profile: Profile
  /** Bundle layers concatenated — the part below the user layers on a live reload. */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$DSH_HOME/cordis.patch.yml`), applied after the profile's own. */
  homePatches: PatchOptions[]
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch. */
  overlays: PatchOptions[]
  /**
   * id → row of the composed tree (bundles + user layers + overlays), for the
   * launcher's own row checks.
   */
  rows: ReadonlyMap<string, EntryOptions>
}

/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ]
}

/**
 * 加载 `name` 对应的 Profile，并组合它最终生效的 Patch 栈。顺序依次为
 * `dsh.profile.bundles` 中的 Bundle 层、Profile 用户层、作用于所有 Profile 且优先级
 * 更高的 `$DSH_HOME/cordis.patch.yml`、按命令行顺序排列的 `--patch` Overlay，最后是
 * 遥测开关。基础 Bundle 会在自己的配置行中按平台选择 Shell 栈。
 * @param name - Profile 名称。
 * @param patchFiles - 按 argv 顺序排列的 `--patch` Overlay 路径。
 * @returns Profile、各层 Patch，以及组合后按 id 建立的配置行索引。
 */
function composeProfile(
  name: string,
  patchFiles: readonly string[],
): ComposedProfile {
  // 学习说明：Profile 自身不直接保存完整插件清单；相同 id 的后层配置覆盖前层整份 config。
  const profile = prepareProfile(name)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const composedOverlays = [...overlays]
  // SHIPPED 根目录是预设清单中只有当前应用才能定位的部分：无论源码布局还是构建产物，
  // 它都位于应用自身配置旁边。预设清单另行追加的可写根目录归 dsh-agent-presets 所有，
  // 因此即使某个启动器没有应用这层 Patch，也仍能找到用户自己的 Preset。
  if (rows.has('agent-presets')) {
    composedOverlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  return { profile, bundlePatches, homePatches, overlays: composedOverlays, rows }
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/**
 * 完整启动一次 Profile，并把后续进程生命周期交给已经挂载的插件，或者配置中挂载的
 * 一次性 Runner。
 * @param options - 环境快照、Profile 名称、Overlay，以及启动后应用自身的参数。
 * @returns 已稳定的根 Context 与关闭控制器。
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  // 组合阶段只回答“本次进程挂载哪些插件”；真正的依赖解析、激活和失败审计交给 boot。
  // 这种分工使 dump-config 与实际启动可以复用同一套 Patch 计算规则。
  const composed = composeProfile(options.profile, options.patchFiles)
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // 信号在整个启动阶段都负责触发清理，而不是等 boot() 完成后才接管：某个 Provider
  // 可能在相邻配置行挂载完成前就已经对外发布。SIGTERM 是进程管理器的正常停止请求，
  // 所有交互界面都以 0 退出；SIGINT 是用户中断，以 130 退出。
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // 重新组合运行中的用户层：Bundle 在下、Overlay 在上，用户编辑不会挤掉 Overlay。解析后的
  // 应用参数不在这棵树里，而是保存在重组期间仍然存活的应用 Service 中。每一代都会重新
  // 读取两份用户文件；HMR 只传来变化文件的 Patch，其中一次读取会重复它，但重新读取能
  // 避免两个 watcher 把对方的旧副本拼进新配置。
  // 每一代都使用新克隆：Include 会按引用把 insert 行推入挂载树，后续按 id 定位的 Patch
  // 会原地修改这些对象。若多次应用复用同一份解析对象，用户覆盖就会写进 Bundle 的内存
  // 行，删除覆盖后也无法恢复 Bundle 默认值。
  const composeLive = (): PatchOptions[] => structuredClone([
    ...composed.bundlePatches,
    ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
    ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
    ...composed.overlays,
  ])
  // 与 composeLive 相同，为避免 insert 引用共享而克隆；启动过程不能修改后续热更新重组
  // 所依赖的原始对象。
  const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx) => {
    app.current = hostCtx
    // 在配置树任何条目挂载前提供环境快照，使所有插件都从同一份不可变来源解析启动环境。
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
    // 命令行参数和受控退出请求属于启动器信息，所有注入参数快照的应用插件都可读取。
    provideCmdline(hostCtx, {
      args: options.args,
      exit: code => void shutdown.shutdown(code),
    })
  })
  app.current = ctx
  // boot 或启动后的 watcher 尚在设置时，信号或快速一次性任务的 appExit 就可能释放整棵树。
  // Loader 是否存在以及 Fiber 状态共同表示树是否存活：首次检查跳过已经退出的树，catch
  // 再检查设置过程中发生的退出。watcher 无条件安装；一次性任务会通过受控关闭退出，
  // 在事件循环排空前释放 watcher。
  if (!signalShutdown.signal.aborted
    && ctx.fiber.state === FiberState.ACTIVE
    && ctx.get('loader') !== undefined) {
    try {
      // 为运行中的 Profile Patch 层提供仅配置 HMR。Web Bundle 会禁用共享的模块重载 hmr 行，
      // 因为其重载生命周期尚未验证；若组合后没有 HMR Service，就挂载一个不含模块根目录、
      // 只负责监听的实例，使所有长期运行界面上的 cordis.patch.yml 编辑都能生效。静默跳过
      // 会破坏公开的热更新约定。HMR 还依赖 timer，而精简的自定义 Profile 也可能未挂载它。
      if (ctx.get('hmr') === undefined) {
        if (ctx.get('timer') === undefined) {
          await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
        }
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
      }
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: composed.profile.patchPath,
        compose: composeLive,
      })
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: homePatchPath(),
        compose: composeLive,
      })
    } catch (error) {
      suppressShutdownError(ctx, signalShutdown.signal, error)
    }
  }
  return { ctx, shutdown }
}
