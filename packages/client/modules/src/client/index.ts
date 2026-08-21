/**
 * 浏览器端（标准 `./client` 导出）：提供模块系统类、传输约定和注册插件入口。模块
 * 系统本身由 shell 内核在 cordis 创建前构建；这是启动特例，因为加载插件的机制
 * 不能由自身加载。插件入口只把已有实例注册为 `ctx.modules`。内核会静态注册本模块，
 * 因此本包的图条目不会触发真实获取，对已注册条目执行到达操作等同于无操作。
 * @module @deepseek-ai/dsh-client-modules/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DshWindow } from './manifest.ts'

export { ClientModuleSystem } from './system.ts'
export { parseBootManifest } from './manifest.ts'
export type {
  BootManifest, BootModuleRow, BootPluginRow, ClientModuleLoader, ClientModuleRecord,
  ClientModuleSystemOptions, ClientPluginHandoff, DshWindow, WebBootEntry, WebBootGraph,
} from './manifest.ts'

/**
 * 将内核构建的模块系统注册为 `ctx.modules`。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: Context): void {
  const modules = (globalThis as DshWindow).__DSH_MODULES__
  // 内核构造实例后、任何 cordis 条目出现前就会写入槽位；槽位缺失表示内核时序错误。
  if (modules === undefined) {
    throw new Error('client-modules: window.__DSH_MODULES__ missing — the shell kernel must construct the module system before plugin boot')
  }
  ctx.reflect.provide('modules', modules)
}
