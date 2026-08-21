import { useEffect, useRef } from 'react'

/** shell 所有的浏览器标题投影属性。 */
export interface DocumentTitleProps {
  /** 已选会话的持久标题；undefined 表示使用产品标题。 */
  title?: string
}

/**
 * 将已选会话的持久标题投影到浏览器标题，并在卸载时恢复 shell 原始产品标题。
 * @param props - 已选会话的标题投影。
 * @returns 不渲染任何内容。
 */
export function DocumentTitle({ title }: DocumentTitleProps): null {
  const original = useRef(document.title)
  useEffect(() => {
    document.title = title === undefined ? original.current : `${title} — ${original.current}`
    return () => { document.title = original.current }
  }, [title])
  return null
}
