/**
 * 真实 UI 的装配闭包。整个布局树挂在内置 `root` slot 下；这是应用中唯一一次
 * ctx 级 slot 渲染。
 */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from './bind.ts'
import { DocumentTitle } from './DocumentTitle.tsx'
import type {} from '@deepseek-ai/dsh-client-runtime/client'

/** UI renderer 的 inject 集合激活后可用的装配输入。 */
export interface AssemblyDeps {
  /** 携带 slots 和 sessions 服务的客户端上下文。 */
  ctx: Context
}

/**
 * 创建已装配应用的工厂。
 * @param deps - 已激活的 UI renderer 依赖。
 * @returns 生成应用 React 树的工厂。
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('ui renderer: sessions service unavailable')
  const useSessions = bindSnapshotSelector(sessions.list)
  const SessionDocumentTitle = (): ReactNode => {
    const title = useSessions((state) => {
      const id = state.current
      return id === undefined ? undefined : state.byId[id]?.title
    })
    return <DocumentTitle {...title === undefined ? {} : { title }} />
  }
  return () => (
    <>
      <SessionDocumentTitle />
      {ctx.slots.renderSlot('root', {})}
    </>
  )
}
