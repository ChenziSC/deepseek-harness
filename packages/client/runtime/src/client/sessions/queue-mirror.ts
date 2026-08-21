import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { MuxFrame } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { QueuedMessage } from './conversation.ts'

const QUEUE_PREVIEW_CHARS = 200

function previewOf(content: readonly ContentBlock[]): string {
  const flat = content
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…` : flat
}

function textOf(content: readonly ContentBlock[]): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => block.text).join('')
}

type QueueItems = Extract<MuxFrame, { type: 'session/queue' }>['items']

/** 权威临时队列投影和持久 steering 交接。 */
export class SessionQueueMirror {
  private current: readonly QueuedMessage[] = []

  /**
   * 返回当前不可变队列投影。
   * @returns 当前队列行。
   */
  snapshot(): readonly QueuedMessage[] {
    return this.current
  }

  /**
   * 在替代队列基线到达前丢弃旧连接代次。
   * @returns 是否删除了任何已投影队列行。
   */
  reset(): boolean {
    if (this.current.length === 0) return false
    this.current = []
    return true
  }

  /**
   * 根据一帧权威流队列数据整体替换。
   * @param items - 完整 Host 队列快照。
   */
  replace(items: QueueItems): void {
    this.current = items.map(item => ({
      id: item.id,
      messageId: item.message.id,
      placement: item.placement,
      content: item.message.content,
      preview: previewOf(item.message.content),
      text: textOf(item.message.content),
    }))
  }

  /**
   * 临时 steering 行对应的持久消息进入日志后，移除该临时行。
   * @param event - 新进入连续区间的持久 Session 事件。
   * @returns 投影是否变化。
   */
  acceptDurable(event: SessionEvent): boolean {
    if (event.type !== 'user/message') return false
    const messageId = event.data.id
    const index = this.current.findIndex(item =>
      item.placement === 'steering' && item.messageId === messageId)
    if (index < 0) return false
    this.current = this.current.filter((_item, candidate) => candidate !== index)
    return true
  }
}
