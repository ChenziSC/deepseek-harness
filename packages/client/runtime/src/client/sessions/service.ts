/**
 * SessionRuntime 是根 sessions 服务：包含列表快照 store（manager 投影，其中 `current`
 * 是所有 session scope 界面共同依据的持久选择）、Agent scope 树（mintScope 模式：
 * 无操作插件 Fiber + ctx.extend scope 标签；每 session 一个 scope，Agent ID 等于
 * session ID）、稳定 SessionBinding 缓存和面包屑路由投影。
 *
 * Scope 生命周期由 stage 驱动：首次解析时延迟创建 scope；解析是纯操作、无副作用，
 * 可安全用于渲染。事件窗口和延迟拆除都以 staged session 为键，后者严格跟随
 * `list.current`。进入 stage 就是打开信号：session 在 stage 上当且仅当窗口打开。
 * 当前 stage 就是 `current`，以后可扩展为多面板列表。Session 离开列表时立即拆除
 * scope；若它仍在 stage 上，则保留冻结只读视图，直到 stage 移开。
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {
  IApiClient, RpcError, RpcResult, SessionId, SubagentAddress, JobView, WorkspaceId,
} from '@deepseek-ai/dsh-api-remotes/client'
// 值从可安全内联的传输层导入，而不是 connection 插件；插件间值导入会违反 bundle
// 纯度要求。
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  HostObservable, SessionMaybeProvideInfo, SessionProvideInfo,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { SessionFace } from '../contract/session.ts'
import type { AgentContext, ISessions } from '../contract/sessions.ts'
import { createScope, scopeOf as scopeTagOf } from '../agents/scope.ts'
import type { ConversationRuntime } from './conversation-assembler.ts'
import { SessionManager } from './manager.ts'
import type { SessionRemotes } from './remotes.ts'
import type { SessionListPhase, SessionSearchResultItem, SubagentCatalogSnapshot } from './manager.ts'
import type { PendingInteractionStatus } from './pending.ts'
import { SessionProvideChannel } from './provide.ts'
import type { Session } from './session.ts'

/** 根据 Host 列表 RPC 和实时流增量投影出的 session 列表行。 */
export interface SessionSummary {
  id: SessionId
  /** 由持久日志支撑的最新标题；Host 尚未投影时不存在。 */
  title?: string
  /** 面向人的标签，依次回退为持久标题、项目 basename、session ID。 */
  displayTitle: string
  cwd?: string
  /**
   * 组装本 session Agent 时使用的 Agent preset；部署未组装 preset 时不存在。Session
   * 标题展示其实际运行配置，而不是部署当前默认值。
   */
  agentPreset?: string
  parentId?: SessionId
  /** 供导航筛选的粗粒度持久来源；不表示 continuation 能力。 */
  origin?: 'subagent'
  running: boolean
  /** 当前阻塞本 session 的用户交互，对应侧边栏琥珀色圆点。 */
  pendingInteraction?: PendingInteractionStatus
  /** 未选中且尚未打开时完成，对应侧边栏绿色“完成”提醒；缺失等同 false。 */
  completed?: boolean
  /**
   * 空日志标记，是 Host 摘要推导值的镜像。New Session 会复用指向同一 workspace 的
   * 空白 session。筛选由消费者负责：store 保留所有行，Workspace 浏览器只显示已选中
   * 的空白条目。
   */
  blank: boolean
  updatedAt: number
  /** 对象层保留的 Host 当前计算投影值。 */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/**
 * Session 列表 store 结构。`current` 与列表位于同一快照中；唯一 useSessions 标准
 * hook 会同时读取列表和选择，因此侧边栏高亮与 SessionProvider 共用一个事实来源。
 */
export interface SessionListState {
  /** Host 列表顺序；不包含只用于面包屑寻址的行。 */
  ids: SessionId[]
  /** Host 行以及导航所用的当前已寻址 subagent 路由。 */
  byId: Record<SessionId, SessionSummary>
  current: SessionId | undefined
  /** 与 manager 快照一一对应的到达生命周期；见 SessionListPhase。ready 且空表示确实没有 sessions。 */
  phase: SessionListPhase
  /** 以所选父地址为键的直接持久目录。 */
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  /**
   * 每个 session 可见的后台 jobs，按 last-wins 从 `session/jobs` 镜像。键缺失表示空集；
   * Host 不会为无任务 session 发送基线，因此消费者读取缺失而非哨兵值。
   */
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
  /** 当前 session 从目录得出的地址；普通导航时不存在。 */
  currentAddress: SubagentAddress | undefined
}

/** 持久导航 cell：刷新后仍保留地址，以正确路由历史。 */
interface SessionSelection {
  sessionId?: SessionId
  subagentAddress?: SubagentAddress
}

/** 结构化 session 创建失败。 */
export class SessionCreateError extends Error {
  override readonly name = 'SessionCreateError'

  /**
   * @param rpcError - Host 业务错误或折叠后的传输错误。
   * @param requestedSessionId - 调用方预分配 ID，用于后续流/列表协调。
   */
  constructor(
    readonly rpcError: RpcError,
    readonly requestedSessionId: SessionId | undefined,
  ) {
    super(`session create failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** 结构化 session fork 失败。 */
export class SessionForkError extends Error {
  override readonly name = 'SessionForkError'

  /**
   * @param rpcError - Host 业务错误或折叠后的传输错误。
   * @param sourceSessionId - fork 的源 session。
   */
  constructor(
    readonly rpcError: RpcError,
    readonly sourceSessionId: SessionId,
  ) {
    super(`session fork failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** 供 SessionProvider/inject factory 使用的 session 组装 handle；每 session 身份稳定。 */
export interface SessionBinding {
  readonly sessionId: SessionId
  /** 只提供 session 对外接口；功能代码不会接触具体类。 */
  readonly session: SessionFace
  readonly ctx: AgentContext
}

// Scope 基元位于 ../agents/scope.ts，是以 Agent 身份为键的 Host dsh-scope 客户端镜像；
// 这里重新导出，使现有消费者无需更改导入位置。
export { scopeOf } from '../agents/scope.ts'

/**
 * 根据 session cwd 得出 Workspace 显示标题：取路径最后一个非空段，接受两种分隔符并
 * 忽略末尾分隔符；只有分隔符时返回 ''。调用方负责回退到 session ID、原始 cwd 或
 * 默认目录文案。这是仓库唯一 basename 推导方法；所有命名 workspace 的界面都调用
 * 它，不再自行切分路径。
 * @param cwd - workspace 目录路径。
 * @returns basename 标题；没有非空段时返回 ''。
 */
export function workspaceTitleOf(cwd: string): string {
  return cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
}

/**
 * 显示标题投影：依次使用持久标题、项目目录 basename、原始 ID。
 */
function displayTitleOf(title: string | undefined, cwd: string | undefined, id: SessionId): string {
  if (title !== undefined) return title
  if (cwd !== undefined && cwd !== '') {
    const base = workspaceTitleOf(cwd)
    if (base !== '') return base
  }
  return id
}

/**
 * 递增末尾 fork 编号，同时保留半角或全角括号；没有编号的标题追加 ` (1)`。
 * @param title - 源 session 的持久标题。
 * @returns 分配给 fork 子项的标题。
 */
function increasedForkTitle(title: string): string {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  return `${title} (1)`
}

interface ScopeRecord {
  fiber: Fiber
  ctx: AgentContext
  binding: SessionBinding
  /** The concrete Session for runtime-internal entry points (staging open()); the binding carries only the outward face. */
  session: Session
  /** Render-layer standard-props bundle (identity-stable per scope; the renderer's per-info caches key off it). */
  provideInfo: SessionProvideInfo
}

/** One plugin's per-session standard-props contribution (see {@link SessionRuntime.provide}). */
export interface SessionProvideContribution {
  /** Bare observable sources, keyed by hook base name ('input' → useInput). */
  hooks?: Record<string, HostObservable<unknown>>
  /** Stable plain members (action callbacks etc.), spread into standard props verbatim. */
  props?: Record<string, unknown>
}

/**
 * Static declaration plus per-session resolver for one standard-kit
 * contribution. The declared names let the renderer construct the same hook
 * and prop surface while no session is current.
 */
export interface SessionProvideDescriptor {
  /** Hook base names (`input` becomes `useInput`). */
  hooks?: readonly string[]
  /** Plain standard-prop names. */
  props?: readonly string[]
  /** Resolve every declared member for one definite session. */
  resolve(binding: SessionBinding): SessionProvideContribution
}

/** Root sessions service: list store, current selection, object-layer manager, scope tree, bindings, and breadcrumb routes. */
export class SessionRuntime implements ISessions {
  /**
   * The wire schema's own result bound, re-exposed for presentation plugins as
   * injected data. Not per-connection state: the `session.search` response
   * schema caps `items` at this constant, so every transport (fixture included)
   * reports the same number.
   */
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT
  /** List snapshot store (list RPC + host stream increments; re-pulled on reconnect) — the useSessions standard feed, current included. */
  readonly list: SnapshotStore<SessionListState>
  /** The object-layer instance cluster and frame dispatch entry. */
  private readonly manager: SessionManager
  /**
   * Atomic current-session provide projection: selection changes and
   * provider-roster changes publish through this one source (the renderer
   * host's `sessions.provide` feed), so a roster change under a stable
   * current id republishes the bundle instead of stranding mounted entries.
   */
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>

  /**
   * Persisted selection cell (the durable half of `list.current`). Private on
   * purpose: reads go through the list snapshot; writes through {@link
   * SessionRuntime.open} / {@link SessionRuntime.clear}. Projection
   * validates it against the live list instead of destructively pruning, so a
   * selection survives transient list states (reconnect re-pull) and
   * resurfaces when its session returns.
   */
  private readonly selection: SnapshotStore<SessionSelection>

  private readonly scopes = new Map<SessionId, ScopeRecord>()
  /** The provide channel (roster, materialization rules, current projection) — shared with the test runtime's double. */
  private readonly provideChannel: SessionProvideChannel
  /**
   * The staged session id — follows `list.current` exactly, holding its last
   * defined value across masked gaps (a transiently absent selection blanks
   * `current` without moving the stage, so reconnect re-pulls and removals
   * keep the staged scope's frozen view alive until the stage moves on).
   */
  private watched: SessionId | undefined
  /** Removed-while-staged sessions whose teardown waits for the stage to move away. */
  private readonly deferredRemovals = new Set<SessionId>()

  /**
   * @param ctx - client root context (scope fibers mount under it).
   * @param api - wire client shared with every Session.
   * @param remote - generated Remote namespaces shared with every Session.
   * @param conversationRuntime - same-pass registry instances, when runtime apply owns them.
   */
  constructor(
    private readonly rootCtx: Context,
    api: IApiClient,
    remote: SessionRemotes,
    conversationRuntime?: ConversationRuntime,
  ) {
    this.selection = createSnapshotStore<SessionSelection>(
      {},
      { persist: { name: 'dsh.sessions.current' } })
    const restored = this.selection.getSnapshot()
    const conversationEvents = rootCtx.get('conversationEvents')
    const conversationViews = rootCtx.get('conversationViews')
    const conversation = conversationRuntime ?? (
      conversationEvents === undefined || conversationViews === undefined
        ? undefined
        : { events: conversationEvents, views: conversationViews }
    )
    this.manager = new SessionManager(
      api,
      remote,
      restored.sessionId,
      restored.subagentAddress,
      conversation,
    )
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, current: undefined, phase: 'pending',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
    // The manager owns wire truth; the store is its projection. Manager
    // notifications are already microtask-batched.
    this.manager.subscribe(() => { this.projectList() })
    // Stage follower: every current write (open() and projection alike)
    // re-evaluates staging, so startup restore (persisted selection validated
    // by the projection) and reconnect resurfacing open their window with no
    // dedicated code path. Safe to run synchronously inside the store notify:
    // the follower writes no list state — session.open()'s synchronous prefix
    // touches only session-side state and its own microtask-batched notifier.
    // The current-provide projection follows the same current writes.
    this.list.subscribe(() => {
      this.followCurrent()
      this.provideChannel.publishCurrent()
    })
    this.provideChannel = new SessionProvideChannel({
      rebuildBundles: () => {
        for (const record of this.scopes.values()) {
          record.provideInfo = this.provideChannel.materializeInfo(record.binding)
        }
      },
      resolveCurrent: () => this.maybeProvideInfo(this.list.getSnapshot().current),
    })
    this.currentProvideInfo = this.provideChannel.currentProvideInfo
    let registryRebuildQueued = false
    const scheduleRegistryRebuild = (): void => {
      if (registryRebuildQueued) return
      registryRebuildQueued = true
      queueMicrotask(() => {
        registryRebuildQueued = false
        this.manager.rebuildConversationRegistry()
      })
    }
    if (conversation !== undefined) {
      rootCtx.effect(() => {
        const disposeEvents = conversation.events.subscribe(scheduleRegistryRebuild)
        const disposeViews = conversation.views.subscribe(scheduleRegistryRebuild)
        return () => {
          disposeEvents()
          disposeViews()
        }
      }, 'sessions: conversation registry rebuild')
    }
    rootCtx.reflect.provide('sessions', this, undefined)
  }

  /**
   * Register a per-session standard-props provider: every session-scope slot
   * component receives the contributed members as standard props (`hooks`
   * sources become `use<Name>` selector hooks on the render side; `props`
   * spread verbatim). Contributions materialize lazily with the session's
   * scope record and die with it. Registration order is resolution order;
   * duplicate member names fail loud at materialization.
   * @param descriptor - static member roster plus per-session resolver.
   * @returns disposer removing the provider (already-materialized bundles keep their members until their scope drops).
   */
  provide(descriptor: SessionProvideDescriptor): () => void {
    // Scopes may already exist (boot order: the list lands and resolves
    // scopes before later plugins register) — the channel rebuilds their
    // bundles through the host hooks so every provider lands by first render.
    return this.provideChannel.provide(descriptor)
  }

  /**
   * Select a listed or retained catalog-addressed session as current.
   * @param id - listed or addressed session id.
   */
  open(id: SessionId): void {
    this.manager.select(id)
  }

  /**
   * Open a healthy catalog child through its direct-parent address.
   * @param address - catalog-derived parent and child ids.
   */
  openSubagent(address: SubagentAddress): void {
    this.manager.selectSubagent(address)
  }

  /**
   * Resolve an already discovered direct-parent address without opening it.
   * Feature plugins use this to avoid Agent-bound RPCs in persisted child views.
   * @param id - possible addressed child id.
   * @returns The retained address, when present.
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined {
    return this.manager.subagentAddress(id)
  }

  /**
   * Inform the runtime whether a catalog menu is consuming membership updates.
   * @param parentSessionId - selected parent.
   * @param open - menu state.
   */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void {
    this.manager.setSubagentCatalogOpen(parentSessionId, open)
  }

  /**
   * Refresh one direct-child catalog.
   * @param parentSessionId - catalog owner.
   */
  refreshSubagents(parentSessionId: SessionId): Promise<void> {
    return this.manager.refreshSubagents(parentSessionId)
  }

  noteAgentPreset(sessionId: SessionId, agentPreset: string): void {
    this.manager.noteAgentPreset(sessionId, agentPreset)
  }

  /**
   * Clear the current selection so the layout shows the no-session empty
   * state (new-session affordance and the workspace preselection flow).
   * Wipes the persisted selection too — a reload stays on empty until the
   * user opens or starts a session. The staged scope keeps its frozen view
   * per the masked-gap contract until the next open() moves the stage.
   */
  clear(): void {
    this.manager.clearSelection()
  }

  /**
   * Refresh the real Session baseline, reusing an in-flight pull.
   * @returns completion of the current or newly started baseline pull.
   */
  refresh(): Promise<void> {
    return this.manager.refreshList()
  }

  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results or a business/transport error.
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    return this.manager.search(query, signal)
  }

  /**
   * Route a mux stream envelope into the Session object layer.
   * @param envelope - validated mux stream envelope.
   */
  handleMuxEnvelope(envelope: Parameters<SessionManager['handleMuxEnvelope']>[0]): void {
    this.manager.handleMuxEnvelope(envelope)
  }

  /**
   * Route a Host stream envelope into the Session object layer.
   * @param envelope - validated Host stream envelope.
   */
  handleHostEnvelope(envelope: Parameters<SessionManager['handleHostEnvelope']>[0]): void {
    this.manager.handleHostEnvelope(envelope)
  }

  /** Rebuild the Session baseline and every opened window after connection. */
  handleConnected(): void {
    this.manager.handleConnected()
  }

  /** Drop generation-scoped live interaction state the moment a connection generation dies. */
  handleDisconnected(): void {
    this.manager.handleDisconnected()
  }

  /**
   * Create a session on the host. Resolution guarantee: by the time the
   * promise resolves, the created session is in the list store and
   * {@link SessionRuntime.binding} resolves it — callers (New Session
   * draft hand-off) may address the scope synchronously, without waiting a
   * notifier flush. The synchronous projection below makes this structural
   * rather than an accident of microtask ordering.
   * @param opts - target workspace or directory and an optional preallocated id.
   * @returns the new session id.
   * @throws {SessionCreateError} with the requested id.
   */
  async create(opts: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId } = {}): Promise<SessionId> {
    const result = await this.manager.create(opts)
    if (!result.ok) throw new SessionCreateError(result.error, opts.sessionId)
    this.projectList()
    return result.value.sessionId
  }

  /**
   * Fork a session from a completed-turn prefix of the source (same
   * synchronous-addressability guarantee as {@link SessionRuntime.create}:
   * on resolution the child is in the list store and open() can target it).
   * @param opts - source session id, the optional event seq anchoring the
   *   cut (the boundary is the first turn/end at or after it; an in-log
   *   anchor in an open turn is unavailable rather than clipped backward),
   *   and whether to increment an inherited durable title before resolving.
   *   A fractional anchor floors to a real event seq: the frozen nodes of an
   *   interrupted turn carry flow-ordering seqs between two events, and the
   *   wire takes integers only.
   * @returns the child session id.
   * @throws {SessionForkError} with the source id.
   * @throws {Error} when a requested child-title rename fails after creation.
   */
  async fork(opts: {
    sessionId: SessionId
    atSeq?: number
    increaseTitle?: boolean
  }): Promise<SessionId> {
    const sourceTitle = opts.increaseTitle
      ? this.list.getSnapshot().byId[opts.sessionId]?.title
      : undefined
    const result = await this.manager.fork({
      sessionId: opts.sessionId,
      // Flooring lands inside the anchor's own turn (every turn opens with a
      // turn/start), so the host's first-turn/end-at-or-after cut still ends
      // on that turn — never clipped back to the previous one.
      ...(opts.atSeq === undefined ? {} : { atSeq: Math.floor(opts.atSeq) }),
    })
    if (!result.ok) throw new SessionForkError(result.error, opts.sessionId)
    this.projectList()
    const childId = result.value.sessionId
    if (sourceTitle !== undefined) {
      const child = this.binding(childId)?.session
      if (child === undefined) throw new Error(`fork child "${childId}" is not locally addressable`)
      const renamed = await child.rename(increasedForkTitle(sourceTitle))
      if (!renamed.ok) throw new Error(`fork child rename failed: ${renamed.error.code}: ${renamed.error.message}`)
    }
    return childId
  }

  /**
   * Resolve an Agent-scoped context view (use-and-discard).
   * @param id - session id (the agent identity — 1:1 same axis).
   * @returns scoped ctx, or undefined for a session neither listed nor already scoped.
   */
  scope(id: SessionId): AgentContext | undefined {
    return this.resolve(id)?.ctx
  }

  /**
   * Read the Agent scope tag off a context. Service-method boundary: fetch
   * bundles must reach scope resolution through ctx.sessions — a cross-bundle
   * value import of the standalone helper would inline a second module
   * instance whose private tag Symbol never matches.
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined {
    return scopeTagOf(ctx)
  }

  /**
   * Resolve the business Session behind an Agent-scoped context — the one
   * hop every scoped consumer (event listeners, per-session controllers)
   * takes from ctx-space into object-space (the client mirror of host
   * `agent.session`). Same service-method boundary as
   * {@link SessionRuntime.scopeOf}.
   * @param ctx - an Agent-scoped context.
   * @returns the session face, or undefined when the ctx is untagged or its scope was pruned.
   */
  sessionOf(ctx: Context): SessionFace | undefined {
    const id = scopeTagOf(ctx)
    if (id === undefined) return undefined
    return this.scopes.get(id)?.binding.session
  }

  /**
   * Resolve the stable session binding (scope-addressed assembly feed). Pure
   * resolution — no staging, no window side effects.
   * @param id - session id.
   * @returns binding, or undefined for a session neither listed nor already scoped.
   */
  binding(id: SessionId): SessionBinding | undefined {
    return this.resolve(id)?.binding
  }

  /**
   * Resolve one session's render-layer standard-props bundle (ctx never
   * enters the render layer; the renderer subscribes to
   * {@link SessionRuntime.currentProvideInfo}). Pure resolution — render-safe:
   * no staging, no window side effects (StrictMode double-invokes and
   * concurrent discarded passes must stay free).
   */
  private provideInfo(id: string): SessionProvideInfo | undefined {
    return this.resolve(id as SessionId)?.provideInfo
  }

  /**
   * Resolve the current-session-optional standard kit. Unknown or absent ids
   * return the static no-session projection rather than removing hook props.
   */
  private maybeProvideInfo(id: string | undefined): SessionMaybeProvideInfo {
    return (id === undefined ? undefined : this.provideInfo(id)) ?? this.provideChannel.maybeInfo
  }

  /**
   * Move the stage to the list's current session: sweep teardowns deferred
   * behind the previous occupant and pull the new occupant's history window.
   * Staging IS the open signal — the window opens ⟺ the session is on stage
   * — and open() is idempotent (an in-flight or completed open no-ops; a
   * failed one retries the next time current is touched).
   */
  private followCurrent(): void {
    const snapshot = this.list.getSnapshot()
    const current = snapshot.current
    // A masked gap (current blanked while the selection's session is
    // transiently absent) holds the stage: tearing down on the gap would
    // destroy exactly the frozen scope the mask exists to preserve.
    if (current === undefined || snapshot.byId[current] === undefined || current === this.watched) return
    this.watched = current
    this.sweepDeferred()
    const record = this.resolve(current)
    /* v8 ignore next 3 -- defensive: current is always a listed id (open()
     * validates and the projection masks absent selections), so resolve
     * cannot miss; kept so a future current writer cannot crash the notify. */
    if (record !== undefined) {
      void record.session.open()
      void this.manager.refreshSubagents(current)
    }
  }

  /**
   * Lazily mint the scope + binding for an eligible session. Eligibility and
   * prune share one predicate: listed on the host or selected
   * through a retained subagent address. Breadcrumb-only ancestors remain
   * summary data and do not keep scopes alive.
   */
  private resolve(id: SessionId): ScopeRecord | undefined {
    const existing = this.scopes.get(id)
    if (existing !== undefined) return existing
    if (!this.eligible(id)) return undefined
    const { fiber, ctx } = createScope(this.rootCtx, id)
    const session = this.manager.get(id)
    // The Session owns its scoped dispatch point (host Agent.loopCtx mirror);
    // mint and bind are one step so a live scope record implies a bound actx.
    session.bindScope(ctx)
    const binding: SessionBinding = { sessionId: id, session, ctx }
    const record: ScopeRecord = {
      fiber,
      ctx,
      binding,
      session,
      // Sources are bare observables; React binds selector hooks at its own boundary.
      provideInfo: this.provideChannel.materializeInfo(binding),
    }
    this.scopes.set(id, record)
    return record
  }

  /** The one aliveness predicate shared by scope mint and prune: host-listed or currently addressed. */
  private eligible(id: SessionId): boolean {
    const { ids, current } = this.list.getSnapshot()
    return current === id || ids.includes(id)
  }

  /** Project the manager's list snapshot into the store (title derivation is display-only). */
  private projectList(): void {
    const {
      items, current, phase, subagentsByParent, jobsBySession, currentAddress,
    } = this.manager.getListSnapshot()
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    for (const entry of items) {
      ids.push(entry.sessionId)
      byId[entry.sessionId] = {
        id: entry.sessionId,
        displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),
        running: entry.running,
        ...(entry.completed ? { completed: true } : {}),
        blank: entry.blank,
        updatedAt: entry.updatedAt,
        ...(entry.pendingInteraction === undefined
          ? {}
          : { pendingInteraction: entry.pendingInteraction }),
        ...(entry.projectionValues === undefined
          ? {}
          : { projectionValues: entry.projectionValues }),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
        ...(entry.parentSessionId !== undefined ? { parentId: entry.parentSessionId } : {}),
        ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
        ...(entry.agentPreset !== undefined ? { agentPreset: entry.agentPreset } : {}),
      }
    }
    if (current !== undefined && currentAddress !== undefined) {
      const seen = new Set<SessionId>()
      let address: SubagentAddress | undefined = currentAddress
      while (address !== undefined && !seen.has(address.childSessionId)) {
        const childId = address.childSessionId
        seen.add(childId)
        const child = subagentsByParent[address.parentSessionId]?.entries
          .find(entry => entry.kind === 'child' && entry.id === childId)
        if (child?.kind !== 'child') break
        const displayTitle = child.label ?? childId
        const summary = byId[childId]
        if (summary === undefined) {
          byId[childId] = {
            id: childId,
            displayTitle,
            parentId: address.parentSessionId,
            origin: 'subagent',
            running: child.activity === 'running',
            blank: false,
            updatedAt: 0,
          }
        } else if (summary.displayTitle !== displayTitle) {
          byId[childId] = { ...summary, displayTitle }
        }
        const parent = byId[address.parentSessionId]
        if (parent !== undefined && parent.origin !== 'subagent') break
        address = this.manager.navigationAddress(address.parentSessionId)
      }
    }
    const persisted = this.selection.getSnapshot().sessionId
    // No current (cleared, or masked gap) wipes the persisted cell — a reload
    // stays on empty; the in-memory selection still resurfaces a masked id.
    if (current === undefined) {
      if (persisted !== undefined) this.selection.set({})
    } else if (byId[current] !== undefined
      && (persisted !== current
        || this.selection.getSnapshot().subagentAddress?.childSessionId !== currentAddress?.childSessionId
        || this.selection.getSnapshot().subagentAddress?.parentSessionId !== currentAddress?.parentSessionId
        || this.selection.getSnapshot().subagentAddress?.mode !== currentAddress?.mode)) {
      this.selection.set({
        sessionId: current,
        ...(currentAddress === undefined ? {} : { subagentAddress: currentAddress }),
      })
    }
    this.list.set({ ids, byId, current, phase, subagentsByParent, jobsBySession, currentAddress })
    this.pruneScopes()
  }

  /** Tear down scope + instance for no-longer-eligible sessions off stage; the staged one defers until the stage moves. */
  private pruneScopes(): void {
    for (const [id, record] of this.scopes) {
      if (this.eligible(id)) continue
      if (id === this.watched) {
        this.deferredRemovals.add(id)
        continue
      }
      this.scopes.delete(id)
      this.deferredRemovals.delete(id)
      this.dropScope(id, record)
    }
  }

  /**
   * One teardown for the whole per-session axis: the scope
   * fiber (cascading every actx-registered effect: input shell, slash
   * controller, popup, plugin stores, listeners), the session-keyed slot
   * stores, and the Session instance itself — the host session log is the
   * durable truth, a reopen lazily rebuilds and backfills via open().
   */
  private dropScope(id: SessionId, record: ScopeRecord): void {
    void record.fiber.dispose()
    // Release the Session's dispatch point with the scope it belongs to (a
    // surviving instance — the live Intent — rebinds when resolve re-mints).
    record.session.unbindScope()
    // Optional lookup: slots and sessions are sibling services with no
    // declared dependency; a slots-less boot (object-layer tests) skips.
    this.rootCtx.get('slots')?.pruneStoreScope(id)
    this.manager.drop(id)
  }

  /** Run deferred teardowns whose session is no longer staged (called when the stage moves). */
  private sweepDeferred(): void {
    for (const id of [...this.deferredRemovals]) {
      /* v8 ignore next -- defensive: only the staged id ever defers, and every
       * stage move sweeps first, so the set cannot contain the id the stage just
       * moved to; kept as a guard against future extra sweep call sites. */
      if (id === this.watched) continue
      // Eligible again? (A re-added id cancels the deferred teardown.)
      if (this.eligible(id)) {
        this.deferredRemovals.delete(id)
        continue
      }
      const record = this.scopes.get(id)
      this.deferredRemovals.delete(id)
      /* v8 ignore next -- defensive: prune deletes a scope and its deferral
       * together, so a deferred id always still owns its record; kept so a
       * future teardown path cannot double-dispose. */
      if (record !== undefined) {
        this.scopes.delete(id)
        this.dropScope(id, record)
      }
    }
  }
}
