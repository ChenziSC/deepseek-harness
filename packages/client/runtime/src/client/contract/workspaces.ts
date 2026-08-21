/**
 * workspaces 服务的对外接口，即 `ctx.workspaces` 暴露给功能包和渲染器宿主的内容，
 * 也精确规定测试 runtime 的 workspaces 替身必须实现什么。传输泵入口
 * （handleHostEnvelope/handleConnected/refresh/startInitialSelection）保留在具体类上。
 * 扩展本接口就是明确扩大功能可对 workspaces 域执行的操作。
 */
import type { DirectoryListing, SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '../workspaces/service.ts'
import type { ObservableSnapshot } from './store.ts'

// 中文：这是以 `ctx.workspaces` 注入的 workspaces 服务接口。
/** The workspaces-service face injected as `ctx.workspaces`. */
export interface IWorkspaces {
  /** useWorkspaces 标准数据源；只读，写操作保留在业务域内部。 */
  readonly list: ObservableSnapshot<WorkspaceListState>
  // 中文：将 Workspace 连接到可复用或新建的空白 session。
  /**
   * Connect a Workspace to its reusable or freshly created blank session.
   * @param workspaceId - target workspace.
   * @returns the connected session id.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  // 中文：New Session 流程按显式目标、当前 session、最近使用的顺序选择 Workspace。
  /**
   * The New Session flow: connect the explicit, current-Session, or recent
   * Workspace and open the resulting session; failures surface on the session
   * list state.
   * @param workspaceId - explicit target; omitted inherits the current
   * Session's Workspace before falling back to the recency projection.
   */
  startSession(workspaceId?: WorkspaceId): void
  // 中文：将现有路径幂等注册为 Workspace。
  /**
   * Register an existing path as a Workspace.
   * @param input - the Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  create(input: { path: string }): Promise<WorkspaceView>
  // 中文：打开 Host 原生目录选择器；取消时返回 null。
  /**
   * Open the Host's native directory picker.
   * @returns the selected path, or null when the user cancelled.
   */
  pickDirectory(): Promise<string | null>
  // 中文：通过 Host `browse` 能力列出一层目录，并支持取消被取代的扫描。
  /**
   * List one directory level through the Host's `browse` capability.
   * @param path - absolute directory to list; absent lists the Host home directory.
   * @param signal - aborts the wire request (and the Host's scan) when the caller supersedes it.
   * @returns the level's listing with breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  // 中文：通过 Host `browse` 能力在现有父目录下创建一个子目录。
  /**
   * Create one child directory through the Host's `browse` capability.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment.
   * @returns the created directory's absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
  // 中文：使用 Host 操作系统的默认应用打开路径。
  /**
   * Open a filesystem path with the Host operating system's default application.
   * @param path - absolute or host-resolvable path.
   */
  openPath(path: string): Promise<void>
  // 中文：重命名 Workspace 并返回更新后的视图。
  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - the new display title.
   * @returns the updated Workspace view.
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  // 中文：删除 Workspace 后，其 sessions 回退到未归属分组。
  /**
   * Delete a Workspace (its sessions fall back to the unaccounted group).
   * @param workspaceId - target workspace.
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  // 中文：在注册表显示顺序内移动 Workspace；省略锚点时追加。
  /**
   * Move a Workspace within the registry display order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor workspace; omitted appends.
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  // 中文：在 Workspace 有序列表内移动或移入已归属 session。
  /**
   * Move an accounted session within/into a Workspace's ordered list.
   * @param workspaceId - target workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView>
  // 中文：归档会从分组界面隐藏 session，但保留日志与归属槽位。
  /**
   * Archive a session into the registry-global set (hidden from grouping
   * surfaces; session log and accounting slot remain). Archiving the current
   * session clears the selection into the New Session view state.
   * @param sessionId - session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
}
