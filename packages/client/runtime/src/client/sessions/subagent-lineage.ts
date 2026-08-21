/**
 * 对保留的 session 列表镜像执行纯 subagent 谱系聚合。普通 fork 会终止传播，使每个
 * 可见 session 只拥有其连续 subagent 子树。
 * @module @deepseek-ai/dsh-client-runtime/client/sessions/subagent-lineage
 */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSummary } from './service.ts'

/** 为一个可能的父 session 投影的后代计数。 */
export interface SubagentDescendantSummary {
  /** 通过连续 subagent 来源谱系连接的全部后代。 */
  readonly count: number
  /** 对应 session 摘要当前处于运行状态的后代数。 */
  readonly runningCount: number
}

/**
 * 将每个 subagent 后代索引到它沿连续 subagent 来源链可到达的每个祖先下。循环会软
 * 失败；孤立所有者在其摘要到达前只作为无害映射键存在。
 * @param summaries - 以 ID 为键保留的 session 摘要。
 * @returns 以可能父 ID 为键的后代总数和运行中总数。
 */
export function indexSubagentDescendants(
  summaries: Readonly<Record<SessionId, SessionSummary>>,
): ReadonlyMap<SessionId, SubagentDescendantSummary> {
  const indexed = new Map<SessionId, { count: number; runningCount: number }>()
  for (const descendant of Object.values(summaries)) {
    if (descendant.origin !== 'subagent') continue
    const seen = new Set<SessionId>()
    let current: SessionSummary | undefined = descendant
    while (current?.origin === 'subagent' && current.parentId !== undefined
      && !seen.has(current.id)) {
      seen.add(current.id)
      const aggregate = indexed.get(current.parentId)
      if (aggregate === undefined) {
        indexed.set(current.parentId, {
          count: 1,
          runningCount: descendant.running ? 1 : 0,
        })
      } else {
        aggregate.count += 1
        if (descendant.running) aggregate.runningCount += 1
      }
      current = summaries[current.parentId]
    }
  }
  return indexed
}
