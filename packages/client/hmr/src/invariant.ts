/**
 * `@deepseek-ai/dsh-client-hmr` 包自有的不变量伴随插件。
 * @module @deepseek-ai/dsh-client-hmr/invariant
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-hmr'

/** Cordis 伴随插件名称。 */
export const name = 'client-hmr-invariant'
/** 伴随插件声明包所有权前必须存在的服务。 */
export const inject = ['invariants']

/** 当前活跃的 fs.watchFile 轮询器；本包是组合中唯一使用 stat 轮询的组件。 */
function statWatchers(): number {
  return process.getActiveResourcesInfo().filter(kind => kind === 'StatWatcher').length
}

/**
 * 本包负责的不变量：Node 端启动的每个 bundle stat 监听器都必须随其 fiber 一同销毁，
 * 否则开发链拆除后仍会永久重复计算 bundle 哈希。检查采用基线差值：fiber 创建时
 * 观察到的 StatWatcher 数量，必须在销毁过程排空该 fiber 的 effects 后恢复。
 * `internal/plugin` 在销毁开始时触发；先跳过一个微任务，使 disposer 能在
 * `fiber.await()` 等待前把 unload 加入队列。SSE 连接和监听器也由同一组 ctx.effect
 * disposer 拆除，因此监听器数量可作为这一关系的可观测代理。
 */
const install: InvariantInstaller = (ctx, fail) => {
  const baselines = new WeakMap<Fiber, number>()
  // 监听器有意设计为异步：emitPluginDisposed 会等待并记录返回的 Promise，因此
  // 违反不变量时会明确报告，而不会成为未处理异常。
  // oxlint-disable-next-line typescript/no-misused-promises
  ctx.on('internal/plugin', async (fiber) => {
    if (fiber.name !== 'client-hmr') return
    if (fiber.uid !== null) {
      baselines.set(fiber, statWatchers())
      return
    }
    const baseline = baselines.get(fiber)
    if (baseline === undefined) return
    await Promise.resolve()
    await fiber.await()
    const remaining = statWatchers()
    if (remaining > baseline) {
      fail(`client-hmr fiber disposed but ${remaining - baseline} bundle stat watcher(s) survived teardown`)
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
