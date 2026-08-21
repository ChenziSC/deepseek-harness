/**
 * 浏览器 UI 渲染器。Cordis 依赖激活后安装 slot renderer，并公开挂载操作；完整的
 * 客户端插件名单结算后，Web 启动内核通过该操作接管页面。
 */
import { createElement, useLayoutEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from './scoped-slots.tsx'
import { buildRenderApp } from './app.tsx'

/** 基于会话对话快照的选择器钩子。 */
export type UseSession<Snap extends object = object> = SnapshotSelectorHook<Snap>

export type {
  ChainRenderOpts, HostObservable, RenderOpts, SessionProvideInfo, SnapshotSelectorHook,
  SlotRenderer, SlotRendererHost, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'
export type { SessionProviderProps } from './session-provider.tsx'

/** 向不依赖 UI 框架的启动内核公开的挂载操作。 */
export interface UiRendererService {
  /**
   * 将已装配应用挂载到给定元素。
   * @param container - 应用挂载点。
   * @returns 卸载 React 根节点的 disposer。
   */
  mount: (container: HTMLElement) => () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** UI renderer 激活后提供的挂载接口。 */
    uiRenderer: UiRendererService
  }
}

/** 装配应用前必须就绪的服务。 */
export const inject = ['slots', 'sessions']

interface BootSnapshot {
  className: string
  html: string
}

/** 先水合启动内核所有的加载 DOM，再用应用替换它。 */
function BootHandoff(props: { app: () => ReactNode; boot: BootSnapshot }): ReactNode {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => { setReady(true) }, [])
  if (ready) return props.app()
  return createElement('div', {
    className: props.boot.className,
    'data-dsh-boot': '',
    dangerouslySetInnerHTML: { __html: props.boot.html },
  })
}

/** 通过水合保留不依赖框架的启动 DOM，同时挂载 React。 */
function mountApp(container: HTMLElement, app: () => ReactNode): Root {
  const boot = container.querySelector<HTMLElement>(':scope > [data-dsh-boot]')
  if (boot !== null) {
    return hydrateRoot(container, createElement(BootHandoff, {
      app,
      boot: { className: boot.className, html: boot.innerHTML },
    }))
  }
  const root = createRoot(container)
  flushSync(() => { root.render(app()) })
  return root
}

/**
 * 安装 slot renderer，并提供应用挂载接口。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.slots.install(createSlotRenderer())
  ctx.reflect.provide('uiRenderer', {
    mount: (container: HTMLElement): (() => void) => {
      const root = mountApp(container, buildRenderApp({ ctx }))
      return () => { root.unmount() }
    },
  })
}
