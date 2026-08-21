/**
 * `@deepseek-ai/dsh-client-runtime` 包自有的不变量伴随插件。
 * @module @deepseek-ai/dsh-client-runtime/invariant
 */

/* jscpd:ignore-start */
/* oxlint-disable typescript/no-redundant-type-constituents --
 * `keyof SlotMap & string` 是声明合并的键模式：本编译单元中的 SlotMap 为空，交叉
 * 类型读作 `never`，但消费者会合并键。规则命中的是空映射视图，并非真实冗余。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-runtime'

/** Cordis 伴随插件名称。 */
export const name = 'client-runtime-invariant'
/** 伴随插件注册前必须存在的服务。 */
export const inject = ['invariants']

/**
 * 本包负责的不变量：每次发出 'slots/changed'(key) 时，对应变更必须已经应用。
 * SlotCore 会在服务重新发出事件前同步递增该键的版本，因此分发时版本为零表示事件
 * 没有对应变更，或早于变更发出。
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'slots/changed') return
    const key: unknown = args[0]
    if (typeof key !== 'string' || key === '') {
      fail("'slots/changed' dispatched without a slot key argument")
      return
    }
    const slots = ctx.get('slots')
    // 事件载荷以普通字符串携带键，而 getVersion 在静态类型上以 SlotMap 为键；完成
    // 运行时字符串检查后再恢复 SlotMap 键类型。
    if (slots !== undefined && slots.getVersion(key as keyof SlotMap & string) === 0) {
      fail(`'slots/changed' fired for "${key}" before any mutation bumped its version — emission must follow the applied mutation`)
    }
  }, { global: true })
}

/**
 * 注册本包的不变量伴随插件。
 * @param ctx - 提供不变量服务的 Cordis 上下文。
 * @returns 安装成功后用于撤销注册的函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
