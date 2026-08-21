/**
 * Web shell 库入口。shell 的产物是 {@link AppWebEntry}，apps/web 的 Vite 入口将其
 * 运行在 #root 上。启动页和 fiber 状态投影保持内部实现；静态模块表及其平台名称构成
 * 本包的构建期约定。
 * @module @deepseek-ai/dsh-client-web
 */

export { AppWebEntry, type BootSeams } from './boot.ts'
export { getStaticModules } from './seed.ts'
export { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS, type PlatformModule } from './platform.ts'
