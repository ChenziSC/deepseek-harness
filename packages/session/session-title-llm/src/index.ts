/**
 * 模型驱动的 Session 标题 Provider 共用的路由、封装、超时、组装与校验策略。
 * @module @deepseek-ai/dsh-session-title-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, BlockAssembler, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
} from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleAutomaticMode,
  SessionTitleModelProvenance,
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
  SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'

// 中文说明：一次辅助标题请求发出前记录的完整模型可见请求，包括 Provider、消息 seq、
// 路由、system prompt、消息列表和输出 token 上限。
/** Exact model-visible request recorded before one auxiliary title dispatch. */
export interface SessionTitleLlmRequestEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact human `user/message` seqs represented in `messages`. */
  readonly messageSeqs: number[]
  /** Exact auxiliary LLM route. */
  readonly route: SessionTitleModelProvenance
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    // 中文说明：一次 Session 标题模型请求的仅日志、发送前记录。
    /** Log-only pre-dispatch record of one session-title model request. */
    'session/title-llm-request': SessionTitleLlmRequestEventData
  }
}

/** 标题能力为辅助标题请求定义的超时原因码。 */
export const SESSION_TITLE_TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/** 一个模型驱动标题插件所需的部署策略。 */
export interface SessionTitleLlmConfig {
  /** 非 CJK 标题的目标词数。 */
  readonly targetWords: number
  /** 中文、日文或韩文标题的目标字符数。 */
  readonly targetCjkCharacters: number
  /** 最终 JSON 封装 user prompt 的最大 UTF-8 字节数。 */
  readonly maxInputBytes: number
  /** 辅助生成的输出 token 上限。 */
  readonly maxOutputTokens: number
  /** 辅助请求端到端期限，单位为毫秒。 */
  readonly timeoutMs: number
  /** 可选的显式 Provider 路由；必须与 `model` 同时提供。 */
  readonly provider?: string
  /** 可选的显式模型 id；必须与 `provider` 同时提供。 */
  readonly model?: string
}

/** 已校验且不可变的模型 Provider 策略。 */
export interface ResolvedSessionTitleLlmConfig extends SessionTitleLlmConfig {}

/** 不带库默认值的共用 Loader 字段 schema。 */
export const SessionTitleLlmConfigFields = {
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  provider: z.string(),
  model: z.string(),
}

/** 不带库默认值的共用 Loader schema。 */
export const SessionTitleLlmConfigSchema: z<SessionTitleLlmConfig> = z.object(SessionTitleLlmConfigFields)

/** 用于直接构造校验的完整配置键集合。 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'targetWords',
  'targetCjkCharacters',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'provider',
  'model',
])

/** 校验一个正整数限制。 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-llm: ${name} must be a positive integer`)
  }
}

/**
 * 校验并分离所需的模型 Provider 配置。
 * @param config - 不受信任的插件配置。
 * @returns 不可变策略，并保留可选路由的缺省状态。
 */
export function resolveSessionTitleLlmConfig(
  config: SessionTitleLlmConfig,
): ResolvedSessionTitleLlmConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-title-llm: configuration is required')
  }
  const value = candidate as SessionTitleLlmConfig
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`)
  }
  assertPositiveInteger('targetWords', value.targetWords)
  assertPositiveInteger('targetCjkCharacters', value.targetCjkCharacters)
  assertPositiveInteger('maxInputBytes', value.maxInputBytes)
  assertPositiveInteger('maxOutputTokens', value.maxOutputTokens)
  assertPositiveInteger('timeoutMs', value.timeoutMs)
  if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`session-title-llm: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  const hasProvider = value.provider !== undefined
  const hasModel = value.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('session-title-llm: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof value.provider !== 'string' || value.provider.length === 0
      || typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('session-title-llm: provider and model overrides must be non-empty strings')
  }
  return deepFreeze({ ...value })
}

/** 从固定服务 revision 中选择 Provider 拥有的消息子集。 */
export type SessionTitleLlmMessageSelector = (
  messages: readonly SessionTitleUserMessage[],
) => readonly SessionTitleUserMessage[]

/**
 * 通过共用配置与调用策略注册一个模型驱动的 Provider。
 * @param ctx - 暴露标题与 LLM 服务的上下文。
 * @param config - 不受信任的必要部署策略。
 * @param id - 随生成标题记录的稳定插件 id。
 * @param automatic - Provider 拥有的自动生成时机策略。
 * @param selectMessages - 一个 revision 对源消息的精确选择。
 */
export function registerSessionTitleLlmProvider(
  ctx: Context,
  config: SessionTitleLlmConfig,
  id: string,
  automatic: SessionTitleAutomaticMode,
  selectMessages: SessionTitleLlmMessageSelector,
): void {
  const resolved = resolveSessionTitleLlmConfig(config)
  const titleProvider = SessionTitleProviderId(id)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic,
    async generate(request) {
      return generateSessionTitleWithLlm(ctx, resolved, request, selectMessages(request.messages), titleProvider)
    },
  })
}

/** 解析显式 Provider/model 对，或从 `request/header` 捕获的精确路由。 */
function resolveRoute(
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
): SessionTitleModelProvenance {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  if (request.route === undefined) {
    throw new Error('session-title-llm: no logged request route is available; configure provider and model together')
  }
  return request.route
}

// 该英文系统指令只发送给生成 Session 标题的辅助模型，不会展示给最终用户。
// 它在每次自动命名时约束单行纯文本输出，并要求沿用消息语言；翻译原文可能改变
// 标题格式、长度与解析结果，因此保留英文，并通过下方参数控制中英文目标长度。
// 中文译文：根据提供的人类消息，为 AI 编码助手 Session 创建简洁标题。只返回单行标题，
// 使用自然语言纯文本；不得包含引号、前缀、解释、Markdown、XML 或终端控制码，也不得
// 包含代码。使用消息本身的语言。非 CJK 语言以约 targetWords 个词为目标；中文、日文、
// 韩文以约 targetCjkCharacters 个字符为目标。
/** 两个 Provider 插件共用、可感知语言的稳定 system 指令。 */
function systemPrompt(config: ResolvedSessionTitleLlmConfig): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
  ].join('\n')
}

// 下方英文 user prompt 的中文含义是“根据这个人类消息 JSON 数组生成 Session 标题”。
// JSON.stringify 保证用户文本无法突破结构分隔；运行时英文前缀保持不变。
/** 将精确消息封装为 JSON，防止用户文本破坏结构分隔。 */
function frameMessages(messages: readonly SessionTitleUserMessage[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

/** 将终止原因转换为辅助调用失败。 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('session-title-llm: title output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('session-title-llm: title model unexpectedly requested a tool')
    default:
      return new Error(`session-title-llm: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * 通过共用辅助 LLM 调用生成一个标题。
 * @param ctx - 暴露已注册 LLM 服务的上下文。
 * @param config - 已校验的模型 Provider 策略。
 * @param request - 服务拥有的 Session、路由、消息快照与取消信号。
 * @param selectedMessages - Provider 精确选择、用于封装和归因的消息子集。
 * @param titleProvider - 随请求记录的已注册标题 Provider 标识。
 * @returns 规范化的非空标题、精确源 seq 和实际使用的模型路由。
 */
export async function generateSessionTitleWithLlm(
  ctx: Context,
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
  selectedMessages: readonly SessionTitleUserMessage[],
  titleProvider: SessionTitleProviderId,
): Promise<SessionTitleProviderResult> {
  request.signal.throwIfAborted()
  if (selectedMessages.length === 0) {
    throw new Error('session-title-llm: at least one source message is required')
  }
  const framedInput = frameMessages(selectedMessages)
  const inputBytes = Buffer.byteLength(framedInput, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw new Error(`session-title-llm: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`)
  }
  const route = resolveRoute(config, request)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framedInput }],
    source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  })]
  const system = systemPrompt(config)
  using callDeadline = deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    sessionId: request.session.id,
    purpose: 'session-title',
    signal: callDeadline.signal,
  })
  request.session.append('session/title-llm-request', {
    titleProvider,
    messageSeqs: selectedMessages.map(message => message.seq),
    route,
    system,
    messages,
    maxTokens: config.maxOutputTokens,
  })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('session-title-llm: title output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
  return {
    title,
    messageSeqs: selectedMessages.map(message => message.seq),
    model: route,
  }
}
