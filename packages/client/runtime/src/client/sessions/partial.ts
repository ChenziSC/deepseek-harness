// PartialAccumulator 是 assistant/chunk 累加器。它把六种 StreamChunk 按 block 索引
// 折叠为 AssistantBlock[]，并保持 block 级不可变性：delta 只替换对应 block 的引用。

import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { AssistantBlock, PartialAssistant } from './conversation.ts'
import { toAssistantBlock } from './conversation.ts'

/**
 * 判断一个流 chunk 是否会改变 UI 展示的部分 Assistant 投影。
 * @param type - Stream chunk 判别字段。
 * @returns 发布累计部分内容是否可能改变可见快照。
 */
export function isVisibleAssistantChunk(type: string): boolean {
  return type === 'block-start'
    || type === 'text-delta'
    || type === 'reasoning-delta'
    || type === 'tool-call-delta'
    || type === 'block-end'
}

/** assistant/chunk 累加器：把 StreamChunks 折叠为 block 级不可变的 AssistantBlock[]。 */
export class PartialAccumulator {
  // 有意保持稀疏：block-start 可能乱序到达，空洞会保留到压紧时。
  private blocks: (AssistantBlock | undefined)[] = []
  private changed = true
  private snapshot: PartialAssistant

  /**
   * @param turn - 所属 Agent turn。
   * @param step - 所属模型 step。
   * @param initialBlocks - 历史重放后开始累加时已有的实例化前缀。
   */
  constructor(
    readonly turn: number,
    readonly step: number,
    initialBlocks: readonly AssistantBlock[] = [],
  ) {
    this.blocks = [...initialBlocks]
    this.snapshot = { turn, step, blocks: initialBlocks }
  }

  /**
   * 折叠一个 chunk。
   * @param chunk - 流 chunk。
   * @returns 是否造成可见变化；usage/finish 返回 false 并跳过通知。
   */
  push(chunk: StreamChunk): boolean {
    switch (chunk.type) {
      case 'block-start': {
        this.blocks[chunk.index] = emptyAssistantBlock(chunk.blockType)
        this.changed = true
        return true
      }
      case 'text-delta': {
        const prev = this.blocks[chunk.index]
        this.blocks[chunk.index] = { kind: 'text', text: (prev?.kind === 'text' ? prev.text : '') + chunk.text }
        this.changed = true
        return true
      }
      case 'reasoning-delta': {
        const prev = this.blocks[chunk.index]
        this.blocks[chunk.index] = { kind: 'reasoning', text: (prev?.kind === 'reasoning' ? prev.text : '') + chunk.text }
        this.changed = true
        return true
      }
      case 'tool-call-delta': {
        const prev = this.blocks[chunk.index]
        const base = prev?.kind === 'tool-call' ? prev : { kind: 'tool-call' as const, callId: '', name: '', argsRaw: '' }
        this.blocks[chunk.index] = {
          kind: 'tool-call',
          callId: base.callId || String(chunk.id),
          name: chunk.name ?? base.name,
          argsRaw: base.argsRaw + chunk.argumentsDelta,
        }
        this.changed = true
        return true
      }
      case 'block-end': {
        this.blocks[chunk.index] = toAssistantBlock(chunk.block)
        this.changed = true
        return true
      }
      default:
        // usage、finish 和通过声明合并扩展的未知变体不会改变可见 block；finish 后会
        // 立即跟随 assistant/message，取代部分内容。
        return false
    }
  }

  /**
   * 当前部分投影。
   * @returns 缓存快照；blocks 数组引用只在发生修改后变化。
   */
  toPartial(): PartialAssistant {
    if (this.changed) {
      // 将乱序 block-start 形成的稀疏索引压紧为渲染顺序。
      this.snapshot = { turn: this.turn, step: this.step, blocks: this.blocks.filter((b): b is AssistantBlock => b !== undefined) }
      this.changed = false
    }
    return this.snapshot
  }
}

/**
 * 为一种流式 Assistant block kind 创建空客户端投影。
 * @param blockType - 传输层 block kind。
 * @returns 可接收 delta 的空投影 block。
 */
export function emptyAssistantBlock(blockType: string): AssistantBlock {
  switch (blockType) {
    case 'text': return { kind: 'text', text: '' }
    case 'reasoning': return { kind: 'reasoning', text: '' }
    case 'tool-call': return { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
    default: return { kind: 'other', block: null }
  }
}
