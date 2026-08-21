/**
 * 纯输入状态机之上的 SessionInput 外壳：它是唯一的状态机调用者和 effect 执行者。
 * 它拥有 InputState 存储（状态机状态加队列叠加层）、提示通道和提交事务接线，
 * 包括经会话 InputTriggerController 裁决、调用 claim.submit 和进入默认出口。
 * 此类只在包内可见，仅由 hub 构造并接入限定作用域的事件监听器。
 */
import type { ClientContext, ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ArbitrateKey, ArbitrateOutcome, CommandClaim, ConsumeTokenRequest, PickOutcome,
  ReferenceInsert, InputTriggerController, SubmitImageAttachment, SubmitOutcome, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  DraftAttachmentId, EditRange, EditSelection, InputActions, InputEffect, InputNotice, InputState,
  PasteComponent, QueuedMessage, SessionInput, SubmitAttempt,
} from './contract.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import { InputMachine, projectClipboard } from './machine.ts'

/** 外壳需要的弹窗接口；只负责关闭，并以结构类型避免值导入。 */
export interface PopupDismissFace {
  dismiss(): void
}

/**
 * 一个门面的构造依赖。slash/popup 接口使用 thunk：外壳在 sessions provide
 * 实体化期间创建，此时作用域记录尚不可查询，`slash.sessionOf`/`command.popupFor`
 * 还无法解析，因此延迟到首次交互时再解析。
 */
export interface SessionInputDeps {
  /** 传给 claim.submit 事务的会话作用域 ctx。 */
  actx: ClientContext
  /** 回车裁决接口解析器；缺失或返回 undefined 时，每个 '/' 行都进入默认出口。 */
  inputTriggers?: (() => InputTriggerController | undefined) | undefined
  /** PopupSelect 外壳接口解析器；提交锁定或 Escape 时用于关闭。 */
  popup?: (() => PopupDismissFace | undefined) | undefined
  /** 队列读取接口，叠加到 InputState.queue；缺失时为空。 */
  queue?: ObservableSnapshot<readonly QueuedMessage[]> | undefined
  /**
   * 按 FIFO 顺序把所有仍待处理的排队消息引导进运行中的轮次，即空草稿加速回车
   * 手势；缺失表示不支持。
   */
  steerQueue?: (() => void) | undefined
  /** 普通消息出口；发送编排/实体化分支由 hub 拥有。 */
  defaultSink(
    text: string,
    imageIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
  ): Promise<SubmitOutcome>
  /** 命令平面的图片接线；会话接口和文案由 hub 拥有。 */
  commandImages: {
    /** 把有序草稿 ID 解析为线协议载荷但不发送；任一 ID 无法解析时拒绝。 */
    serialize(ids: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]>
    /** 命令提交成功后释放已消费的草稿图片。 */
    release(ids: readonly DraftAttachmentId[]): void
    /** 已认领命令不接受图片时使用的本地化编辑器提示。 */
    unsupportedNotice(token: string): string
  }
}

/** 根据状态机阶段得到保护级别。 */
function guardOf(phase: InputState['phase']): 'plain' | 'claimed' | 'frozen' {
  switch (phase) {
    case 'plain': return 'plain'
    case 'claimed': return 'claimed'
    default: return 'frozen' // adjudicating / submitting
  }
}

const EMPTY_QUEUE: readonly QueuedMessage[] = []

/** 未挂载流水线时的词典，不产生文本引用装饰。 */
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

/**
 * 每会话输入门面：限定作用域事件应用操作、setDraft/submit，以及已发布的
 * InputState 存储。
 */
export class SessionInputShell implements SessionInput {
  /** 已发布的状态机状态和队列叠加层，也是 InputZone 数据来源。 */
  readonly state: SnapshotStore<InputState>
  /** 最近显示的提示，清除后为 null；输入栏以横幅显示错误、以内联形式显示信息。 */
  readonly notices: SnapshotStore<InputNotice | null> = createSnapshotStore<InputNotice | null>(null)
  /** 公共 provide 通道操作接口；每个会话拥有一个稳定身份。 */
  readonly actions: InputActions = {
    setDraft: (text) => { this.setDraft(text) },
    addImages: ids => this.addImages(ids),
    removeImage: (id) => { this.removeImage(id) },
    pruneImages: (ids) => { this.pruneImages(ids) },
    submit: () => { this.submit('queue') },
  }

  // 使用真实墙上时钟：生产环境中的连续输入合并窗口必须真正过期；状态机为纯测试
  // 提供的无时钟默认值是常量。
  private readonly core = new InputMachine({ now: () => Date.now() })
  private noticeSeq = 0
  private lastMirroredDraft = ''
  private imageIds: readonly DraftAttachmentId[] = []
  /** 同时只允许一次纯图片发送；Host 往返期间按回车不产生效果。 */
  private imageSendInFlight = false
  private disposed = false
  /** 草稿持久化镜像；写入聊天存储，接收剪贴板投影而不是仅供展示的区间。 */
  private mirrorFn: ((text: string) => void) | undefined

  constructor(private readonly deps: SessionInputDeps) {
    this.state = createSnapshotStore<InputState>(this.compose())
    deps.queue?.subscribe(() => { this.publish() })
  }

  // ---- SessionInput 接口 ----

  /**
   * 草稿的唯一写入路径，所有变更都经由状态机事件。
   * @param text - 完整新草稿。
   * @param editRange - 调用方已知时传入 DOM 观测到的编辑范围，用于缩小状态机
   * 实例计算范围；缺失时扫描 diff。
   */
  setDraft(text: string, editRange?: EditRange): void {
    this.run(this.core.dispatch({ type: 'draft-changed', draft: text, ...(editRange !== undefined ? { editRange } : {}) }))
  }

  /** 准入事务未锁定时追加有序图片 ID。 */
  addImages(ids: readonly DraftAttachmentId[]): boolean {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return false
    if (ids.length === 0) return true
    this.imageIds = [...this.imageIds, ...ids]
    this.publish()
    return true
  }

  /**
   * 从草稿移除一个图片 ID。与 {@link addImages} 一样，准入繁忙阶段会拒绝；
   * 否则，命令提交序列化期间到达的移除会让图片从附件栏消失，却仍随在途发送提交。
   */
  removeImage(id: DraftAttachmentId): void {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return
    const next = this.imageIds.filter(candidate => candidate !== id)
    if (next.length === this.imageIds.length) return
    this.imageIds = next
    this.publish()
  }

  /**
   * 只保留仍能在浏览器附件注册表中解析的图片 ID。
   * @param available - 注册表中的实时 ID。
   */
  pruneImages(available: readonly DraftAttachmentId[]): void {
    const keep = new Set(available)
    const next = this.imageIds.filter(id => keep.has(id))
    if (next.length === this.imageIds.length) return
    this.imageIds = next
    this.publish()
  }

  /**
   * 把清空草稿作为发送成功提交：不记录撤销单元并切断撤销历史，使 Ctrl/Cmd-Z
   * 无法复活已发送内容；命令路径在 submit-settled 成功时遵循同一规则。
   * @param imageIds - 要从草稿移除的已准入图片 ID。
   */
  commitSend(imageIds: readonly DraftAttachmentId[]): void {
    const submitted = new Set(imageIds)
    this.imageIds = this.imageIds.filter(id => !submitted.has(id))
    this.run(this.core.dispatch({ type: 'send-committed' }))
  }

  /** 撤销最近事务；平台快捷键由 InputBar 拦截。 */
  undo(): void {
    this.run(this.core.dispatch({ type: 'undo' }))
  }

  /** 重做最近被撤销的事务。 */
  redo(): void {
    this.run(this.core.dispatch({ type: 'redo' }))
  }

  /**
   * 在一个事务中用粘贴文本覆盖选区，并在其中组件化热快照同步匹配项。
   * @param text - 粘贴的纯文本。
   * @param selection - 草稿坐标中被替换的选区。
   * @param components - 同步匹配的引用组件；互不相交且位于 `text` 内。
   * @param generation - 用于防止迟到异步升级的投影代次。
   */
  pasteBegin(text: string, selection: EditSelection, components?: readonly PasteComponent[], generation?: number): void {
    this.run(this.core.dispatch({
      type: 'paste-begin', text, selection,
      ...(components !== undefined ? { components } : {}),
      ...(generation !== undefined ? { generation } : {}),
    }))
  }

  /** 结束实时粘贴匹配尝试，用于状态机看不到的光标/选区操作和 Slash 更新。 */
  invalidatePaste(): void {
    this.run(this.core.dispatch({ type: 'invalidate-paste' }))
  }

  /**
   * 回车裁决、提交事务和默认出口。effect 从状态机扇出，此方法只负责送入事件。
   * 进入锁定阶段（adjudicating/submitting）会强制关闭临时层：关闭弹窗，并让菜单
   * 以 frozen 状态继续跟踪。
   */
  submit(mode: InputSubmitMode = 'queue'): void {
    if (this.snapshot.draft.trim() === '' && this.imageIds.length > 0) {
      if (this.snapshot.phase === 'plain' && !this.imageSendInFlight) {
        const imageIds = [...this.imageIds]
        this.imageSendInFlight = true
        void this.deps.defaultSink('', imageIds, mode, new AbortController().signal).then((outcome) => {
          this.imageSendInFlight = false
          if (this.disposed) return
          if (outcome.kind === 'success') this.commitSend(imageIds)
          else if (outcome.text !== undefined) this.notify('error', outcome.text)
        }, (error: unknown) => {
          this.imageSendInFlight = false
          if (!this.disposed) this.notify('error', error instanceof Error ? error.message : String(error))
        })
      }
      return
    }
    // claimed 前置门：未声明接受图片的认领在仍有图片附件时绝不提交；只显示一次
    // 提示并保留全部内容。回车裁决时，命令来源自身对未认领文本行应用同一策略。
    const before = this.snapshot
    if (before.phase === 'claimed' && this.imageIds.length > 0 && before.claim?.images !== true) {
      this.notify('error', this.deps.commandImages.unsupportedNotice(before.claim?.token ?? before.draft))
      return
    }
    this.run(this.core.dispatch({ type: 'enter', mode }))
    const phase = this.snapshot.phase
    if (phase === 'adjudicating' || phase === 'submitting') {
      this.deps.popup?.()?.dismiss()
      this.deps.inputTriggers?.()?.track(this.snapshot.draft, 0, { tier: 'frozen' }, this.snapshot.draftRev)
    }
  }

  /**
   * 把草稿/光标变化送入触发检测，保护条件由状态机阶段推导。
   * @param draft - 实时草稿文本。
   * @param caret - 光标在草稿坐标中的位置。
   */
  track(draft: string, caret: number): void {
    this.deps.inputTriggers?.()?.track(draft, caret, { tier: guardOf(this.snapshot.phase) }, this.snapshot.draftRev)
  }

  /**
   * 菜单打开时的键盘裁决。
   * @param key - 被拦截的按键。
   * @param composing - IME 组合输入保护状态。
   * @returns 菜单裁决；未挂载流水线时为 'pass'。
   */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome {
    return this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? 'pass'
  }

  /**
   * 把所有仍待处理的排队消息引导进运行中的轮次，即空草稿加速回车手势。执行由
   * hub 的队列编排负责；缺少依赖时，手势退回状态机的空草稿无操作。
   */
  steerQueue(): void {
    this.deps.steerQueue?.()
  }

  /**
   * 基于控制器热状态执行空格裁决。
   * @returns true 表示已应用认领/插入，调用方应阻止默认行为。
   */
  space(): boolean {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) return false
    const consumed = inputTriggers.onSpace()
    // 状态机驱动的草稿替换不会经过 onChange，因此重新跟踪；光标落在词元后，
    // 检测会看到空白并关闭菜单。
    if (consumed) {
      const next = this.snapshot
      inputTriggers.track(next.draft, next.draft.length, { tier: guardOf(next.phase) }, next.draftRev)
    }
    return consumed
  }

  /** 关闭 popupSelect 外壳，用于框外发生的任意交互。 */
  dismissPopup(): void {
    this.deps.popup?.()?.dismiss()
  }

  /**
   * 装饰扫描使用的热纯文本引用词典来源（决策见
   * .agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md）。
   * 它委托给控制器的聚合存储；每个外壳中的身份稳定。没有流水线时，快照为空 Map，
   * 订阅者永远不会触发。
   */
  readonly lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>> = {
    getSnapshot: () => this.deps.inputTriggers?.()?.lexicon.getSnapshot() ?? EMPTY_LEXICON,
    subscribe: fn => this.deps.inputTriggers?.()?.lexicon.subscribe(fn) ?? (() => {}),
  }

  /**
   * 应用一次命令认领，即限定作用域 begin-command 事件监听器主体。
   * @param claim - 选择路径产生的命令认领。
   * @param span - 选择时的区间快照。
   * @returns 状态机是否接受，即阶段和区间 CAS 通过且草稿确实变化。
   */
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean {
    const before = this.core.state.draftRev
    this.run(this.core.dispatch({ type: 'begin-command', claim, span }))
    return this.core.state.phase === 'claimed' && this.core.state.draftRev !== before
  }

  /**
   * 应用一次引用插入，即限定作用域 insert-reference 事件监听器主体。
   * @param ref - 选择路径产生的引用插入。
   * @param span - 选择时的区间快照。
   * @returns 状态机是否接受。
   */
  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean {
    const before = this.core.state.draftRev
    this.run(this.core.dispatch({ type: 'insert-ref', reference: ref, span }))
    return this.core.state.draftRev !== before
  }

  /**
   * 业务成功后消费一个命令词元，即限定作用域 consume-token 事件监听器主体。
   * 区间保护先做修订号 CAS 再拼接；裸词元保护先比较去空白草稿再清除。
   * @param guard - 精确区间或裸词元保护条件。
   * @returns 是否已消费词元。
   */
  consumeToken(guard: ConsumeTokenRequest['guard']): boolean {
    const snapshot = this.core.state
    if (guard.kind === 'span') {
      if (guard.span.draftRev !== snapshot.draftRev) return false
      const draft = snapshot.draft
      this.setDraft(draft.slice(0, guard.span.start) + draft.slice(guard.span.end))
      return true
    }
    if (snapshot.draft.trim() !== guard.token) return false
    this.setDraft('')
    return true
  }

  /**
   * 在选择时区间插入纯引用文本，即限定作用域 insert-text 事件监听器主体，对应
   * web-input-machine 说明中的纯文本引用决策。与 consume-token 区间分支一样，
   * 先 CAS 再拼接；状态机看到的是普通 draft-changed 事务（一次撤销），不签发实例，
   * 胶囊外观只是扫描派生的装饰，绝不是状态。
   * @param text - 要拼入的纯引用文本，如 `/name `。
   * @param span - 选择时区间快照，用于 draftRev CAS。
   * @param keepCompleting - 拼接后在光标处重新跟踪，让仍开放的词元（如目录选择
   * 末尾斜杠）重新打开菜单。
   * @returns 是否已应用文本。
   */
  insertText(text: string, span: TokenSpan, keepCompleting = false): boolean {
    const snapshot = this.core.state
    if (span.draftRev !== snapshot.draftRev) return false
    const draft = snapshot.draft
    this.setDraft(draft.slice(0, span.start) + text + draft.slice(span.end))
    if (keepCompleting) {
      // 状态机驱动的草稿替换不会经过 onChange，因此在仍开放词元内的光标处重新
      // 跟踪，参见 space()。
      const next = this.snapshot
      this.deps.inputTriggers?.()?.track(next.draft, span.start + text.length, { tier: guardOf(next.phase) }, next.draftRev)
    }
    return true
  }

  /**
   * 显示来自状态机外部的提示，例如脱离原调用栈的命令结果。
   * @param level - 严重程度。
   * @param text - 提示正文。
   */
  notify(level: 'info' | 'error', text: string): void {
    this.noticeSeq += 1
    this.notices.set({ level, text, seq: this.noticeSeq })
  }

  // ---- 接线层附加能力，不属于冻结的 SessionInput 接口 ----

  /** 销毁：取消所有在途尝试，并停止接受异步结算。 */
  dispose(): void {
    this.disposed = true
    this.run(this.core.dispatch({ type: 'release' }))
  }

  /** 读取实时状态机状态；保护条件从这里推导。 */
  get snapshot(): InputState {
    return this.state.getSnapshot()
  }

  /**
   * 绑定草稿持久化镜像，即聊天存储写入。绑定时接纳：存储草稿可能保存上次挂载的
   * 持久化值；调用方在绑定前通过 setDraft 初始化，此后每个被状态机接纳的草稿
   * 都会向外镜像。
   * @param write - 存储草稿写入函数。
   * @returns 解绑清理函数。
   */
  bindMirror(write: (text: string) => void): () => void {
    this.mirrorFn = write
    return () => {
      if (this.mirrorFn === write) this.mirrorFn = undefined
    }
  }

  // ---- effect 执行器 ----

  private run(effects: readonly InputEffect[]): void {
    for (const fx of effects) this.execute(fx)
    this.publish()
  }

  private execute(fx: InputEffect): void {
    switch (fx.type) {
      case 'notice': {
        this.noticeSeq += 1
        this.notices.set({ level: fx.level, text: fx.text, seq: this.noticeSeq })
        return
      }
      case 'adjudicate': {
        this.adjudicate(fx.attempt, fx.draft)
        return
      }
      case 'begin-submit': {
        this.beginSubmit(fx.attempt, fx.claim, fx.args)
        return
      }
      case 'default-sink': {
        this.sinkSerialized(fx.attempt, fx.draft, fx.mode)
        return
      }
      default:
        return // 状态机内部 effect；镜像随 publish 更新
    }
  }

  /**
   * 进入出口前进行提示词序列化：通过会话控制器的编解码器路由，把每个行内引用
   * 区间展开为拥有者定义的模型表示。拥有者缺失、序列化失败或已销毁都会阻止发送，
   * 同时保留提示、草稿和胶囊，绝不静默降级成剪贴板文本。没有胶囊的草稿跳过
   * 这段异步路径。
   */
  private sinkSerialized(attempt: SubmitAttempt, draft: string, mode: InputSubmitMode): void {
    const imageIds = [...this.imageIds]
    const occurrences = this.core.state.occurrences
    if (occurrences.length === 0) {
      this.settleSubmit(attempt, this.deps.defaultSink(draft.trim(), imageIds, mode, attempt.signal), imageIds)
      return
    }
    const inputTriggers = this.deps.inputTriggers?.()
    const controller = new AbortController()
    void Promise.all(occurrences.map(async (o) => {
      if (inputTriggers === undefined) throw new Error(`no serializer for reference source "${o.source}"`)
      return {
        offset: o.offset,
        length: o.length,
        text: await inputTriggers.serializeReference(o.source, o.ref, controller.signal),
      }
    })).then(
      (parts) => {
        if (this.disposed) return
        // 在展示区间上拼入模型表示；偏移量来自草稿时刻，实例表已排序，因此 parts
        // 也按偏移量到达。
        let out = ''
        let cursor = 0
        for (const part of parts) {
          out += draft.slice(cursor, part.offset) + part.text
          cursor = part.offset + part.length
        }
        out += draft.slice(cursor)
        this.settleSubmit(attempt, this.deps.defaultSink(out.trim(), imageIds, mode, attempt.signal), imageIds)
      },
      (error: unknown) => {
        controller.abort()
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.run(this.core.dispatch({ type: 'submit-settled', attempt, ok: false, message }))
      },
    )
  }

  /** 结算一次准入尝试；成功发送只消费该尝试捕获的图片。 */
  private settleSubmit(
    attempt: SubmitAttempt,
    pending: Promise<SubmitOutcome>,
    imageIds: readonly DraftAttachmentId[] = [],
  ): void {
    pending.then(
      (outcome) => {
        if (this.dead(attempt)) return
        if (outcome.kind === 'success' && imageIds.length > 0) {
          const submitted = new Set(imageIds)
          this.imageIds = this.imageIds.filter(id => !submitted.has(id))
        }
        this.run(this.core.dispatch({
          type: 'submit-settled',
          attempt,
          ok: outcome.kind === 'success',
          outcome,
        }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        this.run(this.core.dispatch({
          type: 'submit-settled',
          attempt,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }))
      },
    )
  }

  /** 回车裁决：轮询会话控制器；失败时显示提示并保留草稿，绝不静默降级。 */
  private adjudicate(attempt: SubmitAttempt, draft: string): void {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) {
      // 未挂载流水线：把 '/' 开头文本行当作普通消息。
      this.run(this.core.dispatch({ type: 'adjudicated', attempt, outcome: undefined }))
      return
    }
    inputTriggers.adjudicate(draft.trim(), attempt.signal, { images: this.imageIds.length }).then(
      (outcome: PickOutcome) => {
        if (this.dead(attempt)) return
        this.run(this.core.dispatch({ type: 'adjudicated', attempt, outcome }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.run(this.core.dispatch({ type: 'adjudication-failed', attempt, message }))
      },
    )
  }

  /**
   * 提交事务：在会话作用域调用 claim.submit，并由结果 kind 映射 ok。接受图片的
   * 认领会收到已序列化草稿图片；只有成功结果才清除并释放图片。序列化、传输或
   * 处理器失败时保留草稿和图片，供用户修正。
   */
  private beginSubmit(attempt: SubmitAttempt, claim: CommandClaim, args: string): void {
    const imageIds = claim.images === true ? [...this.imageIds] : []
    Promise.resolve()
      .then(async () => {
        const images = imageIds.length > 0 ? await this.deps.commandImages.serialize(imageIds) : []
        // 序列化可能比尝试活得更久，例如大文件或会话销毁；已失效尝试不得到达
        // Host 执行器。
        if (this.dead(attempt)) return undefined
        return claim.submit(args, this.deps.actx, images)
      })
      .then(
        (outcome) => {
          if (outcome === undefined || this.dead(attempt)) return
          if (outcome.kind === 'success' && imageIds.length > 0) {
            const submitted = new Set(imageIds)
            this.imageIds = this.imageIds.filter(id => !submitted.has(id))
            this.deps.commandImages.release(imageIds)
          }
          this.run(this.core.dispatch({
            type: 'submit-settled', attempt, ok: outcome.kind === 'success', outcome,
            ...(outcome.kind === 'error' && outcome.text === undefined ? { message: 'command failed' } : {}),
          }))
        },
        (error: unknown) => {
          if (this.dead(attempt)) return
          const message = error instanceof Error ? error.message : String(error)
          this.run(this.core.dispatch({ type: 'submit-settled', attempt, ok: false, message }))
        },
      )
  }

  /** 迟到结算保护：被取代的尝试和已销毁门面会静默丢弃结果。 */
  private dead(attempt: SubmitAttempt): boolean {
    return this.disposed || attempt.signal.aborted
  }

  private compose(): InputState {
    const core = this.core.state
    return { ...core, imageIds: this.imageIds, queue: this.deps.queue?.getSnapshot() ?? EMPTY_QUEUE }
  }

  private publish(): void {
    const next = this.compose()
    this.state.set(next)
    const mirroredDraft = projectClipboard(next)
    if (mirroredDraft !== this.lastMirroredDraft) {
      this.lastMirroredDraft = mirroredDraft
      this.mirrorFn?.(mirroredDraft)
    }
  }
}
