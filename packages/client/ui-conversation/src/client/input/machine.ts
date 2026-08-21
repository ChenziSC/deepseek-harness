/**
 * InputMachine：每会话的纯输入状态机。事件进入、effect 输出；不依赖 React、
 * DOM、Cordis 或环境时钟。它只在包内可见，SessionInput 外壳是唯一调用者，
 * 也独自负责执行返回的 effect。
 *
 * 草稿事实来源：草稿字符串保存每个引用的完整行内展示文本；实例表携带身份、区间
 * 和拥有者投影缓存。每次草稿变更都是一个事务——草稿编辑、实例协调和撤销日志
 * 入栈在 dispatch() 内原子完成——并推进 draftRev。由此区间 CAS 可简化为修订号
 * 相等检查：修订号相等意味着草稿相同，进而区间内容相同。调用方以 draftRev
 * 是否推进判断变更成功；begin-command、insert-ref、consume-token 和 paste-upgrade
 * 都用这种方式回答 bail 事件。
 */
import type { CommandClaim, ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import type {
  ConsumeTokenGuard, EditRange, EditSelection, InputEffect, InputEvent, InputMachineOptions,
  InputState, Occurrence, PasteAttemptState, PasteComponent, SubmitAttempt,
} from './contract.ts'

/** 粘贴文本中要拒绝的旧式固定宽度对象替换字符。 */
export const PLACEHOLDER = '￼'

const REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu

/**
 * 构造行内草稿文本，其开头标记会在背景层装饰为引用图标。
 * @param reference - 带有展示投影缓存的引用插入。
 * @returns 一个标记字形后跟完整标签的展示文本。
 */
export function referenceDraftText(reference: Pick<ReferenceInsert, 'label'>): string {
  return `@${reference.label}`
}

/** 状态机从不写队列；接线层会叠加队列存储的投影。 */
const EMPTY_QUEUE: InputState['queue'] = []

/** 撤销环深度，即自管理事务日志的上限。 */
const LOG_LIMIT = 100

/** 为封闭的 InputEvent/保护条件联合提供穷尽性兜底。 */
function unreachable(value: never): never {
  throw new Error(`unreachable input event: ${JSON.stringify(value)}`)
}

/**
 * 从草稿移除认领词元，得到提交参数。允许开头空白，包括因开头触发而保留的换行；
 * 缺少词元尾部分隔符的裸 `/name` 产生空参数。只消费一个分隔字符，其余内容
 * 包括换行均原样保留（`/goal x\ny` → `x\ny`）。
 */
function argsAfter(draft: string, token: string): string {
  const s = draft.trimStart()
  if (s.startsWith(token)) return s.slice(token.length)
  const base = token.trimEnd()
  if (s.startsWith(base)) {
    const rest = s.slice(base.length)
    return /^\s/.test(rest) ? rest.slice(1) : rest
  }
  return ''
}

/**
 * 通过公共前后缀扫描恢复两个草稿之间的编辑区间；接线层无法从 DOM 事件提供
 * 区间时使用。
 */
function diffEdit(prev: string, next: string): EditRange {
  let p = 0
  const maxCommon = Math.min(prev.length, next.length)
  while (p < maxCommon && prev[p] === next[p]) p += 1
  let s = 0
  const maxSuffix = maxCommon - p
  while (s < maxSuffix && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s += 1
  return { start: p, end: prev.length - s, insertedLength: next.length - s - p }
}

/**
 * 把草稿中的引用区间展开为对应实例的剪贴板文本，用于持久化和剪贴板投影。
 * 表已按偏移量排序，因此一次线性遍历即可配对区间与条目。
 * @param state - 已发布的输入状态。
 * @returns 草稿的纯文本投影。
 */
export function projectClipboard(state: Pick<InputState, 'draft' | 'occurrences'>): string {
  const { draft, occurrences } = state
  if (occurrences.length === 0) return draft
  let out = ''
  let cursor = 0
  for (const o of occurrences) {
    out += draft.slice(cursor, o.offset) + o.clipboardText
    cursor = o.offset + o.length
  }
  return out + draft.slice(cursor)
}

/** 一个撤销单元：事务应用前取得的快照。 */
interface Transaction {
  readonly draftBefore: string
  readonly occurrencesBefore: readonly Occurrence[]
  /** 触发事件携带选区时记录的编辑前选区，供外壳撤销时恢复光标。 */
  readonly selectionBefore?: EditSelection
}

/**
 * 纯输入状态机，每个会话一个实例，因此从构造上实现会话隔离。状态机在回车时为
 * 每个 SubmitAttempt 创建一个 AbortController，并在 release 时自行取消；外壳
 * 从不发起取消，只在裁决/提交 Promise 上观察 attempt.signal。过期尝试——即任意
 * seq 与当前在途尝试不一致的 adjudicated、adjudication-failed 或 submit-settled——
 * 会被丢弃：状态不变，也不产生 effect。
 */
export class InputMachine {
  private draft = ''
  private draftRev = 0
  private phase: InputState['phase'] = 'plain'
  private claim: CommandClaim | undefined
  private occurrences: readonly Occurrence[] = []
  private occurrenceSeq = 0
  private seq = 0
  private inflight: {
    readonly attempt: SubmitAttempt
    readonly controller: AbortController
  } | undefined
  private log: Transaction[] = []
  private redoStack: Transaction[] = []
  /** 已打开的单字符输入段：时间窗口内下一个连续字符会合并进来。 */
  private typingRun: { readonly end: number; readonly at: number } | undefined
  private paste: PasteAttemptState | undefined
  private pasteSeq = 0
  private readonly mergeWindowMs: number
  private readonly now: () => number

  constructor(options: InputMachineOptions = {}) {
    this.mergeWindowMs = options.mergeWindowMs ?? 1000
    this.now = options.now ?? (() => 0)
  }

  /** 状态机状态的只读快照；这一层的 queue 始终为空。 */
  get state(): InputState {
    const c = this.claim
    return {
      draft: this.draft,
      imageIds: [],
      draftRev: this.draftRev,
      phase: this.phase,
      ...(c
        ? {
          claim: {
            token: c.token,
            ...(c.hint !== undefined ? { hint: c.hint } : {}),
            ...(c.images === true ? { images: true } : {}),
          },
        }
        : {}),
      occurrences: this.occurrences,
      ...(this.paste !== undefined ? { paste: this.paste } : {}),
      queue: EMPTY_QUEUE,
    }
  }

  /**
   * 把一个事件送入状态机。
   * @param ev - 输入事件，也是所有输入状态的唯一写入路径。
   * @returns 供外壳按顺序执行的 effect；无操作、锁定或丢弃过期事件时为空。
   */
  dispatch(ev: InputEvent): readonly InputEffect[] {
    switch (ev.type) {
      case 'draft-changed': return this.onDraftChanged(ev.draft, ev.editRange)
      case 'begin-command': return this.onBeginCommand(ev.claim, ev.span)
      case 'insert-ref': return this.onInsertRef(ev.reference, ev.span)
      case 'consume-token': return this.onConsumeToken(ev.guard)
      case 'set-invalid': return this.onSetInvalid(ev.invalidIds)
      case 'undo': return this.onUndo()
      case 'redo': return this.onRedo()
      case 'paste-begin': return this.onPasteBegin(ev.text, ev.selection, ev.components, ev.generation)
      case 'paste-upgrade': return this.onPasteUpgrade(ev.attemptId, ev.span, ev.reference)
      case 'invalidate-paste': {
        this.paste = undefined
        return []
      }
      case 'enter': return this.onEnter(ev.mode)
      case 'adjudicated': return this.onAdjudicated(ev.attempt, ev.outcome)
      case 'adjudication-failed': return this.onAdjudicationFailed(ev.attempt, ev.message)
      case 'submit-settled': return this.onSubmitSettled(ev)
      case 'send-committed': return this.onSendCommitted()
      case 'release': return this.onRelease()
      default: return unreachable(ev)
    }
  }

  // ---- 事务基础设施 ----

  /** 接纳新草稿并推进修订号，这也是区间 CAS 的失效点。 */
  private adopt(draft: string): void {
    this.draft = draft
    this.draftRev += 1
  }

  /** 压入一个变更前撤销单元，裁剪撤销环，并切断重做链。 */
  private pushTxn(selectionBefore?: EditSelection): void {
    this.log.push({
      draftBefore: this.draft,
      occurrencesBefore: this.occurrences,
      ...(selectionBefore !== undefined ? { selectionBefore } : {}),
    })
    if (this.log.length > LOG_LIMIT) this.log.shift()
    this.redoStack = []
  }

  /**
   * 使用一次编辑协调实例表，区间采用旧草稿坐标：区间后的条目按长度差移动；
   * 与引用区间相交的编辑会移除其结构化实例，并把编辑后的字符保留为普通草稿文本。
   */
  private reconcile(range: EditRange): void {
    const delta = range.insertedLength - (range.end - range.start)
    const kept: Occurrence[] = []
    for (const o of this.occurrences) {
      if (o.offset + o.length <= range.start) kept.push(o)
      else if (o.offset >= range.end) kept.push(delta === 0 ? o : { ...o, offset: o.offset + delta })
    }
    this.occurrences = kept
  }

  /** claimed 完整性监视：任何破坏词元前缀的变更都会释放认领。 */
  private watchClaim(): void {
    if (this.phase === 'claimed' && this.claim !== undefined && !this.draft.startsWith(this.claim.token)) {
      this.phase = 'plain'
      this.claim = undefined
    }
  }

  /** 在草稿偏移处签发一个引用实例。 */
  private mint(reference: ReferenceInsert, offset: number, length: number): Occurrence {
    this.occurrenceSeq += 1
    return {
      occurrenceId: this.occurrenceSeq,
      source: reference.source,
      ref: reference.ref,
      offset,
      length,
      label: reference.label,
      ...reference.appearance === undefined ? {} : { appearance: reference.appearance },
      clipboardText: reference.clipboardText,
    }
  }

  /** 把新签发条目插入按偏移量排序的表。 */
  private withMinted(minted: readonly Occurrence[]): void {
    if (minted.length === 0) return
    this.occurrences = [...this.occurrences, ...minted].sort((a, b) => a.offset - b.offset)
  }

  // ---- 草稿事务 ----

  private onDraftChanged(draft: string, editRange?: EditRange): InputEffect[] {
    if (draft === this.draft) return []
    const range = editRange ?? diffEdit(this.draft, draft)
    // 连续且仍在合并窗口内的单字符输入并入已打开输入段；其他编辑各自开启事务。
    const typing = range.start === range.end && range.insertedLength === 1
    const at = this.now()
    const run = this.typingRun
    const merges = typing && run !== undefined && run.end === range.start && at - run.at <= this.mergeWindowMs
    if (!merges) this.pushTxn({ start: range.start, end: range.end })
    this.typingRun = typing ? { end: range.start + 1, at } : undefined
    this.reconcile(range)
    this.adopt(draft)
    this.watchClaim()
    this.paste = undefined
    return []
  }

  /** 区间 CAS：检查修订号相等（从而内容相同），并验证边界合理。 */
  private casOk(span: TokenSpan): boolean {
    return span.draftRev === this.draftRev
      && span.start >= 0 && span.start <= span.end && span.end <= this.draft.length
  }

  private onBeginCommand(claim: CommandClaim, span: TokenSpan): InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    // 开头触发约定：区间前只能有空白；丢弃空白前缀，使 claimed 的 startsWith
    // 监视能够成立。
    if (!this.casOk(span) || this.draft.slice(0, span.start).trim() !== '') return []
    this.pushTxn()
    this.typingRun = undefined
    this.reconcile({ start: 0, end: span.end, insertedLength: claim.token.length })
    this.adopt(claim.token + this.draft.slice(span.end))
    this.claim = claim
    this.phase = 'claimed'
    this.paste = undefined
    return []
  }

  private onInsertRef(reference: ReferenceInsert, span: TokenSpan): InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    if (!this.casOk(span)) return []
    this.replaceSpanWithChip(reference, span)
    this.paste = undefined
    return []
  }

  /**
   * 共享引用插入事务：用一个行内实例替换 `[span)`；insert-ref 和 paste-upgrade
   * 都进入这里。若后面尚无空格，就在引用后补一个分隔空格。
   * @returns 插入长度，即展示文本加可选间隔。
   */
  private replaceSpanWithChip(reference: ReferenceInsert, span: TokenSpan): number {
    this.pushTxn()
    this.typingRun = undefined
    const tail = this.draft.slice(span.end)
    const gap = tail.length === 0 || tail[0] !== ' ' ? ' ' : ''
    const displayText = referenceDraftText(reference)
    const inserted = displayText + gap
    this.reconcile({ start: span.start, end: span.end, insertedLength: inserted.length })
    this.withMinted([this.mint(reference, span.start, displayText.length)])
    this.adopt(this.draft.slice(0, span.start) + inserted + tail)
    this.watchClaim()
    return inserted.length
  }

  /**
   * 业务成功后受保护地删除词元（弹窗结算/菜单选择执行）。没有专门 effect 表示
   * 成功；调用方从已发布状态读取 draftRev 是否推进，与其他 bail 操作使用同一数据。
   */
  private onConsumeToken(guard: ConsumeTokenGuard): InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    switch (guard.kind) {
      case 'span': {
        const span = guard.span
        if (!this.casOk(span) || span.start === span.end) return []
        this.pushTxn()
        this.typingRun = undefined
        this.reconcile({ start: span.start, end: span.end, insertedLength: 0 })
        this.adopt(this.draft.slice(0, span.start) + this.draft.slice(span.end))
        this.watchClaim()
        this.paste = undefined
        return []
      }
      case 'bare-token': {
        if (guard.token === '' || this.draft.trim() !== guard.token) return []
        this.pushTxn()
        this.typingRun = undefined
        this.occurrences = []
        this.adopt('')
        this.watchClaim()
        this.paste = undefined
        return []
      }
      default: return unreachable(guard)
    }
  }

  /**
   * 拥有者解析样式位：只有列出的实例渲染为无效。这不是事务，草稿、修订号和撤销
   * 日志都不变；失效处理从不删除或重写胶囊。
   */
  private onSetInvalid(invalidIds: readonly number[]): InputEffect[] {
    const ids = new Set(invalidIds)
    if (!this.occurrences.some(o => (o.invalid === true) !== ids.has(o.occurrenceId))) return []
    this.occurrences = this.occurrences.map((o) => {
      const invalid = ids.has(o.occurrenceId)
      if ((o.invalid === true) === invalid) return o
      const { invalid: _drop, ...rest } = o
      return invalid ? { ...rest, invalid: true } : rest
    })
    return []
  }

  // ---- 撤销/重做 ----

  private onUndo(): InputEffect[] {
    const entry = this.log.pop()
    if (entry === undefined) return []
    this.redoStack.push({ draftBefore: this.draft, occurrencesBefore: this.occurrences })
    this.occurrences = entry.occurrencesBefore
    this.adopt(entry.draftBefore)
    this.watchClaim()
    this.typingRun = undefined
    this.paste = undefined
    return []
  }

  private onRedo(): InputEffect[] {
    const entry = this.redoStack.pop()
    if (entry === undefined) return []
    // 手动压入日志：pushTxn 会切断当前正在遍历的重做链。
    this.log.push({ draftBefore: this.draft, occurrencesBefore: this.occurrences })
    if (this.log.length > LOG_LIMIT) this.log.shift()
    this.occurrences = entry.occurrencesBefore
    this.adopt(entry.draftBefore)
    this.watchClaim()
    this.typingRun = undefined
    this.paste = undefined
    return []
  }

  // ---- 粘贴平面 ----

  /**
   * 把粘贴作为一个事务：清理引用占位符后的文本替换选区；热快照同步匹配项在同一
   * 事务内组件化，因此一次撤销回到粘贴前；若当前阶段仍接受引用变更，则为异步
   * 剩余部分开启匹配尝试。
   */
  private onPasteBegin(
    rawText: string, selection: EditSelection,
    components: readonly PasteComponent[] = [], generation = 0,
  ): InputEffect[] {
    const { start, end } = selection
    if (start < 0 || start > end || end > this.draft.length) return []
    const text = rawText.replace(REFERENCE_PLACEHOLDER_RE, '')
    this.pushTxn(selection)
    this.typingRun = undefined
    // 组件化：组装插入文本时，用行内展示文本替换每个匹配词元区间。区间采用
    // 粘贴文本坐标，并按约定互不相交。
    const sorted = [...components].sort((a, b) => a.start - b.start)
    const minted: Occurrence[] = []
    let inserted = ''
    let cursor = 0
    for (const c of sorted) {
      inserted += text.slice(cursor, c.start)
      const displayText = referenceDraftText(c.reference)
      minted.push(this.mint(c.reference, start + inserted.length, displayText.length))
      inserted += displayText
      cursor = c.end
    }
    inserted += text.slice(cursor)
    this.reconcile({ start, end, insertedLength: inserted.length })
    this.withMinted(minted)
    this.adopt(this.draft.slice(0, start) + inserted + this.draft.slice(end))
    this.watchClaim()
    if (this.phase === 'plain' || this.phase === 'claimed') {
      this.pasteSeq += 1
      this.paste = {
        attemptId: this.pasteSeq,
        insertedRange: { start, end: start + inserted.length },
        generation,
      }
    } else {
      this.paste = undefined
    }
    return []
  }

  /**
   * 异步匹配完成：以独立事务把一个粘贴词元升级为胶囊；撤销一次回词元文本，
   * 再撤销回粘贴前。尝试仍保持有效，后续词元针对已推进的 draftRev 重新 CAS。
   */
  private onPasteUpgrade(attemptId: number, span: TokenSpan, reference: ReferenceInsert): InputEffect[] {
    const attempt = this.paste
    if (attempt === undefined || attempt.attemptId !== attemptId) return []
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    if (!this.casOk(span) || span.start === span.end) return []
    const insertedLength = this.replaceSpanWithChip(reference, span)
    this.paste = {
      ...attempt,
      insertedRange: { start: attempt.insertedRange.start, end: attempt.insertedRange.end + insertedLength - (span.end - span.start) },
    }
    return []
  }

  // ---- 提交平面 ----

  /** 签发下一个 SubmitAttempt，并占用在途槽位。 */
  private beginAttempt(mode: InputSubmitMode): SubmitAttempt {
    const controller = new AbortController()
    this.seq += 1
    const attempt: SubmitAttempt = { seq: this.seq, signal: controller.signal, draftSnapshot: this.draft, mode }
    this.inflight = { attempt, controller }
    return attempt
  }

  private onEnter(mode: InputSubmitMode): InputEffect[] {
    if (this.phase === 'adjudicating' || this.phase === 'submitting') return []
    if (this.phase === 'claimed' && this.claim !== undefined) {
      const attempt = this.beginAttempt(mode)
      this.phase = 'submitting'
      this.paste = undefined
      return [{ type: 'begin-submit', attempt, claim: this.claim, args: argsAfter(this.draft, this.claim.token) }]
    }
    const trimmed = this.draft.trim()
    if (trimmed === '') return []
    this.paste = undefined
    if (trimmed.startsWith('/')) {
      const attempt = this.beginAttempt(mode)
      this.phase = 'adjudicating'
      return [{ type: 'adjudicate', attempt, draft: this.draft }]
    }
    const attempt = this.beginAttempt(mode)
    this.phase = 'submitting'
    return [{ type: 'default-sink', attempt, draft: this.draft, mode }]
  }

  private onAdjudicated(attempt: SubmitAttempt, outcome: Extract<InputEvent, { type: 'adjudicated' }>['outcome']): InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'adjudicating' || flight === undefined || flight.attempt.seq !== attempt.seq) return []
    if (outcome !== undefined && outcome !== 'handled' && 'claim' in outcome) {
      this.claim = outcome.claim
      this.phase = 'submitting'
      return [{
        type: 'begin-submit',
        attempt,
        claim: outcome.claim,
        args: argsAfter(attempt.draftSnapshot, outcome.claim.token),
      }]
    }
    // 'handled'（来源内部处理）、{insert}（没有回车时区间语义）或未命中都会回到
    // plain；只有未命中继续流向默认出口。
    if (outcome === undefined) {
      this.phase = 'submitting'
      return [{
        type: 'default-sink',
        attempt,
        draft: attempt.draftSnapshot,
        mode: attempt.mode,
      }]
    }
    this.inflight = undefined
    this.phase = 'plain'
    return []
  }

  private onAdjudicationFailed(attempt: SubmitAttempt, message: string): InputEffect[] {
    if (this.phase !== 'adjudicating' || this.inflight?.attempt.seq !== attempt.seq) return []
    this.inflight = undefined
    this.phase = 'plain'
    // 保留草稿：预热失败绝不静默降级为普通提示词发送。
    return [{ type: 'notice', level: 'error', text: message }]
  }

  private onSubmitSettled(ev: Extract<InputEvent, { type: 'submit-settled' }>): InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'submitting' || flight === undefined || flight.attempt.seq !== ev.attempt.seq) return []
    this.inflight = undefined
    if (ev.ok) {
      this.phase = 'plain'
      this.claim = undefined
      this.occurrences = []
      // Host 往返期间追加在已发送快照后的文本会在提交后保留；与已提交内容交织的
      // 编辑无法可靠分离，因此只保留纯后缀。
      const snapshot = flight.attempt.draftSnapshot
      this.adopt(this.draft !== snapshot && this.draft.startsWith(snapshot)
        ? this.draft.slice(snapshot.length)
        : '')
      // 已提交内容永久移除：撤销不得复活已经发送的草稿。
      this.log = []
      this.redoStack = []
      this.typingRun = undefined
      this.paste = undefined
      return ev.outcome?.text !== undefined
        ? [{ type: 'notice', level: ev.outcome.kind === 'error' ? 'error' : 'info', text: ev.outcome.text }]
        : []
    }
    const text = ev.message ?? ev.outcome?.text
    // 只有实时草稿仍等于回车时草稿时才保留原命令认领；在途期间用户新输入优先。
    // 重新进入 claimed 还要求前缀监视成立，因为回车路径快照可能带有词元本身没有
    // 的开头空白。
    if (this.draft === flight.attempt.draftSnapshot
      && this.claim !== undefined && this.draft.startsWith(this.claim.token)) {
      this.phase = 'claimed'
      return text === undefined ? [] : [{ type: 'notice', level: 'error', text }]
    }
    this.phase = 'plain'
    this.claim = undefined
    return text === undefined ? [] : [{ type: 'notice', level: 'error', text }]
  }

  /** 纯图片发送被接受后切断撤销状态。 */
  private onSendCommitted(): InputEffect[] {
    if (this.phase !== 'plain') return []
    this.claim = undefined
    this.occurrences = []
    this.adopt('')
    this.log = []
    this.redoStack = []
    this.typingRun = undefined
    this.paste = undefined
    return []
  }

  private onRelease(): InputEffect[] {
    if (this.inflight !== undefined) {
      this.inflight.controller.abort()
      this.inflight = undefined
    }
    this.phase = 'plain'
    this.claim = undefined
    this.typingRun = undefined
    this.paste = undefined
    return []
  }
}
