/** 浏览器负责采样时区，用于记录 Prompt RPC 来源。 */

/**
 * 为一次出站操作解析当前浏览器的 IANA 时区。
 * @returns 浏览器提供的规范时区。
 * @throws runtime 无法提供非空时区时抛出。
 */
export function resolvedClientTimeZone(): string {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new Error('browser time zone is unavailable')
  }
  return timeZone
}
