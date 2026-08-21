/**
 * 默认的一次性摘要生成与持久化 checkpoint 封装。
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, createUserMessage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** 在最终 checkpoint 节点中包裹结构化摘要的标签。 */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

// 这段英文指令会在压缩时作为回放对话后的最后一条 user 消息发送给摘要模型，
// 并要求模型输出固定 Markdown 结构。标题、顺序和“只输出 checkpoint”等约束
// 都会影响持久化摘要、后续恢复与快照；为保持现有模型行为和 KV Cache 前缀，
// 运行时原文不做本地化，修改时必须同步验证摘要结构与组装后 transcript。
/**
 * 摘要指令作为回放对话后的最后一条 user 消息发送，而不是单独的摘要 system prompt。
 * 对话原有的 system prompt、Tool 与消息前缀保持在它之前，使辅助调用成为最近一次路由
 * 请求的真实前缀，从而复用而不是失效 Provider 的 KV Cache。
 */
/*
中文译文（仅供学习和维护，不参与运行时）：

你现在是这个 AI 编码助手的压缩引擎。请把上方对话浓缩为结构化 checkpoint，使另一个模型能够在不丢失关键上下文的情况下继续工作。

必须严格按以下 Markdown 结构输出：保留全部章节及其顺序；使用简短项目符号，不写散文段落；空章节写“(none)”，绝不能省略章节。

## 主要请求与意图
- 用户最初及演变后的目标；精确措辞重要时逐字引用。

## 关键技术概念
- 涉及的技术、框架、模式与约定。

## 文件与代码
- 精确路径、文件为何重要，以及关键修改或片段。

## 错误与修复
- 错误、解决方式和相关用户反馈。

## 待处理工作
- 用户明确要求但尚未完成的工作。

## 当前工作
- 生成此 checkpoint 时正在进行的精确工作。

## 下一步
- 与最近请求直接一致的唯一下一项行动；没有则写“(none)”。

## 关键上下文
- 决策及理由、约束、用户偏好、开放问题，以及继续工作所需的数据。

规则：
- 使用简洁的英文工程表述。精确保留文件路径、命令、错误字符串、标识符、数值、函数签名和语法片段。
- 忠实记录用户反馈和明确指令，尤其是纠正意见。
- 不要提及本次摘要请求，也不要说明上下文已被压缩。
- 只输出 checkpoint 文本；不要调用 Tool 或执行其他操作。
- 若对话中已有 <compacted-summary> 块，它是旧 checkpoint。不要逐字复制；保留仍然成立的事实、删除过时内容，并把新信息合并为采用同一结构的单一摘要。
*/
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

// 下方英文前言会进入替换后的 user 消息，使摘要成为后续模型的既定上下文；运行时原文
// 保持不变。中文译文：这是一个自动生成的 checkpoint，用于浓缩较早的一段对话并释放
// 上下文空间。应将其中内容视为已建立的背景，在其基础上继续，不要复述。直接从后续消息
// 继续任务，不要确认或提及该 checkpoint。
/** 让替换 user 消息成为既定上下文的封装前言。 */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * 摘要器要压缩的回放对话内容。逐字复现最近一次路由请求的 system prompt、Tool 和前置
 * 消息，使辅助调用能够复用 Provider 已预热的前缀缓存；末尾的压缩指令是唯一新输入。
 */
export interface SummarizationInput {
  /** 对话自己的 system prompt，用于对齐前缀缓存；无 system 的请求中缺省。 */
  readonly system?: string
  /** 对话的 Tool schema，用于对齐前缀缓存；请求没有 Tool 时缺省。 */
  readonly tools?: readonly ToolSchema[]
  /** 按展示顺序排列、位于压缩指令之前的被遮蔽区间。 */
  readonly messages: readonly Message[]
}

/** 安全的摘要内容，以及随摘要记录的精确辅助调用 envelope。 */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider 为本次摘要请求报告的用量。 */
  usage?: TokenUsage
} & (
  | {
    /** 投影为纯文本摘要前的完整 Provider 输出。 */
    rawOutput: ContentBlock[]
    /** 精确标识一次通过当前上下文 `ctx.llm.stream()` 发出的调用。 */
    llmStreamCall: true
  }
  | {
    /** 未标记模板、远端或其他摘要器的可选完整输出。 */
    rawOutput?: ContentBlock[]
    /** 未标记结果不代表通过当前上下文 LLM seam 发出的调用。 */
    llmStreamCall?: never
  }
)

/**
 * 执行默认的、可复用缓存的 `ctx.llm.stream()` 摘要调用：先回放对话前缀，再把压缩指令
 * 作为最后一条 user 消息追加，以复用 Provider 已预热的前缀缓存。
 * @param ctx - 提供 LLM 服务的上下文。
 * @param config - 解析后的后端配置。
 * @param input - 要压缩的回放对话前缀，包括 system、Tool 和前置消息。
 * @param agent - 提供已路由模型历史、后备模型和 Session id。
 * @param signal - 可选的取消信号，向下传给 adapter。
 * @returns 安全的纯文本摘要块，以及精确的调用 envelope 与输出。
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const assembler = new BlockAssembler()
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    }),
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/**
 * 使用持久化 checkpoint 封装原始摘要块。
 * @param summary - 安全的纯文本模型输出。
 * @returns 合成的替换 user 消息内容。
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** 将摘要终止原因映射为 fail-closed 错误。 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** 合成 user 消息前拒绝视觉输出，只保留文本。 */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
