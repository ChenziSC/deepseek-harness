/**
 * sessions 服务的对外接口，即 `ctx.sessions` 暴露给功能包和渲染器宿主的内容，也精确
 * 规定测试 runtime 的 sessions 替身必须实现什么。传输泵入口
 * （handleMuxEnvelope/handleConnected/refresh）和 runtime 内部能力保留在具体类上；
 * 跨域消费者使用更窄的 [SessionsPort](./sessions-port.ts)。扩展本接口就是明确扩大
 * 功能可对 sessions 域执行的操作。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  RpcResult, SessionId, SubagentAddress,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable, SessionMaybeProvideInfo } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentContext } from '../agents/scope.ts'
import type { SessionSearchResultItem } from '../sessions/manager.ts'
import type {
  SessionBinding, SessionListState, SessionProvideDescriptor,
} from '../sessions/service.ts'
import type { SessionFace } from './session.ts'
import type { ObservableSnapshot } from './store.ts'

export type { AgentContext } from '../agents/scope.ts'

// 中文：这是以 `ctx.sessions` 注入的 sessions 服务接口。
/** The sessions-service face injected as `ctx.sessions`. */
export interface ISessions {
  /** useSessions 标准数据源：列表行和当前选择；只读，写操作保留在业务域内部。 */
  readonly list: ObservableSnapshot<SessionListState>
  /** 当前 session 的原子 provide 投影，即渲染器宿主的 `sessions.provideInfo` 数据源。 */
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>
  /**
   * 传输 schema 固定的 `session.search` 结果上限，以注入数据形式提供给展示层。它不是
   * 每连接状态：包括 fixture 在内的所有传输都报告相同数值。
   */
  readonly searchResultLimit: number
  // 中文：选择当前 session；未知 ID 会明确失败。
  /**
   * Select a session as current.
   * @param id - session id (must exist in the list; unknown ids fail loud).
   */
  open(id: SessionId): void
  // 中文：通过目录给出的直接父子地址打开健康的子 session。
  /**
   * Open a healthy catalog child through its exact direct-parent address.
   * @param address - catalog-derived parent and child ids.
   */
  openSubagent(address: SubagentAddress): void
  /**
   * 解析已发现的直接父级地址，但不打开它。
   * @param id - 可能已寻址的子 session ID。
   * @returns 已保留的地址；不存在时返回 undefined。
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined
  // 中文：记录目录菜单是否正在消费实时成员更新。
  /**
   * Mark whether a catalog menu is consuming live membership updates.
   * @param parentSessionId - catalog owner.
   * @param open - current menu state.
   */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void
  // 中文：刷新一份直接子级目录，并复用正在进行的刷新。
  /**
   * Refresh one direct-child catalog.
   * @param parentSessionId - catalog owner.
   * @returns completion of the current or newly started refresh.
   */
  refreshSubagents(parentSessionId: SessionId): Promise<void>

  /**
   * 记录某 session 当前运行的组合。agent-preset 席位在空白 session 切换成功后调用，
   * 使标题标签立即随组合变化，而不必等待下一次完整列表刷新。
   * @param sessionId - 已切换的 session。
   * @param agentPreset - Host 已确认的 preset ID。
   */
  noteAgentPreset(sessionId: SessionId, agentPreset: string): void
  /** 清除当前选择，进入无 session 视图状态。 */
  clear(): void
  // 中文：搜索结果只属于本次请求；列表快照仍是元数据权威来源。
  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results, or a business/transport error.
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  // 中文：从已完成 turn 的前缀创建分支；开放 turn 内的锚点不可用，不会向前裁剪。
  /**
   * Fork a session from a completed-turn prefix of the source; on resolution
   * the child is in the list store and `open()` can target it.
   * @param opts - source session id, the optional event seq anchoring the
   *   cut (the boundary is the first turn/end at or after it; an in-log
   *   anchor in an open turn is unavailable rather than clipped backward),
   *   and whether to increment an inherited durable title before resolving.
   * @returns the child session id.
   * @throws when the fork fails, or when a requested child-title rename fails after creation.
   */
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>
  /**
   * 注册每 session 的标准 props provider。hooks 在渲染侧变为 `use<Name>` selector
   * hooks，其他 props 原样展开。
   * @param descriptor - 静态成员清单和每 session resolver。
   * @returns 移除 provider 的 disposer。
   */
  provide(descriptor: SessionProvideDescriptor): () => void
  // 中文：解析可即用即弃的 Agent scoped 上下文视图。
  /**
   * Resolve an Agent-scoped context view (use-and-discard).
   * @param id - session id.
   * @returns scoped ctx, or undefined for a session neither listed nor already scoped.
   */
  scope(id: SessionId): AgentContext | undefined
  /**
   * 从上下文读取 Agent scope 标签。这里是服务方法边界：fetch bundle 必须通过
   * ctx.sessions 进行 scope 解析。
   * @param ctx - 任意客户端上下文。
   * @returns session ID；根上下文返回 undefined。
   */
  scopeOf(ctx: Context): SessionId | undefined
  /**
   * 解析 Agent scoped 上下文背后的 session 接口。
   * @param ctx - Agent scoped 上下文。
   * @returns session 接口；ctx 无标签或其 scope 已清理时返回 undefined。
   */
  sessionOf(ctx: Context): SessionFace | undefined
  // 中文：解析稳定的、以 scope 寻址的 session 组装数据源。
  /**
   * Resolve the stable session binding (scope-addressed assembly feed).
   * @param id - session id.
   * @returns binding, or undefined for a session neither listed nor already scoped.
   */
  binding(id: SessionId): SessionBinding | undefined
}
