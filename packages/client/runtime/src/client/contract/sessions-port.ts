/**
 * 跨业务域的 sessions 接口：同级业务域（目前是 workspaces）依赖该接口，而不依赖
 * sessions 实现。sessions 域通过结构类型满足它；组装层或测试注入真实服务时会检查
 * SessionRuntime 可赋值性。因此扩展本接口就是明确扩大跨域依赖。
 */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from './store.ts'

/** 同级业务域读取的 session 列表行信息：最近使用时间、空白复用资格和规范 cwd。 */
export interface SessionsPortSummary {
  id: SessionId
  /** 日志是否为空；New Session 会复用空白 session，而不是再创建一个。 */
  blank: boolean
  cwd?: string
  updatedAt: number
}

/** 同级业务域读取的 session 列表信息：就绪状态、当前选择和行映射。 */
export interface SessionsPortList {
  ids: SessionId[]
  byId: Record<SessionId, SessionsPortSummary>
  current: SessionId | undefined
  phase: 'pending' | 'ready'
}

/** 注入同级业务域的 sessions 服务接口。 */
export interface SessionsPort {
  /** 可观察列表快照；只读，写操作保留在 sessions 域内部。 */
  readonly list: ObservableSnapshot<SessionsPortList>
  /**
   * 在 Host 上创建一个 session。
   * @param opts - 目标 workspace。
   * @returns 新 session 的 ID。
   */
  create(opts: { workspaceId: WorkspaceId }): Promise<SessionId>
  /**
   * 选择一个 session 作为当前项。
   * @param id - session ID，必须存在于列表 store。
   */
  open(id: SessionId): void
  /** 清除当前选择，进入无 session 视图状态。 */
  clear(): void
}
