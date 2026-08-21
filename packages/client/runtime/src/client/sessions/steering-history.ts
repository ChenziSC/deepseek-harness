/** 从事件溯源的 Agent inbox 重建持久 steering 身份。 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { InboxTarget } from '@deepseek-ai/dsh-agent/types'

/** 重放持久 inbox splice 时保留的最小等待身份。 */
interface PendingIdentity {
  readonly id: string
}

/** Host 所有 inbox 事件在客户端的结构视图。 */
interface InboxSplice {
  readonly target: InboxTarget
  readonly start: number
  readonly removedCount?: number
  readonly inserted: readonly PendingIdentity[]
  readonly outcome?: 'canceled'
}

/**
 * 增量识别从 next-step inbox 取出的 `user/message` 事件。Agent loop 将所有准入输入
 * 记录为 `user/message`；此前的 `agent/inbox/spliced` 事件保留其来自 queued-turn
 * 列表还是 next-step 列表的信息。
 */
export class SteeringHistory {
  private readonly inbox: Record<InboxTarget, PendingIdentity[]> = {
    'next-turn': [],
    'next-step': [],
  }

  private readonly claimedNextStep = new Set<string>()

  /** 重建历史窗口前清除全部重放状态。 */
  reset(): void {
    this.inbox['next-turn'] = []
    this.inbox['next-step'] = []
    this.claimedNextStep.clear()
  }

  /**
   * 应用一条事件，并报告它是否为持久的人类 steering 消息。
   * @param event - 按顺序到达的下一条原始 session 事件。
   * @returns 仅当消息源自用户且此前从 `next-step` 取出时返回 true。
   */
  apply(event: SessionEvent): boolean {
    if (event.type === 'agent/inbox/spliced') {
      this.applySplice(event.data)
      return false
    }
    if (event.type !== 'user/message') return false
    const id = event.data.id
    if (!this.claimedNextStep.delete(id)) return false
    return event.data.source.kind === 'user'
  }

  /** 重放一次经 Host 校验的 inbox splice。 */
  private applySplice({ target, start, removedCount = 0, inserted, outcome }: InboxSplice): void {
    const removed = this.inbox[target].splice(start, removedCount, ...inserted)
    for (const identity of inserted) this.claimedNextStep.delete(identity.id)
    if (target !== 'next-step' || outcome === 'canceled') return
    for (const identity of removed) this.claimedNextStep.add(identity.id)
  }
}
