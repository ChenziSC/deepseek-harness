/**
 * 浏览器端（标准 `./client` 导出）：提供模块系统类、传输约定和注册插件入口。模块
 * 系统由 shell 内核在 cordis 创建前构建；这是启动特例，因为加载插件的机制不能由
 * 自身加载。Host 解析器会把这个普通 client bundle 预载到待注册队列。HTML 安装的
 * loader facade 实例化该 bundle 并调用其启动导出；后者构建系统，并为本包的图条目
 * 保留同一份 exports。插件入口只把这个既有实例注册为 `ctx.modules`。
 * @module @deepseek-ai/dsh-client-modules/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { ClientModuleSystem } from './system.ts'
import { parseBootManifest } from './manifest.ts'
import type {
  ClientBootstrapModule, ClientModuleCreateOptions, ClientModuleLoaderTarget,
} from './manifest.ts'

export { ClientModuleSystem }
export { parseBootManifest, stripClientSuffix } from './manifest.ts'
export type {
  BootManifest, BootModuleRow, BootPluginRow, ClientBootstrapModule, ClientBundleRegistration,
  ClientModuleCreateOptions, ClientModuleLoader, ClientModuleLoaderTarget, ClientModuleRecord,
  ClientModuleSystemOptions, DshWindow,
  WebBootEntry, WebBootGraph,
} from './manifest.ts'

let moduleSystem: ClientModuleSystem | undefined

/**
 * 根据 HTML facade 已实例化的 modules bundle 构建活动模块系统。
 * @param target - 稳定的注册 facade；其待处理队列随后转换为活动接收器。
 * @param bootstrapModule - 本 bundle 的 id 和已实例化 exports。
 * @param options - 原始启动图、平台 seed 和可选 bundle transport。
 * @returns 创建的模块系统；同时发布给本包的 Cordis 插件入口。
 */
export function createClientModuleSystem(
  target: ClientModuleLoaderTarget,
  bootstrapModule: ClientBootstrapModule,
  options: ClientModuleCreateOptions,
): ClientModuleSystem {
  moduleSystem = new ClientModuleSystem({
    manifest: parseBootManifest(options.boot),
    staticModules: options.staticModules,
    registrationTarget: target,
    bootstrapModule,
    ...(options.loadBundle === undefined ? {} : { loadBundle: options.loadBundle }),
  })
  return moduleSystem
}

/**
 * 将内核构建的模块系统注册为 `ctx.modules`。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: Context): void {
  if (moduleSystem === undefined) {
    throw new Error('client-modules: createClientModuleSystem must run before plugin boot')
  }
  ctx.reflect.provide('modules', moduleSystem)
}
