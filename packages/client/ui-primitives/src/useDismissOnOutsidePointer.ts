/**
 * 触发器所拥有浮层（任务列表、Cordis 面板）的外部指针关闭逻辑：界面打开时，
 * 根元素外发生 pointerdown 即关闭。
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * pointerdown 落在根元素外时关闭已打开浮层。
 * @param root - 同时包含触发器和打开界面的元素。
 * @param open - 界面是否显示；false 时移除监听器。
 * @param setOpen - 外部 pointerdown 时以 false 调用的状态设置函数。
 */
export function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [root, open, setOpen])
}
