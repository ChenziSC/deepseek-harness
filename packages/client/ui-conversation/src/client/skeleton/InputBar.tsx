/** 默认编辑器主体，即 'conversation.composer.bar' Slot 条目。状态机状态通过标准
 * provide 通道到达（useInput + inputActions）；键盘/DOM 命令接口和 stop 通过本
 * 条目自身的 inject 到达，其中 hooks 分区绑定 useNotices/useLexicon；布局阶段
 * 输入（variant、placeholder、区域 Slot 内容）由拥有者 props 携带。会话事实
 * （running/removed/promptError）则通过 useSession 自行选择。 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconPlusOutline16, IconWarningOutline16, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
// 仅类型：合并 `plan` 投影键。与 TodoDock 一样，编辑器读取 Host 计算的值，
// 该领域拥有键定义。
import type {} from '@deepseek-ai/dsh-plan-mode/client'
// 仅类型：合并 `goal` 投影键，用于区分提示。
import type {} from '@deepseek-ai/dsh-goal/client'
// `imageLimits` 投影键合并用于接收前预检，并随线协议类型到达：apiproxy 的
// sessions 约定声明它，client-runtime 的 api-remotes 导入已把它放进每个客户端程序。
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarProps } from '../contract/slots.ts'
import { deriveDecorations } from '../input/decorations.ts'
import type { DraftDecorations } from '../input/decorations.ts'
import type { EditRange } from '../input/contract.ts'
import { attachmentErrorText, imageSizeText } from '../image-labels.ts'
import { ReferenceIcon } from '../reference/ReferenceIcon.tsx'
import { ContextMeter } from './ContextMeter.tsx'
import { PermissionSelect } from './PermissionSelect.tsx'
import { isSafariBrowser, repairSafariTextareaLayout } from './safari.ts'
import css from './InputBar.module.css'

/** 无会话状态下的装饰结果：没有状态机，草稿为空。 */
const INERT_DECORATIONS: DraftDecorations = { token: null, chips: [], textRefs: [], hint: null }

/** `beforeinput` 记录的选区和编辑类别，以及它所作用草稿的长度。 */
interface PendingEdit {
  readonly start: number
  readonly end: number
  readonly draftLength: number
  readonly inputType: string
}

/**
 * 根据编辑应用前取得的记录解析其区间。编辑替换选区时，选区本身就是区间。
 * 光标删除没有替换内容，只报告裸光标，因此被删除区间是草稿在 `inputType`
 * 指定一侧实际减少的部分；必须测量，因为一次光标操作可能删除多码元字素、
 * 一个单词或一整行。
 * @param pending - `beforeinput` 时取得的记录；未观察到时为 null。
 * @param prevLength - 编辑作用前的草稿长度。
 * @param nextLength - 结果草稿长度。
 * @returns 精确区间；记录无法描述本次编辑时返回 undefined，由状态机 diff 扫描恢复。
 */
function editRangeOf(pending: PendingEdit | null, prevLength: number, nextLength: number): EditRange | undefined {
  if (pending === null || pending.draftLength !== prevLength) return undefined
  const { start, end, inputType } = pending
  // DOM 选区不可能反转；此检查把它明确作为下方计算的前置条件，而不是对元素的假设。
  if (start > end || end > prevLength) return undefined
  const insertedLength = nextLength - prevLength + (end - start)
  if (insertedLength >= 0) return { start, end, insertedLength }
  if (start !== end) return undefined
  const removed = prevLength - nextLength
  if (inputType.endsWith('Backward')) {
    return removed <= start ? { start: start - removed, end: start, insertedLength: 0 } : undefined
  }
  if (inputType.endsWith('Forward')) {
    return start + removed <= prevLength ? { start, end: start + removed, insertedLength: 0 } : undefined
  }
  return undefined
}

export type InputBarProps = ComposerBarProps

export function InputBar({
  useSession, useInput, inputActions, keyboard, addImages, removeImage, draftImages,
  resolveSubmitMode, toggleCommandMenu, stop, command, t,
  renderSlot, useNotices, useLexicon, useMenuLauncher,
  useProjection, sessionId, variant, disabled: inert = false, blocked,
  workspacePickerOpen = false, onRequestWorkspace,
  placeholder, accessory, overlay, leftItems, rightItems, footer,
}: InputBarProps) {
  const input = useInput(s => s)
  const notice = useNotices(s => s)
  const lexicon = useLexicon(s => s)
  const commandMenuOpen = useMenuLauncher(source => source === 'command')
  const promptError = useSession(s => s.promptError) ?? null
  const running = useSession(s => s.running) ?? false
  const subagent = useSession(s => s.subagent) ?? null
  const removed = useSession(s => s.removed) ?? false
  // Plan 模式会替换 textarea 占位文案；该投影是 Host 折叠后的值，但拥有者 props
  // 提供的占位文案（hero、session-unavailable）优先。
  const planActive = useProjection('plan', plan => plan !== undefined && (plan.pending ? !plan.active : plan.active))
  // 缺失（undefined，尚无 frame）和已清除（null）都表示没有目标。
  const hasGoal = useProjection('goal', goal => goal != null)
  // session-maybe：没有当前会话时，状态机接口会一起缺失；输入栏把同一 DOM 渲染为
  // 不可交互，而不是另建一棵平行树。
  const live = input !== undefined && keyboard !== undefined && inputActions !== undefined
  const draft = input?.draft ?? ''
  const attachments = useMemo(
    () => input === undefined || draftImages === undefined ? [] : draftImages(input.imageIds),
    [draftImages, input?.imageIds],
  )
  const empty = draft.trim() === '' && attachments.length === 0
  // 临时错误横幅，包括状态机提示、图片接收拒绝和 prompt 失败。seq 作为 Toast 键，
  // 让完全相同的重复消息重新开始停留再淡出周期，而不是复用已经淡出的实例。
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const showToast = useCallback((text: string) => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }, [])
  const dismissToast = useCallback(() => { setToast(null) }, [])
  // 部署的图片接收限制；未组合附件服务时缺失，下方预检就完全交给 Host。
  const imageLimits = useProjection('imageLimits')
  // prompt 失败是普通失败，不再存在 create/attach 事务：Toast 宣告 promptError，
  // 草稿保留在状态机中，由用户重新提交。若重新挂载的会话状态机仍持有未解决的
  // promptError，会有意再次宣告一次；失败仍待处理，临时横幅是唯一展示面。
  // 附件拒绝按线协议 reason 显示产品文案；其他代码面向开发者，保留原始消息和代码。
  useEffect(() => {
    if (promptError === null) return
    showToast(promptError.error.code === 'attachment-error'
      ? attachmentErrorText(t, promptError.error.details.reason, imageLimits)
      : `${promptError.error.message} (${promptError.error.code})`)
  }, [promptError, showToast, t, imageLimits])
  useEffect(() => {
    if (notice?.level === 'error') showToast(notice.text)
  }, [notice, showToast])
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const safari = useMemo(() => isSafariBrowser(navigator), [])
  const safariNativeShrinkRef = useRef(false)
  // IME 保护：组合输入期间的回车用于选择候选项，不能发送。ref 跨渲染存活；Safari
  // 会在 compositionend 之后才派发收尾 keydown，因此延迟一个 tick 清除。
  const composingRef = useRef(false)
  const onCompositionStart = (): void => {
    composingRef.current = true
  }
  const onCompositionEnd = (): void => {
    setTimeout(() => {
      composingRef.current = false
    }, 10)
  }

  // Access 座位的数据：Host 计算的权限投影；undefined 表示能力不存在，胶囊不渲染。
  const permissions = useProjection('permissions')

  // 可继续的子会话若没有仍存活的父会话，就不能接受人工输入；但运行期间，下方独立
  // Stop 仍保持可用。
  const continuable = subagent?.address.mode === 'continuable'
  const parentOffline = continuable && !subagent.parentAvailable
  // 运行中的输入保持可用。locked 表示会话已移除、无工作区的不可交互状态、状态机
  // 接口缺失（无会话），或可继续子会话的父会话离线。拥有者 block 也会禁用输入；
  // adjudicating 和 submitting 渲染为只读，以保持草稿可见。
  const disabled = removed || inert || !live || blocked !== undefined || parentOffline
  const locked = disabled
  // model 座位是 block 唯一保留可用的控件：此约定中的每种 block 都通过选择模型
  // 清除；若连它也锁定，编辑器就会要求用户完成自己禁止的唯一操作。其他禁用原因
  // 仍会锁定它，因为此时没有可供选择模型的会话。
  const modelSeatLocked = removed || inert || !live
  const machineBusy = input?.phase === 'adjudicating' || input?.phase === 'submitting'
  // 无工作区时 textarea 仍是常驻 DOM 节点，但充当现有选择器的触发入口。消息控件
  // 在 Session 存在前保持锁定；触发器本身只读而非 disabled，使鼠标和键盘用户
  // 都能到达恢复操作。
  const workspaceTrigger = inert && !removed && onRequestWorkspace !== undefined
  const textareaDisabled = removed || (locked && !workspaceTrigger)
  const canSteerQueue = !locked && !machineBusy && !commandMenuOpen && empty && running && subagent === null
    && input.queue.some(row => row.placement === 'queued')

  useEffect(() => {
    if (input === undefined || inputActions === undefined) return
    if (attachments.length !== input.imageIds.length) {
      inputActions.pruneImages(attachments.map(attachment => attachment.id))
    }
  }, [attachments, input?.imageIds, inputActions])

  // Safari 原生编辑缩短草稿后，镜像收缩时可能残留旧的软换行布局。native-change
  // 信号避免普通输入和程序化草稿更新读取布局；辅助函数只在绘制前修复测得的溢出，
  // 同时保留原生编辑状态。参见
  // .agents/notes/implemented/bug-fix/2026-08-13-safari-textarea-soft-wrap-reflow.md.
  useLayoutEffect(() => {
    const nativeShrink = safariNativeShrinkRef.current
    safariNativeShrinkRef.current = false
    if (safari && nativeShrink) repairSafariTextareaLayout(inputRef.current)
  }, [draft, safari])
  // 以最小幅度滚动草稿滚动区，使 `caret` 进入视口；这是浏览器处理原生输入时的
  // 行为，此处为浏览器不会自动处理的路径补上。
  //
  // 镜像是光标的标尺：它在同一堆叠中以相同度量和换行宽度渲染同一草稿，因此成为
  // 高度权威。在光标索引处折叠的 Range 无需专用光标 API 就能报告光标位置。
  const revealCaret = (caret: number): void => {
    const scrollEl = scrollRef.current
    const mirrorEl = mirrorRef.current
    const text = mirrorEl?.firstChild
    if (scrollEl === null || mirrorEl === null || !(text instanceof Text)) return
    // 无法滚动的框没有需要揭示的内容：草稿已完全容纳，每个光标都在视口内，
    // 下方赋值最终也只会限位到当前值。
    if (scrollEl.scrollHeight <= scrollEl.clientHeight) return
    const at = Math.min(caret, text.data.length)
    // 紧跟换行符的光标位于无内容可测量的空行，也就是尾随换行草稿的结尾形态；
    // 各引擎对此不一致：Chromium 完全不返回 client rect（全零框会向错误方向滚动），
    // Firefox 报告上一行，WebKit 才报告正确行。改为测量换行符本身，即光标刚离开的
    // 行，再向下移动一行；各引擎对这种计算结果一致。
    const afterNewline = at > 0 && text.data[at - 1] === '\n'
    const range = document.createRange()
    range.setStart(text, afterNewline ? at - 1 : at)
    if (afterNewline) range.setEnd(text, at)
    else range.collapse(true)
    const line = afterNewline ? Number.parseFloat(getComputedStyle(mirrorEl).lineHeight) : 0
    const rect = range.getBoundingClientRect()
    const box = scrollEl.getBoundingClientRect()
    if (rect.bottom + line > box.bottom) scrollEl.scrollTop += rect.bottom + line - box.bottom
    else if (rect.top + line < box.top) scrollEl.scrollTop -= box.top - rect.top - line
  }

  // 揭示当前选区的焦点端。现有入口都留下折叠选区，但尊重方向可以防止未来保留
  // 区间的路径错误揭示锚点而非焦点。
  const revealSelectionFocus = (el: HTMLTextAreaElement): void => {
    // lib.dom 中 selectionStart/End 为 number|null；类型感知 lint 程序会收窄它们。
    const caret = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    revealCaret(caret ?? el.value.length)
  }

  // 解锁（挂载/切换会话）会把焦点还给输入框，并负责随之而来的揭示。使用
  // `preventScroll`，因为此次聚焦由程序发起而非用户手势：textarea 与草稿等高，
  // 浏览器的揭示会一路滚到会话滚动区，让只切换会话的用户看到转录内容移动。
  // 光标揭示因此由我们处理；DOM 在会话间复用，切到更长草稿时仍保留旧偏移，
  // 值替换却把光标放到新草稿末尾，落在屏幕外（三个引擎实测均为偏移 0、光标向下
  // 940px）。先阻止外层滚动，再只在输入框内揭示。
  useEffect(() => {
    const el = inputRef.current
    if (locked || el === null) return
    el.focus({ preventScroll: true })
    revealSelectionFocus(el)
  }, [locked, sessionId])

  // 持久化草稿在解锁 effect 之后到达：ConversationSession 在自身挂载 effect 中
  // 接纳它，而父组件挂载 effect 晚于子组件。草稿变为非空时执行揭示，避免恢复的
  // 长草稿停在开头而光标位于末尾。此 effect 不聚焦：发送后清除、失败发送恢复和
  // 首字符变化都不得从用户已转向的其他控件抢走焦点。
  useEffect(() => {
    const el = inputRef.current
    if (locked || draft === '' || el === null) return
    revealSelectionFocus(el)
  }, [draft !== ''])

  // 编辑器自行执行编辑后恢复光标。状态机拥有草稿和撤销日志，因此粘贴与剪切会
  // 阻止原生编辑并通过状态机写值；程序化选区变化不会揭示任何内容。Chromium 和
  // WebKit 实测粘贴长文本后视图保持原处，而光标已位于草稿末尾。原生输入由浏览器
  // 负责揭示，这两条路径必须主动请求，因此共享同一恢复逻辑。
  const restoreCaret = (el: HTMLTextAreaElement, caret: number): void => {
    requestAnimationFrame(() => {
      el.setSelectionRange(caret, caret)
      revealCaret(caret)
    })
  }

  // 在草稿滚动区进行滚轮链式传递，生命周期只有一份；元素永不卸载，不可交互状态
  // 仍渲染同一元素但禁用。限制高度的框在当前方向仍可移动时保留原生滚动；只有
  // 到达自身边缘才把增量转给当前会话滚动区，使短草稿不吞掉手势、长草稿仍可滚动。
  // Hero 挂载没有宿主，保留原生滚轮行为。
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent): void => {
      const host = el.closest('[data-conversation-scroll]')
      if (!(host instanceof HTMLElement) || e.deltaY === 0) return
      const atTop = el.scrollTop <= 0
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
      if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atEnd)) return
      e.preventDefault()
      host.scrollTop += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [])

  // lib.dom 中 selectionStart/End 为 number|null；类型感知 lint 程序会收窄它们。
  /* oxlint-disable typescript/no-unnecessary-condition */
  const selectionOf = (el: HTMLTextAreaElement) => ({
    start: el.selectionStart ?? 0,
    end: el.selectionEnd ?? el.selectionStart ?? 0,
  })
  /* oxlint-enable typescript/no-unnecessary-condition */

  // 状态机的实例区间计算需要真实编辑范围，但受控 textarea 的 change 事件只携带
  // 结果字符串。`beforeinput` 触发时元素仍保存编辑前选区，它正是即将被替换的区间；
  // textarea 没有其他方式暴露它（表单控件的 `getTargetRanges()` 为空）。若改用两个
  // 草稿 diff 恢复区间，输入文本与落点内容重复时会产生歧义：在引用前输入触发字符
  // 会被误判为落在引用内部，导致引用被删除。它与上方滚轮监听器一样只有一份生命周期，
  // 因为 textarea 永不卸载。
  const pendingEditRef = useRef<PendingEdit | null>(null)
  useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    const onBeforeInput = (e: InputEvent): void => {
      // 只记录其报告选区确实描述编辑的事件类别。历史回放报告的是光标碰巧所在位置，
      // 它会通过 editRangeOf 的所有检查，却指向错误区间。
      if (!e.inputType.startsWith('insert') && !e.inputType.startsWith('delete')) {
        pendingEditRef.current = null
        return
      }
      const { start, end } = selectionOf(el)
      pendingEditRef.current = { start, end, draftLength: el.value.length, inputType: e.inputType }
    }
    el.addEventListener('beforeinput', onBeforeInput)
    return () => { el.removeEventListener('beforeinput', onBeforeInput) }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (workspaceTrigger) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onRequestWorkspace()
      }
      return
    }
    // 状态机缺失且没有 Workspace 恢复操作时保持禁用；此保护同时为下方路径收窄接口。
    if (input === undefined || keyboard === undefined || inputActions === undefined) return
    // Shift+Enter 无条件表示原生换行，并在 IME 保护前决定，使关闭组合输入的
    // Shift+Enter 仍能换行。
    if (e.key === 'Enter' && e.shiftKey) return
    // keyCode 229 是引擎未提供 isComposing 时发出的旧式 IME 组合输入信号。
    // oxlint-disable-next-line typescript/no-deprecated
    const composing = composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
    if (!composing && !machineBusy && !locked
      && (e.key === 'Backspace' || e.key === 'Delete')) {
      const selection = selectionOf(e.currentTarget)
      if (selection.start === selection.end) {
        const occurrence = input.occurrences.find(o => e.key === 'Backspace'
          ? o.offset + o.length === selection.start
          : o.offset === selection.start)
        if (occurrence !== undefined) {
          e.preventDefault()
          const start = occurrence.offset
          const end = occurrence.offset + occurrence.length
          keyboard.setDraft(draft.slice(0, start) + draft.slice(end), { start, end, insertedLength: 0 })
          restoreCaret(e.currentTarget, start)
          keyboard.track(keyboard.snapshot.draft, start)
          return
        }
      }
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (keyboard.arbitrate(e.key === 'ArrowUp' ? 'up' : 'down', composing) === 'consumed') e.preventDefault()
      return
    }
    if (e.key === 'Escape') {
      // Escape 分层：有打开的浮层时关闭浮层；claimed 但没有浮层时不释放，
      // 回退删除词元是唯一退出手势。
      keyboard.dismissPopup()
      if (keyboard.arbitrate('escape', composing) === 'consumed') e.preventDefault()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      // 状态机拥有撤销/重做日志，因为胶囊事务包含浏览器原生栈无法表示的语义；
      // 永远不要让原生栈执行。
      e.preventDefault()
      if (machineBusy || locked) return
      const redo = e.key === 'y' || e.shiftKey
      if (redo) keyboard.redo()
      else keyboard.undo()
      return
    }
    if (e.key === ' ') {
      if (composing) return
      if (keyboard.space()) e.preventDefault() // claim token already carries the trailing separator
      return
    }
    if (e.key !== 'Enter') return
    if (composing) return
    // 菜单打开时，回车通过裁决选择高亮项；没有高亮项的菜单把回车继续交给状态机
    // 自身裁决。
    const arbitrated = keyboard.arbitrate('enter', composing)
    if (arbitrated !== 'pass') {
      e.preventDefault()
      return
    }
    e.preventDefault()
    if (e.repeat) return // held-down Enter must not machine-gun sends
    if (locked || machineBusy) return
    const accelerated = e.ctrlKey || e.metaKey
    // 空草稿加速回车作用于队列而不是空草稿：状态机拒绝空草稿，因此该手势把所有
    // 仍待处理的排队消息引导进运行中的轮次，等价于把停靠栏逐行 steer 按钮应用到
    // 整个队列。它与逐行按钮需要相同窗口：一个正在运行的普通会话。
    if (accelerated && canSteerQueue) {
      keyboard.steerQueue()
      return
    }
    keyboard.submit(resolveSubmitMode(
      running,
      accelerated ? 'accelerated' : 'enter',
      subagent === null,
    ))
  }

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    if (keyboard === undefined || locked) return // disabled/read-only states cannot edit the draft
    if (machineBusy) return // submitting is the read-only span; adjudicating holds the pending lock
    const next = e.target.value
    const pending = pendingEditRef.current
    pendingEditRef.current = null
    safariNativeShrinkRef.current = safari && next.length < draft.length
    keyboard.setDraft(next, editRangeOf(pending, draft.length, next.length))
    // lib.dom 中 selectionStart 为 number|null；类型感知 lint 程序会收窄它。
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    keyboard.track(next, e.target.selectionStart ?? next.length)
  }

  const onCopyOrCut = (e: React.ClipboardEvent<HTMLTextAreaElement>, cut: boolean): void => {
    if (input === undefined || keyboard === undefined) return // absent machine: no draft can be copied or cut
    const el = e.currentTarget
    const { start, end } = selectionOf(el)
    if (start === end) return
    const touched = input.occurrences.filter(o => o.offset < end && o.offset + o.length > start)
    if (touched.length === 0 && !cut) return // plain copy of plain text: native path is fine
    e.preventDefault()
    const copyStart = touched.reduce((value, o) => Math.min(value, o.offset), start)
    const copyEnd = touched.reduce((value, o) => Math.max(value, o.offset + o.length), end)
    // 把结构化区间展开为其拥有者定义的剪贴板投影。
    let text = ''
    let cursor = copyStart
    for (const o of touched) {
      text += draft.slice(cursor, o.offset) + o.clipboardText
      cursor = o.offset + o.length
    }
    text += draft.slice(cursor, copyEnd)
    e.clipboardData.setData('text/plain', text)
    if (cut && !machineBusy && !locked) {
      keyboard.setDraft(
        draft.slice(0, copyStart) + draft.slice(copyEnd),
        { start: copyStart, end: copyEnd, insertedLength: 0 },
      )
      restoreCaret(el, copyStart)
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (keyboard === undefined) return // absent machine: no draft can accept a paste
    if (machineBusy || locked) return
    const files = Array.from(e.clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length > 0) intakeImages(files)
    const text = e.clipboardData.getData('text/plain')
    if (text === '') {
      if (files.length > 0) e.preventDefault()
      return
    }
    e.preventDefault()
    const el = e.currentTarget
    const sel = selectionOf(el)
    // 本层的同步组件保持为空：热快照匹配需要 Slash 来源表，它位于 keyboard.track
    // 之后。粘贴尝试在状态机中开启，匹配到达时由控制器把词元升级为引用
    //（paste-upgrade）；DOM 层只负责开始事务。
    keyboard.pasteBegin(text, sel)
    const caret = sel.start + text.length
    restoreCaret(el, caret)
    keyboard.track(keyboard.snapshot.draft, caret)
  }

  // 接收前预检（DeepSeek Chat 语义）：新增内容若会突破投影限制，则整批拒绝、立即
  // 提示，并且从不进入附件栏，不再等到提交失败后回滚附件栏。对于绕过本编辑器的
  // 调用方，Host 会在提交时执行相同限制。
  const intakeImages = useCallback((files: readonly File[]): void => {
    if (addImages === undefined || files.length === 0) return
    const rejected = ((): string | null => {
      if (imageLimits !== undefined) {
        // 格式检查先于限制检查，遵循 DeepSeek Chat 的过滤顺序：批次中若有非图片，
        // 应提示格式问题，而不是它无论如何也无法通过的数量或大小限制；addImages
        // 会权威地拒绝它。
        if (files.some(file => !(imageLimits.mediaTypes as readonly string[]).includes(file.type))) {
          return addImages(files)
        }
        if (attachments.length + files.length > imageLimits.maxImagesPerMessage) {
          return t('image.tooMany', { count: imageLimits.maxImagesPerMessage })
        }
        if (files.some(file => file.size > imageLimits.maxImageBytes)) {
          return t('image.fileTooLarge', { size: imageSizeText(imageLimits.maxImageBytes) })
        }
        const total = attachments.reduce((sum, attachment) => sum + attachment.file.size, 0)
          + files.reduce((sum, file) => sum + file.size, 0)
        if (total > imageLimits.maxMessageImageBytes) {
          return t('image.totalTooLarge', { size: imageSizeText(imageLimits.maxMessageImageBytes) })
        }
      }
      return addImages(files)
    })()
    if (rejected !== null) showToast(rejected)
  }, [addImages, attachments, imageLimits, showToast, t])

  const canAcceptDrop = !locked && !machineBusy && addImages !== undefined

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    // 任意光标/选区手势都会结束实时粘贴尝试，因为状态机无法观测 DOM 选区；
    // 没有活动尝试时是低成本无操作。
    if (keyboard !== undefined && keyboard.snapshot.paste !== undefined) keyboard.invalidatePaste()
    void e
  }

  // 按按钮会从 textarea 抢走焦点，因此在 mousedown 时阻止，使输入无缝继续。
  // `preventScroll` 与解锁 effect 原因相同，且不自行揭示：光标没有移动，下一次
  // 按键会获得浏览器原生揭示。
  const keepFocus = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
  }

  const onToggleCommandMenu = (): void => {
    const el = inputRef.current
    if (el !== null) toggleCommandMenu?.(selectionOf(el))
  }

  // 普通会话保留主 Send/Stop 切换。可继续子会话以 Send 为主操作，同时独立暴露
  // Stop，使鼠标用户能在当前轮次运行时继续排队后续消息。
  const primaryStops = running && subagent === null
  const interruptible = running && continuable
  const primaryLabel = primaryStops ? t('input.stop') : t('input.send')
  const onPrimary = (): void => {
    if (primaryStops) {
      stop?.()
      return
    }
    if (inputActions === undefined) return // absent machine: the button is disabled
    /* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
    if (!empty && !disabled && !machineBusy) inputActions.submit()
  }

  // Access 座位：由投影提供数据的权限胶囊。permissions 键缺失（Host 无权限能力
  // 或 Draft）或命令接口随会话一起缺失时，不渲染任何内容。
  const accessSelect: ReactNode = command === undefined
    ? null
    : <PermissionSelect key={sessionId} value={permissions} locked={locked} command={command} t={t} />

  // 镜像层装饰：可见背景层叠加透明 textarea 文本。认领词元和引用保留草稿自身
  // 字形度量，因此装饰不会与换行、选区或光标发生偏移。
  const deco = input === undefined ? INERT_DECORATIONS : deriveDecorations(input, lexicon)
  const backdrop: ReactNode[] = []
  {
    // 分段边界包括词元区间末尾、每个结构化引用偏移和每个文本引用区间，并按草稿
    // 顺序合并。来源永不重叠：结构化引用拥有自己的区间，文本引用拥有普通词元，
    // 认领词元只位于开头。
    let cursor = 0
    const pushPlain = (upTo: number): void => {
      if (upTo > cursor) backdrop.push(draft.slice(cursor, upTo))
      cursor = upTo
    }
    if (deco.token !== null) {
      backdrop.push(
        <mark key="token" className={css.hlToken} data-decoration="token">
          {draft.slice(deco.token.start, deco.token.end)}
        </mark>,
      )
      cursor = deco.token.end
    }
    type Boundary =
      | { at: number; kind: 'chip'; chip: (typeof deco.chips)[number] }
      | { at: number; kind: 'text-ref'; ref: (typeof deco.textRefs)[number]; ordinal: number }
    const boundaries: Boundary[] = [
      ...deco.chips.map(chip => ({ at: chip.offset, kind: 'chip' as const, chip })),
      ...deco.textRefs.map((ref, ordinal) => ({ at: ref.start, kind: 'text-ref' as const, ref, ordinal })),
    ].sort((a, b) => a.at - b.at)
    for (const b of boundaries) {
      if (b.at < cursor) continue // claim-token overlap: the leading mark wins
      pushPlain(b.at)
      if (b.kind === 'chip') {
        const chip = b.chip
        backdrop.push(
          <span
            key={`chip-${chip.occurrenceId}`}
            className={clsx(css.chip, chip.invalid && css.chipInvalid)}
            data-decoration="chip"
            data-reference-appearance={chip.appearance}
            data-occurrence={chip.occurrenceId}
            data-invalid={chip.invalid || undefined}
            title={chip.label}
          >
            {chip.appearance === undefined
              ? chip.text[0]
              : (
                <span className={css.chipTrigger}>
                  <span className={css.chipTriggerGlyph}>{chip.text[0]}</span>
                  <ReferenceIcon kind={chip.appearance} size={16} className={css.chipIcon} />
                </span>
              )}
            <span>{chip.text.slice(1)}</span>
          </span>,
        )
        cursor = chip.offset + chip.length
      } else {
        // 普通区间高亮：字形仍属于 textarea，字宽不变；mark 只绘制胶囊外观。
        // 键使用草稿顺序序号：每次渲染都会重新扫描派生这些区间，因此它们没有超出
        // 位置的身份。若用草稿偏移作键，在前方每输入一个字符都会卸载 mark 和图标。
        // 结构化引用则以 occurrenceId 为键，这是实例表拥有的身份。
        const text = draft.slice(b.ref.start, b.ref.end)
        backdrop.push(
          <mark key={`ref-${b.ordinal}`} className={css.textRef} data-decoration="text-ref">
            {b.ref.appearance === 'folder'
              ? (
                <>
                  <span className={css.textRefTrigger}>
                    <span className={css.textRefTriggerGlyph}>{text[0]}</span>
                    <ReferenceIcon kind="folder" size={16} className={css.textRefIcon} />
                  </span>
                  {text.slice(1)}
                </>
              )
              : text}
          </mark>,
        )
        cursor = b.ref.end
      }
    }
    pushPlain(draft.length)
    if (deco.hint !== null) {
      // 认领词元格式为 `/name `，带尾随空格；这里裁剪为裸名称。
      const commandName = input?.claim?.token.slice(1).trim() ?? ''
      const hintKey = `hint.${commandName === 'goal' && hasGoal ? 'goal.active' : commandName}`
      // 按已认领命令名动态查找：未知命令不会命中字典，并保留状态机自身提示，
      // 因此这里使用宽类型调用。
      const translated = (t as Translate)(hintKey)
      const displayHint = translated !== hintKey ? translated : deco.hint
      backdrop.push(<span key="hint" className={css.hint} data-decoration="hint">{displayHint}</span>)
    }
  }

  return (
    <div className={clsx(css.root, variant === 'hero' && css.hero)}>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={cardRef.current}
          onDone={dismissToast}
        />
      )}
      {notice?.level === 'info' && (
        <div className={css.notice} role="status">
          {notice.text}
        </div>
      )}
      {/* 触发点击落在卡片而非 textarea：工具栏中 disabled 控件会吞掉点击（CSS 状态
          会禁用其指针事件），因此整个胶囊都是选择目标。在这里停止 pointerdown，
          避免 Menu 的外部关闭与 click 重新打开竞态；先关后开会让胶囊打开反馈闪烁。 */}
      <div
        ref={cardRef}
        className={clsx(css.card, workspaceTrigger && css.cardWorkspaceTrigger)}
        data-composer-card
        onClick={workspaceTrigger ? onRequestWorkspace : undefined}
        onPointerDown={workspaceTrigger ? (e) => { e.stopPropagation() } : undefined}
      >
        {overlay !== undefined && <div className={css.overlayAnchor}>{overlay}</div>}
        {accessory !== undefined && <div className={css.accessory}>{accessory}</div>}
        {renderSlot('conversation.input.attachments', {
          attachments,
          canAcceptDrop,
          onAddImages: intakeImages,
          onRemoveImage: (id) => { removeImage?.(id) },
          dropLimits: imageLimits === undefined ? undefined : {
            count: imageLimits.maxImagesPerMessage,
            size: imageSizeText(imageLimits.maxImageBytes),
          },
        })}
        {/* 一个滚动区、两个文本层。隐藏镜像渲染 draft+'\n'，把堆叠撑到草稿完整高度；
            只按 '\n' 计行无法看到软换行。绝对定位的背景层和 textarea 共用该高度，
            CSS 限制为 14 行的 .scroll 是唯一滚动元素。光标属于 textarea，字形属于
            背景层，两者只有同步移动才能保持一致：浏览器用一个滚动偏移同时作用于
            两层，而不是用 JS 在两个框之间同步；后者会被合成器驱动的手势超越，
            导致文字落后于光标。 */}
        <div ref={scrollRef} className={css.scroll} data-input-scroll>
          <div className={css.grow}>
            <div
              aria-hidden
              className={clsx(css.backdrop, textareaDisabled && css.backdropDisabled)}
              data-input-backdrop
              data-disabled={textareaDisabled || undefined}
            >
              {backdrop}
            </div>
            <textarea
              ref={inputRef}
              className={css.input}
              value={draft}
              disabled={textareaDisabled}
              readOnly={machineBusy || workspaceTrigger}
              aria-label={workspaceTrigger ? t('hero.chooseWorkspace') : undefined}
              aria-haspopup={workspaceTrigger ? 'menu' : undefined}
              aria-expanded={workspaceTrigger ? workspacePickerOpen : undefined}
              data-phase={input?.phase ?? 'inert'}
              placeholder={placeholder ?? (parentOffline
                ? t('placeholder.parentOffline')
                : disabled
                  ? t('placeholder.unavailable')
                  // steer 提示有意高于 plan 占位文案：它显示时，整队列手势确实可用，
                  // 因为门禁从不检查 plan 模式，所以可执行提示优先。
                  : canSteerQueue
                    ? t('placeholder.steerQueue')
                    : planActive ? t('placeholder.plan') : t('placeholder.default'))}
              rows={2}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onSelect={onSelect}
              onCopy={(e) => { onCopyOrCut(e, false) }}
              onCut={(e) => { onCopyOrCut(e, true) }}
              onPaste={onPaste}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
            />
            <div ref={mirrorRef} aria-hidden className={css.mirror} data-input-mirror>{`${draft}\n`}</div>
          </div>
        </div>
        <div className={css.row}>
          <div className={css.tools}>
            <Tooltip label={t('input.commands')} side="top" delayMs={500}>
              <button
                type="button"
                className={css.add}
                aria-label={t('input.commands')}
                aria-haspopup="listbox"
                aria-expanded={commandMenuOpen}
                disabled={locked || toggleCommandMenu === undefined}
                onMouseDown={keepFocus}
                onClick={onToggleCommandMenu}
              >
                <IconPlusOutline16 size={14} />
              </button>
            </Tooltip>
            <div className={css.modes}>
              {accessSelect}
              {renderSlot('conversation.input.plan', { locked })}
            </div>
            {leftItems}
          </div>
          <div className={css.trailing}>
            {rightItems}
            {renderSlot('conversation.input.model', { locked: modelSeatLocked })}
            <ContextMeter useProjection={useProjection} t={t} />
            {interruptible && (
              <Tooltip label={t('input.stop')} side="top" delayMs={500}>
                <button
                  type="button"
                  className={css.primary}
                  aria-label={t('input.stop')}
                  disabled={stop === undefined}
                  onMouseDown={keepFocus}
                  onClick={stop}
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                  </svg>
                </button>
              </Tooltip>
            )}
            <Tooltip label={primaryLabel} side="top" delayMs={500}>
              <button
                type="button"
                className={css.primary}
                aria-label={primaryLabel}
                disabled={primaryStops ? stop === undefined : empty || disabled || machineBusy}
                onMouseDown={keepFocus}
                onClick={onPrimary}
              >
                {primaryStops ? (
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                  </svg>
                )}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      {footer}
    </div>
  )
}
