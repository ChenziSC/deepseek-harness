/**
 * 真实 UI 的装配闭包，在 app-shell 插件的 inject 集合激活后调用。整个布局树
 * 挂在内置 `root` slot 下：ui-layout 在该位置注册 AppFrame，并在内部渲染
 * 子 slot。shell 的渲染是程序中唯一一次 ctx 级 renderSlot 调用。
 */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { DocumentTitle } from './DocumentTitle.tsx'
// 仅类型导入：把 runtime 的 SlotMap 声明合并（`root` 键）带入本程序。
import type {} from '@deepseek-ai/dsh-client-runtime/client'

/** 装配输入：已激活 app-shell 插件的 ctx，其中已提供 slots、sessions 和 layout 服务。 */
export interface AssemblyDeps {
  /** 装配所需 inject 集合均已激活的客户端上下文。 */
  ctx: Context
}

/**
 * 创建 app-shell 插件提供给 AppRoot 的 renderApp 工厂。
 * @param deps - 装配输入。
 * @returns 生成真实 UI 树的工厂；结算后每次 AppRoot 渲染调用一次。
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('shell assembly: sessions service unavailable')
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
