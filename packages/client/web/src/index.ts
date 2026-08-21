/**
 * Web shell 库入口。shell 的产物是 {@link AppWebEntry}，apps/web 的 Vite
 * 入口将其运行在 #root 上。其余内容（AppRoot 门控、app-shell 装配配置项、
 * 模块表 staticModules 和平台常量）均为启动链内部实现。重新导出
 * PLATFORM_MODULES，作为 tsdown 客户端 externals 投影的唯一真源。
 * @module @deepseek-ai/dsh-client-web
 */

export { AppWebEntry, type BootSeams } from './boot.tsx'
export { AppRoot, type AppRootProps } from './AppRoot.tsx'
export { buildRenderApp, type AssemblyDeps } from './app.tsx'
export { DocumentTitle, type DocumentTitleProps } from './DocumentTitle.tsx'
export { APP_SHELL_ID, type AppShellService } from './app-shell.ts'
export { getStaticModules } from './seed.ts'
export { PLATFORM_MODULES, type PlatformModule } from './platform.ts'
export {
  STATE_LABELS, FIBER_STATE, createSignal, createLoaderStatusStore,
  type LoaderStatus, type LoaderEntryState, type KernelSignal, type KernelValueSignal, type LoaderStatusStore,
} from './loader-status.ts'
