/**
 * 将持久失败转换为可安全展示在 GUI 中的文案。
 * @param failure - Session 事件保留的失败值。
 * @returns 适合客户端投影展示的文案。
 */
export function displayFailureMessage(failure: unknown): string {
  if (failure === null || typeof failure !== 'object') return String(failure)
  const record = failure as { code?: unknown; message?: unknown }
  // Provider AUTH 消息可能回显已遮盖或部分保留的凭据。原始诊断保留在 session 日志中，
  // 但绝不能投影到 UI 状态。
  if (record.code === 'AUTH') return 'API key is invalid'
  return typeof record.message === 'string' ? record.message : JSON.stringify(failure)
}
