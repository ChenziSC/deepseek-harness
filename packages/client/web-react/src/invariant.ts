/**
 * `@deepseek-ai/dsh-client-web-react` 包所有的不变量配套模块。
 * @module @deepseek-ai/dsh-client-web-react/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-web-react'

/** Cordis 配套插件名称。 */
export const name = 'client-web-react-invariant'
/** 配套模块登记包所有权前所需的服务。 */
export const inject = ['invariants']

/**
 * 无运行时不变量：这里只是从 ctx 到 React 的纯衔接，不发送 Cordis 事件，也不拥有
 * 跨插件可变关系。存储批处理、选择器相等性短路和 inject 缓存标识直接由本包行为
 * 规格验证。
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
