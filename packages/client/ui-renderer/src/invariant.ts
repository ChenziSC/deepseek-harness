/**
 * `@deepseek-ai/dsh-client-ui-renderer` 包所有的不变量配套模块。
 * @module @deepseek-ai/dsh-client-ui-renderer/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-renderer'

/** Cordis 配套插件名称。 */
export const name = 'client-ui-renderer-invariant'
/** 配套模块登记包所有权前所需的服务。 */
export const inject = ['invariants']

/**
 * 无运行时不变量：本包安装渲染适配器并提供挂载回调，但不拥有事件流或跨插件的
 * 可变数据关系。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变量配套模块。
 * @param ctx - 带有不变量服务的 Cordis 上下文。
 * @returns 设置成功后，返回已安装注册项的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
