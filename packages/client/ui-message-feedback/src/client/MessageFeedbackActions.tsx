/**
 * 每条消息的反馈控件：点赞/点踩按钮和可选备注。按钮渲染在助手消息的
 * IconActions 行中，因此复用该行样式，并位于复制与分支操作之间。备注编辑器
 * 是锚定到触发按钮、传送至 `document.body` 的浮层，而不是行内展开：260px
 * 文本框和按钮在任何视口下都放不进行内，行内元素还会把分支操作和时间挤出
 * 会话列。传送到列外也能避开 `overflow` 裁剪，使面板不会被截断或与所注释
 * 的消息脱离。
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client/MessageFeedbackActions
 */

import {
  useCallback, useEffect, useRef, useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconDislikeOutline16, IconLikeOutline16, Tooltip, useAnchoredPosition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageFeedbackRating } from '@deepseek-ai/dsh-message-feedback/types'
import type { MessageFeedbackActionProps } from './slots.ts'
import css from './MessageFeedbackActions.module.css'

/** 面板与视口边缘之间的安全距离，与 Menu 浮层边距一致。 */
const PANEL_MARGIN = 12

/** 触发按钮底边与面板顶边之间的距离。 */
const PANEL_GAP = 4

/**
 * 尚未定位的浮层面板：保持隐藏但参与布局，让限位计算能取得真实 `offsetWidth`。
 * 显式边距与 `Menu` 的测量样式一致；否则，边距为 auto 的 `position: fixed`
 * 元素会停在静态位置，与首次定位所用的测量原点不同。
 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * 一条消息的反馈控件。
 * @param props - 拥有者提供的消息身份、注入的操作，以及共享反馈 hook。
 * @returns 评分按钮和备注触发器；打开时，备注编辑器以浮层形式显示在触发器下方。
 */
export function MessageFeedbackActions({ messageId, ensure, rate, toggle, clearNote, useFeedback, t }: MessageFeedbackActionProps) {
  const item = useFeedback(view => view.items.get(messageId))
  const loadFailed = useFeedback(view => view.status === 'error')
  const rating = item?.rating
  const [noteOpen, setNoteOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  // 评分或加载失败显示在评分按钮旁，无论备注浮层是否打开都始终可见。
  const [rowFailure, setRowFailure] = useState<string | null>(null)
  // 备注保存失败显示在用户正在查看的备注浮层内；浮层保持打开，让草稿可继续修正。
  const [noteFailure, setNoteFailure] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 每条已完成消息都会挂载这些控件，因此会话反馈延迟到首次悬停/聚焦时读取一次，
  // 而不是在挂载时读取。
  const seeded = useRef(false)
  const seed = useCallback(() => {
    if (seeded.current) return
    seeded.current = true
    void ensure()
  }, [ensure])

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  /** 每次编辑会话结束时递增，让迟到的保存结果能识别自己已经过期。 */
  const noteGeneration = useRef(0)

  /** 当前面板打开状态；过期闭包也能通过 ref 读取最新值。 */
  const noteOpenRef = useRef(false)
  useEffect(() => { noteOpenRef.current = noteOpen }, [noteOpen])

  const errorCopy = useCallback((result: { ok: boolean; error?: { code: string } }) => {
    return result.error?.code === 'version-conflict' ? t('error.conflict') : t('error.generic')
  }, [t])

  const settleRating = useCallback((result: { ok: boolean; error?: { code: string } }) => {
    if (!alive.current) return
    setPending(false)
    setRowFailure(result.ok ? null : errorCopy(result))
  }, [errorCopy])

  const closeNote = useCallback(() => {
    // 结束编辑会话，使仍在途的保存请求变为过期结果。
    noteGeneration.current += 1
    setNoteOpen(false)
  }, [])

  const onRate = useCallback((next: MessageFeedbackRating) => {
    setPending(true)
    setRowFailure(null)
    // 控制器根据已提交条目决定撤回还是替换，因此即使点击早于首次列表读取，
    // 也会切换已存值，而不是依赖本次渲染中的空视图。
    closeNote()
    void toggle(messageId, next).then(settleRating)
  }, [closeNote, messageId, settleRating, toggle])

  // rating 作为参数传入，因为只有备注编辑器的渲染位置能证明评分已经记录；
  // 这样可移除这里永远不会触发的 undefined 保护。
  const onSaveNote = useCallback((current: MessageFeedbackRating) => {
    const trimmed = draft.trim()
    setPending(true)
    setNoteFailure(null)
    // 保存请求属于发起它的编辑会话。关闭并重新打开面板会创建新会话，旧会话迟到
    // 的响应不得作用于新会话：过期成功会关闭用户刚打开的面板，过期失败则会错误
    // 描述新会话从未发送的草稿。
    const generation = noteGeneration.current
    // 若在本次保存提交前重新打开会话，它会以此值初始化。
    const staleSeed = item?.note ?? ''
    // 清空编辑器表示显式删除备注；单独调用 `rate` 会保留已有备注，无法表达删除。
    const settled = trimmed.length === 0
      ? clearNote(messageId)
      : rate(messageId, current, trimmed)
    void settled.then((result) => {
      if (!alive.current) return
      // `pending` 跟踪在途请求，而不是编辑会话，因此无论结果如何都要释放；点赞、
      // 点踩和保存都读取 `disabled={pending}`，不释放会让整行锁定到下次重新挂载。
      // 无条件释放是安全的，因为三者是仅有的变更入口且都受它保护，同一时刻最多
      // 只有一个请求。若未来新增绕过该保护的入口，就必须让 `pending` 绑定代次，
      // 而不能在这里直接清除。
      setPending(false)
      if (result.ok) {
        // 只有仍然打开的原会话可以处理成功结果：关闭已丢弃草稿，重开则初始化了新草稿。
        if (generation === noteGeneration.current) {
          setNoteFailure(null)
          setNoteOpen(false)
          return
        }
        // 新会话已经打开，并用本次保存提交前读到的备注初始化。若用户尚未编辑，就
        // 重新同步为已存值，避免下次保存覆盖刚落盘的文本；用户已经编辑的草稿则保留。
        setDraft(draftNow => (draftNow === staleSeed ? trimmed : draftNow))
        return
      }
      // 屏幕上仍是原会话时，失败应显示在其面板内。已放弃会话的失败只有在没有新会话
      // 接管时才报告：此时由行内承载，避免用户离开后发生的保存失败被静默丢弃。
      // 若写入重开的面板，反而会用旧尝试的错误标记新草稿。这里读取 `noteOpenRef`，
      // 而不是创建闭包时的 `noteOpen`；因为保存与完成之间若发生关闭再打开，闭包内
      // 保存的仍是请求发起时的面板状态。
      if (generation === noteGeneration.current || !noteOpenRef.current) {
        setNoteFailure(errorCopy(result))
      }
    })
  }, [clearNote, draft, errorCopy, item?.note, messageId, noteOpenRef, rate])

  // 触发按钮负责切换：关闭时打开浮层并用已记录备注初始化草稿，打开时则关闭。
  // 通过触发按钮关闭也能正确配合内外区域逻辑，因为按钮属于面板的“内部”区域。
  const toggleNote = useCallback(() => {
    if (noteOpen) {
      closeNote()
      return
    }
    setDraft(item?.note ?? '')
    // 备注保存失败属于产生它的编辑会话。失败时面板保持打开以便修正草稿；一旦关闭
    // 再打开，草稿会从已存备注重新初始化，沿用旧错误就会描述新草稿从未做过的尝试。
    // 面板关闭后才到达的失败会显示在行内；新会话开始时在这里清除该提示。
    setNoteFailure(null)
    setNoteOpen(true)
  }, [noteOpen, closeNote, item?.note])

  // 绘制前根据触发按钮矩形定位浮层，并在滚动/缩放时让它跟随触发按钮；
  // 这与 `Menu` 浮层模式使用相同的锚定方式。
  const pos = useAnchoredPosition({
    open: noteOpen,
    anchorRef: triggerRef,
    panelRef,
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })

  // 打开后聚焦输入框，并在按 Escape 或指针按下发生于外部时关闭。
  useEffect(() => {
    if (!noteOpen) return
    inputRef.current?.focus()
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return
      if (triggerRef.current?.contains(e.target) === true) return
      if (panelRef.current?.contains(e.target) === true) return
      closeNote()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNote()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [noteOpen, closeNote])

  // 仅在面板确实关闭时把焦点还给触发按钮，初次挂载时不执行；新渲染且已有评分
  // 的消息不应把焦点拉入自己的操作行。
  const wasOpen = useRef(false)
  useEffect(() => {
    if (noteOpen) { wasOpen.current = true; return }
    if (wasOpen.current) triggerRef.current?.focus()
    wasOpen.current = false
  }, [noteOpen])

  const likeLabel = rating === 'positive' ? t('action.likeActive') : t('action.like')
  const dislikeLabel = rating === 'negative' ? t('action.dislikeActive') : t('action.dislike')

  return (
    <>
      <Tooltip label={likeLabel} side="bottom">
        <button
          type="button"
          className={css.action}
          aria-label={likeLabel}
          aria-pressed={rating === 'positive'}
          data-active={rating === 'positive' || undefined}
          disabled={pending}
          onFocus={seed}
          onPointerEnter={seed}
          onClick={() => { onRate('positive') }}
        >
          <IconLikeOutline16 />
        </button>
      </Tooltip>
      <Tooltip label={dislikeLabel} side="bottom">
        <button
          type="button"
          className={css.action}
          aria-label={dislikeLabel}
          aria-pressed={rating === 'negative'}
          data-active={rating === 'negative' || undefined}
          disabled={pending}
          onFocus={seed}
          onPointerEnter={seed}
          onClick={() => { onRate('negative') }}
        >
          <IconDislikeOutline16 />
        </button>
      </Tooltip>
      {rating !== undefined && (
        <button
          ref={triggerRef}
          type="button"
          className={css.noteOpen}
          aria-haspopup="dialog"
          aria-expanded={noteOpen}
          onClick={toggleNote}
        >
          {item?.note === undefined ? t('note.open') : item.note}
        </button>
      )}
      {rowFailure === null && loadFailed && (
        <span className={css.failure} role="status">{t('error.load')}</span>
      )}
      {rowFailure !== null && <span className={css.failure} role="status">{rowFailure}</span>}
      {/* 备注保存失败通常显示在面板内、触发它的按钮旁。面板不在屏幕上时则退回行内：
          打开的编辑器下方可能已经没有评分（另一客户端撤回反馈，或
          `version-conflict` 响应提交 `current: null` 后条目消失），用户也可能在
          缓慢保存返回前关闭面板。无论哪种情况，都由行内报告保存未成功，而不丢弃错误。 */}
      {!(rating !== undefined && noteOpen) && noteFailure !== null && (
        <span className={css.failure} role="status">{noteFailure}</span>
      )}
      {rating !== undefined && noteOpen && createPortal(
        <div
          ref={panelRef}
          className={css.notePanel}
          role="dialog"
          aria-label={t('note.dialog')}
          style={pos ?? MEASURE_STYLE}
        >
          <textarea
            ref={inputRef}
            className={css.noteInput}
            aria-label={t('note.aria')}
            placeholder={t('note.placeholder')}
            value={draft}
            rows={3}
            onChange={(event) => { setDraft(event.target.value) }}
          />
          <div className={css.noteActions}>
            <button
              type="button"
              className={css.noteSave}
              disabled={pending}
              onClick={() => { onSaveNote(rating) }}
            >
              {t('note.save')}
            </button>
            <button type="button" className={css.noteCancel} onClick={closeNote}>
              {t('note.cancel')}
            </button>
          </div>
          {noteFailure !== null && <span className={css.failure} role="status">{noteFailure}</span>}
        </div>,
        document.body,
      )}
    </>
  )
}
