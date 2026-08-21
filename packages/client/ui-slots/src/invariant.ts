/**
 * `@deepseek-ai/dsh-client-ui-slots` 包所有的不变量配套模块。
 * @module @deepseek-ai/dsh-client-ui-slots/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-slots'

/** Cordis 配套插件名称。 */
export const name = 'client-ui-slots-invariant'
/** 配套模块登记包所有权前所需的服务。 */
export const inject = ['invariants']

/**
 * 无运行时不变量：这是零依赖的纯注册表核心，自身不发送 Cordis 事件；事件桥及其
 * 不变量归 runtime SlotRegistry 包装层所有。define、register、dispose 的顺序直接由
 * 本包行为规格验证。
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
