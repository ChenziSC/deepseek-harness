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

/** 以 `ctx.sessions` 注入的 sessions 服务接口。 */
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
  /**
   * 选择一个 session 作为当前项。
   * @param id - session ID；必须存在于列表，未知 ID 会明确失败。
   */
  open(id: SessionId): void
  /**
   * 通过准确的直接父级地址打开目录中健康的子 session。
   * @param address - 从目录得出的父、子 ID。
   */
  openSubagent(address: SubagentAddress): void
  /**
   * 解析已发现的直接父级地址，但不打开它。
   * @param id - 可能已寻址的子 session ID。
   * @returns 已保留的地址；不存在时返回 undefined。
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined
  /**
   * 标记目录菜单是否正在消费实时成员更新。
   * @param parentSessionId - 目录所有者。
   * @param open - 当前菜单状态。
   */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void
  /**
   * 刷新一份直接子级目录。
   * @param parentSessionId - 目录所有者。
   * @returns 当前或新启动刷新完成时的 Promise。
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
  /**
   * 搜索 Host 可见的消息内容索引。结果只属于本次请求，列表快照仍是元数据权威来源。
   * @param query - 非空字面短语。
   * @param signal - 用于取消已被新请求取代的搜索。
   * @returns 有上限的结果，或业务/传输错误。
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  /**
   * 从源 session 已完成 turn 的前缀创建分支；完成时子 session 已进入列表 store，
   * `open()` 可以直接选择它。
   * @param opts - 源 session ID、可选的切分锚点事件 seq，以及是否在完成前递增继承的
   * 持久标题。切分边界是锚点处或之后的第一个 turn/end；若日志内锚点位于开放 turn，
   * 则视为不可用，而不会向前裁剪。
   * @returns 子 session ID。
   * @throws 创建分支失败，或创建后请求的子标题重命名失败时抛出。
   */
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>
  /**
   * 注册每 session 的标准 props provider。hooks 在渲染侧变为 `use<Name>` selector
   * hooks，其他 props 原样展开。
   * @param descriptor - 静态成员清单和每 session resolver。
   * @returns 移除 provider 的 disposer。
   */
  provide(descriptor: SessionProvideDescriptor): () => void
  /**
   * 解析 Agent scoped 上下文视图，使用后即可丢弃。
   * @param id - session ID。
   * @returns scoped ctx；session 既不在列表中也未建立 scope 时返回 undefined。
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
  /**
   * 解析稳定的 session binding，即以 scope 寻址的组装数据源。
   * @param id - session ID。
   * @returns binding；session 既不在列表中也未建立 scope 时返回 undefined。
   */
  binding(id: SessionId): SessionBinding | undefined
}
