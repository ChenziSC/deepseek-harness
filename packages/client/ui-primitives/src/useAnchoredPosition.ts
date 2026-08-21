/**
 * 让固定定位浮动元素始终锚定到触发器。
 *
 * 传送面板根据锚点的视口矩形定位，一旦任意位置滚动或窗口缩放，原坐标就会失效。
 * 本模块只负责这一件事：测量锚点，把面板偏移到其下方，将结果限制在视口内；
 * 打开期间在滚动（使用捕获阶段，因此也能捕获页面内嵌滚动容器）、窗口缩放和
 * 面板自身尺寸变化时重新执行。
 * @module @deepseek-ai/dsh-client-ui-primitives/useAnchoredPosition
 */

import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/** {@link useAnchoredPosition} 的输入。 */
export interface AnchoredPositionOptions {
  /** 浮动元素是否已挂载并应跟踪锚点。 */
  open: boolean
  /** 面板定位所依据的元素。 */
  anchorRef: RefObject<HTMLElement | null>
  /** 浮动元素；测量后让限位使用真实尺寸。 */
  panelRef: RefObject<HTMLElement | null>
  /** 锚点底边与面板顶边之间保留的距离。 */
  gap: number
  /** 面板与视口各边之间保留的距离。 */
  margin: number
}

/**
 * 跟踪锚点并返回面板的固定坐标。
 * @param options - 打开状态、两个 ref，以及 gap/margin 距离。
 * @returns 面板的 `left`/`top`；首次测量前为 `null`。
 */
export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, gap, margin } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const place = () => {
      /* v8 ignore start -- geometry read from real layout: jsdom reports zero
         offset sizes, so the positive-size clamp arms are exercised by browser
         scenarios rather than unit tests. */
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const panel = panelRef.current
      const width = panel?.offsetWidth ?? 0
      const height = panel?.offsetHeight ?? 0
      let left = rect.left
      let top = rect.bottom + gap
      if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
      if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin)
      /* v8 ignore stop */
      setPosition({ left, top })
    }
    // 首次运行在打开面板的同一次提交中测量，使限位在任何内容绘制前使用真实尺寸。
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // 面板自身高度可能在没有滚动或缩放事件时变化，例如内部出现状态行，或用户把
    // `resize: vertical` textarea 拖高。过期限位会让靠近底边的面板越过应遵守的边距。
    // 此保护使 hook 在缺少 `ResizeObserver` 的环境仍可用，jsdom 就以这种方式运行。
    const panel = panelRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && panel !== null) {
      observer = new ResizeObserver(place)
      observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, panelRef, gap, margin])
  return position
}
