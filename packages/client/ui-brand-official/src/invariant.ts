/**
 * `@deepseek-ai/dsh-client-ui-brand-official` 包拥有的 invariant companion。
 * @module @deepseek-ai/dsh-client-ui-brand-official/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-brand-official'

/** Cordis companion 插件名。 */
export const name = 'client-ui-brand-official-invariant'
/** Companion 声明包所有权前所需的服务。 */
export const inject = ['invariants']

/**
 * 无运行时 invariant：本包不保留可变状态，三个 Slot 占位组件通过同一个事务 effect 安装
 * 与离开。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的 invariant companion。
 * @param ctx - 携带 invariant 服务的 Cordis Context。
 * @returns 设置成功后已安装注册的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
