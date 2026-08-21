// ConversationSnapshot / ConversationNode 是逻辑层提供给 UI 的唯一数据结构。发布约定：
// 每次变化都替换顶层对象，未变子结构保留引用，这是 React.memo 的前提。Chat Node 和
// Location store 是稳定的实时读取器，因此旧快照并非时间点视图。callId/approvalId
// 在这里保留为普通 string，方便时再收窄为实际 brand。

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry/types'
import type { TodoItem } from '@deepseek-ai/dsh-session/types'
import type {
  RpcError, SessionId, SubagentAddress, ToolCallView, ToolResultView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { PendingInteraction } from './pending.ts'
import type { ContextProvenanceView, KnownContextForm } from './context-provenance.ts'
import type {
  ChatConversationViewNode, ConversationTimelineSnapshot, ConversationViewSnapshotStore,
} from '../contract/conversation.ts'
export type { TodoItem }

/** 一次 Provider 调用所记录的请求配置。 */
export interface AssistantRequestConfig {
  provider: string
  model: string
  purpose?: string
  thinking?: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
}

/** 一次已完成请求报告的稳定 Provider/model 身份。 */
export interface AssistantProvenanceView {
  provider: string
  model: string
}

/** 按 UI 关注方式分类的 Assistant 内容 blocks：正文、可折叠推理、Tool 调用卡片头，
 * 或其他 fallback。 */
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'image'; attachment: ImageAttachmentRef }
  | { kind: 'tool-call'; callId: string; name: string; argsRaw: string }
  | { kind: 'other'; block: unknown }

/**
 * core ContentBlock[] → AssistantBlock[]；已完成消息和部分 block-end 共用此分类器。
 * @param content - 原样保留的 core 内容 blocks。
 * @returns 按源顺序排列、经 UI 分类的 blocks。
 */
export function toAssistantBlocks(content: readonly ContentBlock[]): AssistantBlock[] {
  return content.map(toAssistantBlock)
}

/**
 * 对一个 block 分类；ToolCallBlock 的 id/arguments 字段映射为 callId/argsRaw。
 * @param block - 一个 core 内容 block。
 * @returns UI 分类结果。
 */
export function toAssistantBlock(block: ContentBlock): AssistantBlock {
  switch (block.type) {
    case 'text': return { kind: 'text', text: block.text }
    case 'reasoning': return { kind: 'reasoning', text: block.text }
    case 'image': return { kind: 'image', attachment: block.attachment }
    case 'tool-call': return { kind: 'tool-call', callId: String(block.id), name: block.name, argsRaw: block.arguments }
    default: return { kind: 'other', block }
  }
}

/** 一条已完成的用户消息。 */
export interface UserMessageNode {
  kind: 'user'
  seq: number
  /** 源 session 事件的 Unix epoch 毫秒时间。 */
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

/** 用于计算 Assistant 延迟和吞吐量的已记录边界。 */
export interface AssistantTiming {
  /** 匹配的 step/start 时间戳；位于当前事件窗口外时为 null。 */
  stepStartTime: number | null
  /** 首个非空 text/reasoning/tool delta 时间戳；未记录 token delta 时为 null。 */
  firstTokenTime: number | null
  /** 最终 assistant/message 时间戳。 */
  completedTime: number
}

/** 一条已完成的 Assistant 消息，或因中断冻结的流式前缀。 */
export interface AssistantMessageNode {
  kind: 'assistant'
  seq: number
  /**
   * 来自 `assistant/message` 事件的稳定身份。只有根据 chunks 合成、没有持久
   * Assistant 消息的中断 fallback 不带该字段。
   */
  messageId?: MessageId
  /** 源 session 事件的 Unix epoch 毫秒时间；部分内容冻结时取 turn/end 时间。 */
  time: number
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
  usage?: unknown
  provenance?: AssistantProvenanceView
  requestConfig?: AssistantRequestConfig
  /** 根据已记录 step/chunk/message 事件序列得出的计时。 */
  timing?: AssistantTiming
  /** 被中止 turn 的前缀，渲染时显示“已停止”标记。持久完成前缀使用自身事件 seq；
   *  只有 chunk 的 fallback 使用由关闭边界得出的分数 seq，以维持消息流顺序。 */
  interrupted?: true
}

/** Turn 运行期间从 next-step inbox 准入的人类消息。 */
export interface SteeringMessageNode {
  kind: 'steering'
  /** 与准入前 inbox occurrence 共用的稳定消息身份。 */
  messageId: MessageId
  seq: number
  /** 源 session 事件的 Unix epoch 毫秒时间。 */
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

/** 显示在消息流中的 context/system 注入。 */
export interface ContextMessageNode {
  kind: 'context'
  seq: number
  /** 源 session 事件的 Unix epoch 毫秒时间。 */
  time: number
  content: readonly ContentBlock[]
  source: unknown
  /** 从 `source` 投影出的角色和生产者名称（{@link contextProvenance}）。 */
  provenance: ContextProvenanceView
  /** 生产者声明的信息 form（{@link contextForm}）；null 按不透明内容展示。 */
  form: KnownContextForm | null
}

/** 已关闭失败 step 正在等待模型请求重试的持久通知。 */
export type ModelRetryNode = LlmRetryEventData & {
  kind: 'model-retry'
  seq: number
  /** llm/retry session 事件的 Unix epoch 毫秒时间。 */
  time: number
  /**
   * 客户端推导的生命周期：重试 turn 开始前为 scheduled；开始后为 started；若失败
   * turn 先中止则为 cancelled。
   */
  retryState: 'scheduled' | 'started' | 'cancelled'
}

/**
 * 以 error reason 结束的 turn 对应的持久终止失败。该 turn 已结算的重试链单独渲染，
 * 永远不会替换此节点。
 */
export interface TurnErrorNode {
  kind: 'turn-error'
  /** 所属 turn/end 事件的 seq。 */
  seq: number
  /** turn/end 事件的 Unix epoch 毫秒时间。 */
  time: number
  turn: number
  step: number
  message: string
  code?: string
}

/** Turn 因单请求输出 token 上限而结束的持久通知。 */
export interface TurnMaxTokensNode {
  kind: 'turn-max-tokens'
  /** 所属 turn/end 事件的 seq。 */
  seq: number
  /** turn/end 事件的 Unix epoch 毫秒时间。 */
  time: number
  turn: number
  step: number
}

/** Tool 结果；调用头在窗口内时与之配对。 */
export interface ToolResultNode {
  kind: 'tool-result'
  seq: number
  /** tool/result session 事件的 Unix epoch 毫秒时间。 */
  time: number
  callId: string
  /** 从窗口内 tool/call 回填的调用头；窗口截断使调用落在外部时为 null，卡片头显示 callId。 */
  call: { name: string; argsRaw: string } | null
  /** 配对 tool/call 仍在窗口内时的 Unix epoch 毫秒时间，用于计算调用行持续时间。 */
  callTime: number | null
  content: readonly ContentBlock[]
  isError: boolean
  error?: { name: string; code: string }
  meta?: unknown
  /** Host 根据配对 tool/call 传输视图计算的渲染意图；null 表示默认通用 JSON 卡片。 */
  callView: ToolCallView | null
  /** Host 根据本 tool/result 传输视图计算的渲染意图；null 使用同一默认值。 */
  resultView: ToolResultView | null
  /** 本调用拥有的子调用，按分发顺序排列。 */
  subCalls: readonly ToolCallBlock[]
}

/**
 * 一次已经落地的压缩，标记在 checkpoint 自身日志位置。它在模型界面遮蔽的对话仍
 * 保留在其上方记录中；标记只说明模型从何处起不再看到那段历史，并不会替换历史。
 * 带框架的 checkpoint 载荷是写给模型的指令信封，绝不渲染。
 */
export interface CompactionSummaryNode {
  kind: 'compaction'
  /** 落地 checkpoint 的替换 `user/message` seq。 */
  seq: number
  /** checkpoint 事件的 Unix epoch 毫秒时间。 */
  time: number
  /** checkpoint 引用的 `compaction/summary` 事件中的摘要文本；窗口切分使该事件位于
   *  外部时为 null，此时标记不可展开。 */
  summary: string | null
  /** 已加载 `compaction/summary` 事件的 seq；事件位于窗口外时为 null。 */
  summaryEventSeq: number | null
  /** 被替换的界面项数量；摘要事件不可用或格式错误时为 null。 */
  shadowedItemCount: number | null
  /** 被替换项的估算 token 成本；摘要事件不可用或格式错误时为 null。 */
  shadowedTokenCount: number | null
}

/**
 * 本 UI 版本不认识的界面事件所用 fallback。`SessionEventMap` 可通过声明合并扩展，
 * 因此投影 switch 不能以 `assertNever` 结束。目前没有事件会生成此 Node：
 * `isAppendSurfaceEvent` 只接受 core `SurfaceEventType` 中三种类型，且每种都有独立
 * 分支。保留此结构是为了 core 扩大集合时能降级为原始行，而非静默丢弃事件。
 */
export interface UnknownSurfaceNode {
  kind: 'unknown'
  seq: number
  /** 已知时记录源 session 事件的 Unix epoch 毫秒时间。 */
  time: number
  type: string
  data: unknown
}

/**
 * 根据仅写日志的 `command/run` / `command/done` 事件对折叠出的一次斜杠命令生命
 * 周期。事件按 commandId 配对，与 Tool call↔result 对应。仅写日志事件不是界面事件，
 * 因此 command Definition 单独索引，Chat 构建器再按 seq 排列生成的 Node。若窗口在
 * 事件对之间切分，也像 Tool 事件对一样软降级：窗口内只有 done 时仍构建 Node，
 * name/args 为 null；只有 run 时渲染为仍在执行。
 */
export interface CommandNode {
  kind: 'command'
  /** command/run 事件 seq；只有 done 位于窗口内时取 done 事件 seq。 */
  seq: number
  /** 锚定事件的 Unix epoch 毫秒时间。 */
  time: number
  /** Host 执行器生成的配对 ID。 */
  commandId: CommandId
  /** 命令名称，即 run 载荷的结构化字段；run 位于窗口外时为 null。 */
  name: string | null
  /**
   * 名称后的原始 rawInput，保留分隔空白；命令省略参数或 run 位于窗口外时为 null。
   */
  args: string | null
  /** 完成结果，即 done 载荷；命令仍在执行时为 null。 */
  outcome: {
    kind: 'success' | 'error'
    text?: string
    /** 更早的权威业务事件，供客户端计算更丰富的展示。 */
    sourceEventSeq?: number
  } | null
}

/** 已完成对话 Node 联合类型；kind 用于判别，seq 用作 React key。 */
export type ConversationNode =
  | UserMessageNode
  | AssistantMessageNode
  | SteeringMessageNode
  | ContextMessageNode
  | ModelRetryNode
  | TurnErrorNode
  | TurnMaxTokensNode
  | ToolResultNode
  | CommandNode
  | CompactionSummaryNode
  | UnknownSurfaceNode

/** 进行中的 Tool 卡片材料：已看到 tool/call，尚未看到 tool/result。 */
export interface RunningToolCall {
  callId: string
  name: string
  argsRaw: string
  turn: number
  step: number
  /** 记录 tool/call 事件时的 Unix epoch 毫秒时间。 */
  time: number
  /** tool/call 帧携带、由 Host 计算的渲染意图；null 表示通用 JSON 卡片。 */
  callView: ToolCallView | null
  /** 本调用拥有的子调用，按分发顺序排列。 */
  subCalls: readonly ToolCallBlock[]
}

/** 一个运行中或已完成调用，递归拥有其子调用。 */
export type ToolCallBlock = RunningToolCall | ToolResultNode

/** 来自权威 `session/queue` 快照的一条临时 inbox occurrence。 */
export interface QueuedMessage {
  readonly id: MessageId
  /** 从临时 steering 交接到持久消息时使用的稳定消息身份。 */
  readonly messageId: MessageId
  /** Agent 解析的 placement；只有 queued 行接受队列修改。 */
  readonly placement: 'queued' | 'steering' | 'context'
  /** steering 持久化前用于渲染等待状态的完整内容。 */
  readonly content: readonly ContentBlock[]
  readonly preview: string
  /** 完整可编辑文本；消息包含非文本 blocks 时为 null。 */
  readonly text: string | null
}

/** 进行中的 Assistant 输出，即 chunk 累加器产物。 */
export interface PartialAssistant {
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
}

/** Session 窗口打开历史时的生命周期。 */
export type OpenState = 'cold' | 'loading' | 'open' | 'error'

/**
 * OPEN session 的输入区状态，在组装快照时推导；这里只在一个位置掌握判定条件，
 * 消费者只按结果分支，绝不重新推导：
 *
 * - `blank`：权威 blank 标记仍设置，且尚未尝试 Prompt；UI 渲染空白 session 引导区。
 * - `engaging`：已尝试首个 Prompt，但尚未收到已接受 turn 或其他权威活动信号；UI 在
 *   准入和错误帧期间继续显示输入框。
 * - `active`：session 已越过等待中的首个 Prompt，不再空白；或包含可见非命令 Chat
 *   内容、正在运行、拥有等待交互；UI 显示普通对话视图。
 *
 * 首个 Prompt 失败后仍保持 `engaging`，显示输入框和错误条，便于重试；回到引导区会
 * 丢失错误上下文。窗口未打开（`loading`/`error`）的 sessions 不属于本 phase 管辖，
 * 消费者应先按 {@link ConversationSnapshot.openState} 分支。
 */
export type ComposerPhase = 'blank' | 'engaging' | 'active'

/** 输入错误条显示的发送/停止失败；op 决定面向用户的“发送失败”或“停止失败”文案。 */
export interface PromptError {
  op: 'send' | 'stop'
  error: RpcError
}

/**
 * 稳定的实时逐键读取器。旧 ChatSnapshot 也能通过此 store 观察后续刷新。
 */
export interface ChatNodeStore {
  /** @param key - 稳定 Conversation Context 键。@returns 当前 Node，无论可见或隐藏。 */
  get(key: string): ChatConversationViewNode | undefined
  /** @returns 当前全部已实例化 Nodes，不附加渲染顺序。 */
  values(): readonly ChatConversationViewNode[]
}

/**
 * 稳定的实时 Location 索引。旧 ChatSnapshot 也能通过此索引观察后续成员变化。
 */
export interface ChatLocationNodeIndex {
  /** @param turn - 所属 turn。@returns 该 turn 内有序 Chat Node 键。 */
  getTurn(turn: number): readonly string[]
  /** @param turn - 所属 turn。@param step - 所属 step。@returns 该 step 内有序 Chat Node 键。 */
  getStep(turn: number, step: number): readonly string[]
}

/** 支撑 StatsLine 和旧顶层快照字段的兼容投影。 */
export interface LegacyConversationSlice {
  readonly nodes: readonly ConversationNode[]
  readonly turnTimings: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number }>
  readonly turnEnds: ReadonlyMap<number, number>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}

/** 带不可变顺序和稳定实时逐键读取器的增量 Chat 发布。 */
export interface ChatSnapshot {
  readonly order: readonly string[]
  readonly nodes: ChatNodeStore
  readonly locations: ChatLocationNodeIndex
  readonly timeline: ConversationTimelineSnapshot
  readonly legacy: LegacyConversationSlice
}

const EMPTY_LIST: readonly never[] = []
const EMPTY_TIMELINE: ConversationTimelineSnapshot = { turnOrder: EMPTY_LIST, turns: new Map() }

/** fixture 和没有已注册视图的 Sessions 使用的空 target store。 */
export const EMPTY_CONVERSATION_VIEWS: ConversationViewSnapshotStore = {
  get: () => undefined,
}

/** 注册视图构建器前使用的空 Chat target。 */
export const EMPTY_CHAT_SNAPSHOT: ChatSnapshot = {
  order: EMPTY_LIST,
  nodes: {
    get: () => undefined,
    values: () => EMPTY_LIST,
  },
  locations: {
    getTurn: () => EMPTY_LIST,
    getStep: () => EMPTY_LIST,
  },
  timeline: EMPTY_TIMELINE,
  legacy: {
    nodes: EMPTY_LIST,
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: EMPTY_LIST,
  },
}

/** Session 交给 uSES 的不可变快照接口；参见 Web 客户端架构 RFC。 */
export interface ConversationSnapshot {
  sessionId: SessionId
  /** 根据 Session 事件组装的已注册 target 快照。 */
  views: ConversationViewSnapshotStore
  /** 根据独立注册业务 Definitions 组装的最终 Chat target。 */
  chat: ChatSnapshot
  /** 从已注册 Chat Definitions 镜像的旧顶层兼容字段。 */
  nodes: readonly ConversationNode[]
  /** 窗口内准确的 `turn/start` 时间及可选匹配 `turn/end` 时间。 */
  turnTimings: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number }>
  /** 窗口内已完成 turn 编号 → 对应 `turn/end` 事件 seq。 */
  turnEnds: ReadonlyMap<number, number>
  partial: PartialAssistant | null
  runningCalls: readonly RunningToolCall[]
  pending: readonly PendingInteraction[]
  /** 权威临时 inbox 快照，包括 queued 和 steering placement。 */
  queue: readonly QueuedMessage[]
  running: boolean
  /**
   * 通过目录发现的 continuation 地址。父级可用性控制人类输入；null 表示普通 session
   * 传输。
   */
  subagent: { address: SubagentAddress; parentAvailable: boolean } | null
  /** 输入区状态，见 {@link ComposerPhase}；在此推导，消费者只按值分支。 */
  composerPhase: ComposerPhase
  /** 收到 host/session-removed 后设置；UI 置灰并禁用输入。 */
  removed: boolean
  openState: OpenState
  openError: RpcError | null
  hasMore: boolean
  loadingOlder: boolean
  promptError: PromptError | null
  /**
   * 本 session 日志是否仍为空，即尚无用户消息。该字段镜像 Host 摘要推导出的 blank
   * 标记：初值来自 `session.list` 或 `host/session-added` 帧；本地首个已接受 Prompt
   * 的 RPC 成功响应会将其置为 false，因为接受意味着用户消息已进入 Host 日志；被拒
   * 的首个 Prompt 仍保持 session 空白且可复用。远端任意 `running: true` 状态也会置为
   * false。每次重新拉取列表都会按摘要重新对齐，因为摘要始终是权威来源。空白
   * sessions 会从列表隐藏，并由 New Session 复用。
   */
  blank: boolean
  lastAgentError: string | null
}
