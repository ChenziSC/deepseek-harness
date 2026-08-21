/**
 * workspaces 服务的对外接口，即 `ctx.workspaces` 暴露给功能包和渲染器宿主的内容，
 * 也精确规定测试 runtime 的 workspaces 替身必须实现什么。传输泵入口
 * （handleHostEnvelope/handleConnected/refresh/startInitialSelection）保留在具体类上。
 * 扩展本接口就是明确扩大功能可对 workspaces 域执行的操作。
 */
import type { DirectoryListing, SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '../workspaces/service.ts'
import type { ObservableSnapshot } from './store.ts'

/** 以 `ctx.workspaces` 注入的 workspaces 服务接口。 */
export interface IWorkspaces {
  /** useWorkspaces 标准数据源；只读，写操作保留在业务域内部。 */
  readonly list: ObservableSnapshot<WorkspaceListState>
  /**
   * 将 Workspace 连接到可复用或新建的空白 session。
   * @param workspaceId - 目标 workspace。
   * @returns 已连接的 session ID。
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * New Session 流程：连接显式指定、当前 session 所属或最近使用的 Workspace，并打开
   * 得到的 session；失败会反映在 session 列表状态上。
   * @param workspaceId - 显式目标；省略时先继承当前 session 的 Workspace，再回退到
   * 最近使用投影。
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * 将现有路径注册为 Workspace。
   * @param input - Host 创建载荷。
   * @returns 新建或幂等解析出的 Workspace。
   */
  create(input: { path: string }): Promise<WorkspaceView>
  /**
   * 打开 Host 原生目录选择器。
   * @returns 所选路径；用户取消时返回 null。
   */
  pickDirectory(): Promise<string | null>
  /**
   * 通过 Host 的 `browse` 能力列出一层目录。
   * @param path - 要列出的绝对目录；省略时列出 Host 主目录。
   * @param signal - 调用方发起新请求时，中止传输请求及 Host 扫描。
   * @returns 带面包屑祖先信息的该层目录列表。
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * 通过 Host 的 `browse` 能力创建一个子目录。
   * @param path - 已存在父目录的绝对路径。
   * @param name - 单个非空路径段。
   * @returns 新目录的绝对路径。
   */
  createDirectory(path: string, name: string): Promise<string>
  /**
   * 使用 Host 操作系统的默认应用打开文件系统路径。
   * @param path - 绝对路径或 Host 可解析路径。
   */
  openPath(path: string): Promise<void>
  /**
   * 重命名 Workspace。
   * @param workspaceId - 目标 workspace。
   * @param title - 新显示标题。
   * @returns 更新后的 Workspace 视图。
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  /**
   * 删除 Workspace；其 sessions 会回退到未归属分组。
   * @param workspaceId - 目标 workspace。
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  /**
   * 在注册表显示顺序内移动 Workspace。
   * @param workspaceId - 要移动的 Workspace。
   * @param beforeWorkspaceId - 锚点 workspace；省略时追加到末尾。
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  /**
   * 在 Workspace 有序列表内移动已归属 session，或把它移入该列表。
   * @param workspaceId - 目标 workspace。
   * @param sessionId - 要移动的已归属 session。
   * @param beforeSessionId - 插入位置前的已归属锚点；省略时追加。
   * @returns 更新后的 Workspace 视图。
   */
  insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView>
  /**
   * 将 session 归档到注册表全局集合。它会从分组界面隐藏，但 session 日志和归属槽位
   * 仍保留。归档当前 session 会清除选择并进入 New Session 视图状态。
   * @param sessionId - 要归档的 session。
   */
  archiveSession(sessionId: SessionId): Promise<void>
}
