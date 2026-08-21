/**
 * 冻结的输入状态机约定，只包含类型。它分三层可见：业务包通过 InputZone 数据
 * 读取 InputState；限定作用域的输入事件携带变更操作；只有会话接线层能看到完整
 * SessionInput。InputMachine（machine.ts）是包内实现，永不导出。
 */
import type { ClientContext, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  ArbitrateKey, ArbitrateOutcome, CommandClaim, ConsumeTokenRequest, PickOutcome,
  ReferenceInsert, SubmitOutcome, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { QueueRow } from '../contract/queue.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'

/** 一张尚未发送的图片草稿在浏览器运行时中的身份。 */
export type DraftAttachmentId = Branded<'DraftAttachmentId'>

/**
 * 限定作用域事件的应用操作：hub 的 bail 监听器调用它们，布尔返回值就是事件的
 * bail 值；true 当且仅当状态机通过阶段及区间/裸词元保护后接受了操作。
 */
export interface InputTarget {
  /** 用 claim.token 替换触发区间并进入 claimed 阶段（带区间 CAS）。 */
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean
  /** 用一个引用实例替换触发区间（带区间 CAS）。 */
  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean
}

/** 由会话接线层拥有的每会话输入门面。 */
export interface SessionInput extends InputTarget {
  /** 草稿文本的唯一写入路径，所有变更都经由状态机事件。 */
  setDraft(text: string): void
  /** 追加有序的浏览器所拥有图片 ID；准入繁忙阶段会拒绝。 */
  addImages(ids: readonly DraftAttachmentId[]): boolean
  /** 移除一个浏览器所拥有图片 ID；准入繁忙阶段会拒绝。 */
  removeImage(id: DraftAttachmentId): void
  /** 丢弃已找不到对应浏览器对象的 ID。 */
  pruneImages(ids: readonly DraftAttachmentId[]): void
  /**
   * 复杂度的集中出口：回车裁决、提交事务和默认出口都封装在内部。
   * @param mode - 在异步裁决和序列化期间保持不变的投递意图。
   */
  submit(mode?: InputSubmitMode): void
  /**
   * 在状态机自身的 effect 流之外显示提示：脱离原调用栈的命令结果和业务通知都
   * 从这里渲染。它按会话路由：通过 SessionInputResolver.for(actx) 解析门面，
   * 会把提示送到该会话的编辑器，因此切换会话后才到达的结果仍会返回所属会话。
   * @param level - 严重程度。
   * @param text - 提示正文。
   */
  notify(level: 'info' | 'error', text: string): void
  /** 输入状态存储；InputZone 数据和装饰层从这里读取。 */
  readonly state: SnapshotStore<InputState>
}

/** 按会话寻址的每会话输入门面访问入口。 */
export interface SessionInputResolver {
  /** 为一个会话作用域 ctx 解析门面。 */
  for(actx: ClientContext): SessionInput
}

/**
 * 提供给每个会话作用域 Slot 组件的公共输入操作接口：由稳定身份的无返回值回调
 * 构成，与 useStore + actions 约定一致。命令式句柄（track/arbitrate/space/
 * undo/paste/…）只供 InputBar 使用，绝不会通过此接口暴露。
 */
export interface InputActions {
  /** 唯一公开草稿写入路径：传入完整新草稿，引用实例区间通过 diff 扫描计算。 */
  setDraft(text: string): void
  /** 追加有序的浏览器所拥有图片 ID；准入繁忙阶段会拒绝。 */
  addImages(ids: readonly DraftAttachmentId[]): boolean
  /** 移除一个浏览器所拥有图片 ID；准入繁忙阶段会拒绝。 */
  removeImage(id: DraftAttachmentId): void
  /** 丢弃已找不到对应浏览器对象的 ID。 */
  pruneImages(ids: readonly DraftAttachmentId[]): void
  /** 进入提交；内部完成裁决、认领事务和默认出口处理。 */
  submit(): void
}

/** 一条已显示提示（命令结果、裁决失败）；seq 用于让重复提示重新渲染。 */
export interface InputNotice {
  readonly level: 'info' | 'error'
  readonly text: string
  readonly seq: number
}

/**
 * InputBar 专用的键盘/DOM 命令接口：它包含同步返回值和事件处理器语义，不能进入
 * 公共 provide 通道。该接口通过 composer-bar 条目自身的 inject 传入，只在包内
 * 使用，绝不跨插件边界；会话外壳以结构类型满足它。
 */
export interface ComposerKeyboard {
  /** 供事件处理器读取的实时状态机状态；渲染读取必须经过 useInput。 */
  readonly snapshot: InputState
  /** 携带 DOM 观测到的编辑范围写入草稿，以缩小引用实例计算范围。 */
  setDraft(text: string, editRange?: EditRange): void
  /** 使用键盘策略解析出的显式投递模式提交。 */
  submit(mode: InputSubmitMode): void
  /**
   * 把所有仍待处理的排队消息引导进当前运行中的轮次；这是空草稿加速回车手势，
   * 等价于把队列停靠栏逐行的 steer 操作应用到整个队列。
   */
  steerQueue(): void
  undo(): void
  redo(): void
  /** 覆盖选区粘贴；同步识别出的组件参与同一事务。 */
  pasteBegin(text: string, selection: EditSelection, components?: readonly PasteComponent[], generation?: number): void
  /** 状态机无法观测的光标/选区手势会结束粘贴尝试。 */
  invalidatePaste(): void
  /** 把草稿/光标变化送入触发检测；保护条件由阶段推导。 */
  track(draft: string, caret: number): void
  /** 菜单打开时进行键盘裁决；未挂载流水线时返回 'pass'。 */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome
  /** 空格裁决；true 表示输入已应用认领，调用方应阻止默认行为。 */
  space(): boolean
  /** 关闭 popupSelect 外壳，用于框外发生的任意交互。 */
  dismissPopup(): void
}

/** 从临时队列快照投影出的、可独立寻址的一行。 */
export type QueuedMessage = QueueRow

/** 限定作用域 consume-token 事件的保护条件联合，由状态机检查。 */
export type ConsumeTokenGuard = ConsumeTokenRequest['guard']

/** 草稿字符坐标中的半开区间/选区 `[start, end)`。 */
export interface EditSelection {
  readonly start: number
  readonly end: number
}

/**
 * 应用于旧草稿的一次编辑：旧草稿坐标中的 `[start, end)` 被 insertedLength 个
 * 字符替换。DOM 事件能提供编辑范围时由接线层传入；否则状态机通过公共前后缀
 * 扫描 diff 恢复。
 */
export interface EditRange extends EditSelection {
  readonly insertedLength: number
}

/**
 * 一个引用实例，其完整行内展示文本保存在草稿中。身份是 occurrenceId，因此同名
 * 引用仍可独立寻址。label/appearance/clipboardText 是拥有者插入时给出的投影，
 * 会被缓存，使胶囊在拥有者丢失后仍保留，只切换 invalid 而不删除实例。
 */
export interface Occurrence {
  /** 状态机签发的稳定身份，在每个状态机内单调递增。 */
  readonly occurrenceId: number
  /** 所属来源名称，也是序列化器路由键。 */
  readonly source: string
  /** 拥有者作用域内的引用 ID。 */
  readonly ref: string
  /** 展示文本在草稿中的偏移量。 */
  readonly offset: number
  /** 展示文本长度；实例恰好占据 `[offset, offset+length)`。 */
  readonly length: number
  /** 行内展示标签，在插入时缓存。 */
  readonly label: string
  /** 可选领域图标，在插入时缓存。 */
  readonly appearance?: ReferenceInsert['appearance']
  /** 剪贴板/持久化投影，如 `/name`；插入时缓存，绝不是模型表示。 */
  readonly clipboardText: string
  /** 拥有者解析失败标记：胶囊显示为无效，序列化必须失败。 */
  readonly invalid?: boolean
}

/** 一个同步匹配的粘贴组件；start/end 相对于粘贴文本。 */
export interface PasteComponent extends EditSelection {
  readonly reference: ReferenceInsert
}

/**
 * 异步匹配仍可能把粘贴词元升级为引用时发布的实时粘贴匹配尝试，也就是剪贴板往返。
 * 任意非粘贴事务、开始提交、invalidate-paste 或释放都会结束它；paste-upgrade
 * 则保持尝试有效，后续词元针对已推进的 draftRev 重新执行 CAS。
 */
export interface PasteAttemptState {
  /** 状态机签发的尝试身份；paste-upgrade 必须与之匹配。 */
  readonly attemptId: number
  /** 粘贴事务发生时，粘贴内容在草稿中的区间。 */
  readonly insertedRange: EditSelection
  /** 原样回传调用方提供的投影代次；控制器会丢弃跨代结果。 */
  readonly generation: number
}

/**
 * InputMachine 的构造参数。状态机绝不读取环境时钟；`now` 是唯一时间来源，由
 * 外壳注入，测试可注入假时钟。默认时钟是常量，因此连续单字符输入会一直合并，
 * 直到出现非输入事务。
 */
export interface InputMachineOptions {
  /** 单字符输入合并为一次撤销的时间窗口，单位毫秒，默认 1000。 */
  readonly mergeWindowMs?: number
  /** 用于输入合并判断的单调时钟，默认为常量 0。 */
  readonly now?: () => number
}

/** 已发布的每会话输入状态，也是跨层传递的数据。 */
export interface InputState {
  readonly draft: string
  /** 仅运行时存在的有序图片 ID；字节和 URL 保留在 ConversationController 中。 */
  readonly imageIds: readonly DraftAttachmentId[]
  /** 单调递增的草稿修订号，区间 CAS 与之比较。 */
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  /** 仅在 claimed/submitting 阶段存在；在途时保存认领快照，但不暴露提交闭包。 */
  readonly claim?: { readonly token: string; readonly hint?: string; readonly images?: boolean }
  /** 按偏移量排序的引用实例表。 */
  readonly occurrences: readonly Occurrence[]
  /** 实时粘贴匹配尝试；没有可匹配粘贴时不存在。 */
  readonly paste?: PasteAttemptState
  /** 只读的临时收件箱投影（`session/queue`，包括待执行的 steer）。 */
  readonly queue: readonly QueuedMessage[]
}

/**
 * 一次在途提交尝试，是提交平面唯一的 ID 概念。按回车时创建，由 adjudicated/
 * submit-settled 事件携带；过期尝试会被丢弃，避免旧结果回灌。release 或会话销毁
 * 会取消当前尝试，使 Promise 生命周期有界。
 */
export interface SubmitAttempt {
  readonly seq: number
  readonly signal: AbortSignal
  /** 回车时的草稿；只有接受成功后，结算才会清除它。 */
  readonly draftSnapshot: string
  /** 斜杠裁决待定期间保留的默认消息投递意图。 */
  readonly mode: InputSubmitMode
}

/**
 * InputMachine 输入事件，也是状态机唯一写入路径。每次草稿变更都是一个事务：
 * 草稿编辑、引用实例协调和撤销日志入栈在 dispatch() 内原子完成。带 `at` 的事件
 * 记录注入时钟读数，只有单字符输入合并会读取它。
 */
export type InputEvent =
  /** textarea 给出的完整新草稿；editRange 缩小实例计算范围，缺失时扫描 diff。 */
  | { readonly type: 'draft-changed'; readonly draft: string; readonly editRange?: EditRange }
  | { readonly type: 'begin-command'; readonly claim: CommandClaim; readonly span: TokenSpan }
  /** 在区间放置行内引用并签发实例；对应限定作用域的 insert-reference 事件载荷。 */
  | { readonly type: 'insert-ref'; readonly reference: ReferenceInsert; readonly span: TokenSpan }
  /** 删除已结算的命令词元；draftRev 推进表示成功。 */
  | { readonly type: 'consume-token'; readonly guard: ConsumeTokenGuard }
  /** 拥有者解析结果：只有列出的实例无效；这是样式位，不是事务。 */
  | { readonly type: 'set-invalid'; readonly invalidIds: readonly number[] }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  /**
   * 用粘贴文本替换选区，作为一个事务。热快照同步匹配项以组件形式传入，胶囊在
   * 同一事务内签发，因此一次撤销即可回到粘贴前；异步剩余部分则开启
   * PasteMatchAttempt。组件区间必须互不相交且位于粘贴文本内。
   */
  | { readonly type: 'paste-begin'; readonly text: string; readonly selection: EditSelection; readonly components?: readonly PasteComponent[]; readonly generation?: number }
  /** 异步匹配完成：以独立事务把一个粘贴词元升级为胶囊；撤销一次回文本，再次回粘贴前。 */
  | { readonly type: 'paste-upgrade'; readonly attemptId: number; readonly span: TokenSpan; readonly reference: ReferenceInsert }
  /** 外壳观测到、而状态机自身看不到的尝试终止信号，如光标/选区操作和 Slash 交互更新。 */
  | { readonly type: 'invalidate-paste' }
  | { readonly type: 'enter'; readonly mode: InputSubmitMode }
  | { readonly type: 'adjudicated'; readonly attempt: SubmitAttempt; readonly outcome: PickOutcome }
  | { readonly type: 'adjudication-failed'; readonly attempt: SubmitAttempt; readonly message: string }
  | { readonly type: 'submit-settled'; readonly attempt: SubmitAttempt; readonly ok: boolean; readonly outcome?: SubmitOutcome; readonly message?: string }
  /** 提交一次纯图片发送；其空草稿无需创建提交尝试。 */
  | { readonly type: 'send-committed' }
  | { readonly type: 'release' }

/**
 * InputMachine 输出 effect，由 SessionInput 外壳执行，状态机保持纯净。草稿/实例
 * 变更不携带 effect；外壳会在每次 dispatch 后发布状态存储。
 */
export type InputEffect =
  | { readonly type: 'adjudicate'; readonly attempt: SubmitAttempt; readonly draft: string }
  | { readonly type: 'begin-submit'; readonly attempt: SubmitAttempt; readonly claim: CommandClaim; readonly args: string }
  | { readonly type: 'default-sink'; readonly attempt: SubmitAttempt; readonly draft: string; readonly mode: InputSubmitMode }
  | { readonly type: 'notice'; readonly level: 'info' | 'error'; readonly text: string }
