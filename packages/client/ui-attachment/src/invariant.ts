/**
 * `@deepseek-ai/dsh-client-ui-attachment` 包拥有的 invariant companion。
 * @module @deepseek-ai/dsh-client-ui-attachment/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-attachment'

/** Cordis companion 插件名。 */
export const name = 'client-ui-attachment-invariant'
/** Companion 声明包所有权前所需的服务。 */
export const inject = ['invariants']

/**
 * 无运行时 invariant：本包只贡献由 effect 拥有的 Slot 条目；Slot 注册表拥有其生命周期并
 * 校验声明。
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
