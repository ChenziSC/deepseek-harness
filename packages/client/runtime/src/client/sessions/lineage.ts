// flattenLineage：summaries → 带谱系缩进的扁平列表（纯函数）。输入顺序是权威顺序；
// 谱系只负责让子项紧邻父项。孤立谱系降级为根级，循环则软失败并按根项输出。

import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { PendingInteractionStatus } from './pending.ts'

/** 补充了最新 mux 投影持久标题的 Host 列表摘要。 */
export interface TitledSessionSummary extends SessionSummary {
  title?: string
  /** Host 当前为列表消费者计算的投影值。 */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/** 一条扁平 session 列表行，包含谱系深度和实时等待交互。 */
export interface SessionListEntry {
  sessionId: SessionId
  title?: string
  updatedAt: number
  running: boolean
  /** 从摘要镜像的空日志标记；列表会隐藏空白 session，筛选由消费者负责。 */
  blank: boolean
  parentSessionId?: SessionId
  /** 供导航筛选的粗粒度持久来源；不表示 continuation 能力。 */
  origin?: 'subagent'
  cwd?: string
  /** 组装本 session Agent 时使用的 Agent preset；从摘要透传。 */
  agentPreset?: string
  /** Host 当前为列表消费者计算的投影值。 */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
  /** 当前阻塞本 session 的用户交互，由实时 mux 帧得出。 */
  pendingInteraction?: PendingInteractionStatus
  /** 未选中且尚未打开时运行完成；对应侧边栏绿色“完成”提醒，选中或下次运行时清除。 */
  completed: boolean
  /** 谱系缩进深度：根为 0；UI 只需乘以缩进宽度。 */
  depth: number
}

/**
 * 将摘要转换为带谱系缩进的扁平列表。根项和同级项遵循既有输入顺序，本投影不会根据
 * 可变时间戳重新排序已注水列表。
 * @param summaries - Host 的 session.list 条目。
 * @param pendingInteractions - manager 按 session 保存的当前交互状态。
 * @param completed - 仍有完成提醒的 sessions；由 manager 持有的实时事实，缺失视为 false。
 * @returns 按渲染顺序排列的展示行。
 */
export function flattenLineage(
  summaries: readonly TitledSessionSummary[],
  pendingInteractions?: ReadonlyMap<SessionId, PendingInteractionStatus>,
  completed?: ReadonlySet<SessionId>,
): SessionListEntry[] {
  const byId = new Map<SessionId, TitledSessionSummary>()
  for (const s of summaries) byId.set(s.sessionId, s)

  const children = new Map<SessionId, TitledSessionSummary[]>()
  const roots: TitledSessionSummary[] = []
  for (const s of summaries) {
    if (s.parentSessionId !== undefined && byId.has(s.parentSessionId)) {
      const list = children.get(s.parentSessionId) ?? []
      list.push(s)
      children.set(s.parentSessionId, list)
    } else {
      roots.push(s) // 根项，或父级不在摘要中的孤立项；降级为根项但绝不丢弃。
    }
  }

  const out: SessionListEntry[] = []
  const visited = new Set<SessionId>()
  const walk = (s: TitledSessionSummary, depth: number): void => {
    if (visited.has(s.sessionId)) {
      console.warn(`[web-runtime] lineage cycle at ${s.sessionId}; emitting as root`)
      return
    }
    visited.add(s.sessionId)
    const pendingInteraction = pendingInteractions?.get(s.sessionId)
    out.push({
      ...s,
      ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
      completed: completed?.has(s.sessionId) ?? false,
      depth,
    })
    const kids = children.get(s.sessionId)
    if (kids === undefined) return
    for (const kid of kids) walk(kid, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  // 循环成员无法从任何根到达；按根项输出，确保不丢失条目。
  for (const s of summaries) {
    if (!visited.has(s.sessionId)) walk(s, 0)
  }
  return out
}
