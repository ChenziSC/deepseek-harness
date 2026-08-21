/**
 * `@deepseek-ai/dsh-client-web` 包所有的不变量配套模块。
 * @module @deepseek-ai/dsh-client-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-web'

/** Cordis 配套插件名称。 */
export const name = 'client-web-invariant'
/** 配套模块登记包所有权前所需的服务。 */
export const inject = ['invariants']

/**
 * 无运行时不变量：Vite 入口 shell 只包含启动衔接和模块表播种，不产生 Cordis
 * 事件，也不持有跨插件可变状态。Web 冒烟 e2e 通过真实载体验证启动链
 * （加载页 → 结算 → 一次切换 UI）。
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
