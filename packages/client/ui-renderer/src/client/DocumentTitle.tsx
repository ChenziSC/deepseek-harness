import { useEffect } from 'react'

const DEFAULT_CLIENT_TITLE = 'DSH Local Build'

/** 浏览器标题投影的属性。 */
export interface DocumentTitleProps {
  /** 已选会话的持久标题；undefined 表示使用产品标题。 */
  title?: string
}

/**
 * 将已选会话的持久标题投影到浏览器标题，并在卸载时恢复构建时选定的产品标题。
 * @param props - 已选会话的标题投影。
 * @returns 不渲染任何内容。
 */
export function DocumentTitle({ title }: DocumentTitleProps): null {
  const productTitle = process.env.DSH_CLIENT_TITLE ?? DEFAULT_CLIENT_TITLE
  useEffect(() => {
    document.title = title === undefined ? productTitle : `${title} — ${productTitle}`
    return () => { document.title = productTitle }
  }, [productTitle, title])
  return null
}
