import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm/types'
import type {
  AssistantProvenanceView, AssistantRequestConfig,
} from './conversation.ts'

export type {
  AssistantProvenanceView, AssistantRequestConfig,
} from './conversation.ts'

/** 普通生成过程中生效的完整模型可见请求头。 */
export interface ConversationPromptSnapshot {
  /** 有效请求头中的 Provider/model 和采样配置。 */
  config: AssistantRequestConfig
  /** 渲染后的 system prompt 文本；请求没有 system prompt 时为空。 */
  system: string
  /** 随请求发送的完整工具目录，包括从未调用的工具。 */
  tools: readonly ToolSchema[]
}

/** 准备一次普通请求时引入的 system/tool 变化。 */
export interface RequestPromptChange {
  /** 引入此状态的 request/header 事件 seq。 */
  seq: number
  /** request/header 事件的 Unix epoch 毫秒时间。 */
  time: number
  /** 模型可见 Prompt 相对上一记录状态的变化方式。 */
  kind: 'initial' | 'system' | 'tools' | 'system-and-tools'
  /** 本次变化前的状态；初始请求头不存在。 */
  previous?: ConversationPromptSnapshot
}

/** 普通生成与压缩请求共用的生命周期字段。 */
interface RequestViewBase {
  /** Sequence that opened the operation represented by this request. */
  startSeq: number
  startedAt: number
  completedAt: number | null
  status: 'running' | 'complete' | 'error'
  error?: string
  provenance?: AssistantProvenanceView
  requestConfig?: AssistantRequestConfig
  usage?: unknown
  /** 本请求生成的 Assistant 消息或压缩摘要 seq。 */
  resultSeq?: number
}

/** 根据持久请求事件组装的一次普通 Assistant 生成。 */
interface AssistantRequestView extends RequestViewBase {
  purpose: 'assistant'
  turn: number
  /** 发出本请求的 Agent loop step。 */
  step: number
  /** 有效普通请求输入；在后续请求头更改前持续继承。 */
  prompt?: ConversationPromptSnapshot
  /** 准备本请求时记录的 Prompt 变化。 */
  promptChange?: RequestPromptChange
  /** 普通请求失败后安排的重试序号。 */
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
}

/** 一次压缩 Provider 请求；可归某个 turn 所有，也可独立发生在 turns 之间。 */
interface CompactionRequestView extends RequestViewBase {
  purpose: 'compaction'
  /** 所属 turn；在 turns 之间手动压缩时为 `null`。 */
  turn: number | null
  /** 直接压缩请求不占用 Agent loop step。 */
  step: 0
  /** 已提交压缩替换消息时的消息 seq。 */
  replacementSeq?: number
  /** 可安全展示的压缩摘要投影。 */
  summary?: readonly ContentBlock[]
  /** 安全投影前的完整压缩 Provider 输出。 */
  rawOutput?: readonly ContentBlock[]
}

/** 根据持久请求生命周期事件组装的一次 Provider 请求。 */
export type RequestView = AssistantRequestView | CompactionRequestView

/** 面向阶段的 Trajectory 布局所消费的请求数据。 */
export interface RequestInspectionSnapshot {
  requests: readonly RequestView[]
  callSchemas: ReadonlyMap<string, ToolSchema>
}
