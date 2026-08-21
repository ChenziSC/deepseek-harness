// 共用的 Assistant step 计时折叠：Chat Definitions 与 Trajectory 历史折叠都从同一
// step/start → 首个 token delta → assistant/message 序列得出 AssistantTiming。

import { isTokenDelta } from '@deepseek-ai/dsh-llm/message'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { AssistantTiming } from './conversation.ts'

// 首 token 判定函数与 StreamChunk 类型一同位于 dsh-llm；这里重新导出，使 Chat
// Definitions 继续从 client-runtime 导入。
export { isTokenDelta } from '@deepseek-ai/dsh-llm/message'

/** 一个 Assistant step 在最终完成前的计时边界：开始时间和首 token 时间。 */
export interface AssistantStepMetadata {
  stepStartTime: number | null
  firstTokenTime: number | null
}

/**
 * 一个 Assistant step 的复合映射键。
 * @param turn - 事件载荷中的 turn 编号。
 * @param step - 事件载荷中的 step 编号。
 * @returns 以 NUL 分隔、无冲突的 `turn`/`step` 键。
 */
export function assistantStepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

/**
 * 将一条事件折叠进逐 step 计时索引：step/start 创建条目，首个非空 token delta 只
 * 记录一次首 token 时间；其他事件类型不执行操作。
 * @param steps - 以 {@link assistantStepKey} 为键的可变逐 step 索引。
 * @param event - 原始窗口事件。
 */
export function indexAssistantStepTiming(steps: Map<string, AssistantStepMetadata>, event: SessionEvent): void {
  if (event.type === 'step/start') {
    steps.set(
      assistantStepKey(event.data.turn, event.data.step),
      { stepStartTime: event.time, firstTokenTime: null },
    )
  } else if (event.type === 'assistant/chunk' && isTokenDelta(event.data.chunk)) {
    const key = assistantStepKey(event.data.turn, event.data.step)
    const current = steps.get(key) ?? { stepStartTime: null, firstTokenTime: null }
    if (current.firstTokenTime === null) {
      steps.set(key, { ...current, firstTokenTime: event.time })
    }
  }
}

/**
 * 根据 step 条目确定一条已完成 Assistant 消息的计时。若 step 开始或首 token 落在
 * 窗口外，相应边界为 null。
 * @param steps - 由 {@link indexAssistantStepTiming} 构建的逐 step 索引。
 * @param turn - assistant/message 的 turn 编号。
 * @param step - assistant/message 的 step 编号。
 * @param completedTime - assistant/message 事件时间戳，单位 epoch 毫秒。
 * @returns 可直接写入 Node 的计时记录。
 */
export function settledAssistantTiming(
  steps: ReadonlyMap<string, AssistantStepMetadata>,
  turn: number,
  step: number,
  completedTime: number,
): AssistantTiming {
  return {
    ...(steps.get(assistantStepKey(turn, step)) ?? { stepStartTime: null, firstTokenTime: null }),
    completedTime,
  }
}
