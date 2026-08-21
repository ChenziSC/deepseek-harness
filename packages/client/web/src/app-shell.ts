/**
 * app-shell 装配插件。它的伪包 id 只存在于宿主图和 shell 注册表中，
 * 并不存在对应的 npm 包。
 */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import { buildRenderApp } from './app.tsx'

/** 宿主图挂载本插件时使用的、由 shell 所有的伪配置项 id。 */
export const APP_SHELL_ID = '@deepseek-ai/dsh-client-app-shell'

/** 启动结算后由 AppRoot 渲染的已装配 UI 接口。 */
export interface AppShellService {
  /** 创建一次并渲染真实 UI 树。 */
  renderApp: () => ReactNode
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** shell 装配接口；app-shell 配置项的 inject 集合激活后提供。 */
    appShell: AppShellService
  }
}

/** Cordis 插件名称。 */
export const name = 'app-shell'

/** shell 装配前必须就绪的服务。 */
export const inject = ['slots', 'sessions', 'layout']

/** 安装 React 渲染器并公开装配后的应用。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  // 渲染器安装属于 shell（web-react 随 shell 打包），但只有 runtime 配置项激活后
  // ctx.slots 才存在，因此安装逻辑位于这里，由本配置项的 inject 集合保证顺序。
  ctx.slots.install(createSlotRenderer())

  // 首次渲染时只装配一次；AppRoot 重渲染期间闭包标识必须保持稳定。
  let renderApp: (() => ReactNode) | undefined
  ctx.reflect.provide('appShell', {
    renderApp: (): ReactNode => {
      renderApp ??= buildRenderApp({ ctx })
      return renderApp()
    },
  })
}
