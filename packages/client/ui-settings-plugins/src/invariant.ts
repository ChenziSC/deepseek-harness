/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-settings-plugins`.
 * @module @deepseek-ai/dsh-client-ui-settings-plugins/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-plugins'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-plugins-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: 这是浏览器端设置界面，其 Node 端不拥有事件流或可变运行时数据；
 * 分层和写入拒绝属于 Host 约定，由拥有相关行为的插件和 api-proxy 覆盖。
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
