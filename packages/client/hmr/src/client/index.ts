/**
 * client-hmr 浏览器端：客户端插件条目的热重载驱动器。
 *
 * 本插件监听宿主系统 SSE 通道（`GET /plugins/events`）；收到 `rebuilt` 帧时重新加载
 * 条目 bundle，并原位替换 cordis fiber。图中每个条目都是插件 bundle；
 * `immediately` 条目只多了第一阶段预取这一启动优化，所以清单中的所有插件包共享
 * 相同重载语义。普通包（React 系列、cordis、shell、纯库）不是条目，shell 变化仍需
 * 刷新页面。级联无需 HMR 额外处理：下游 fiber 以 provider fiber uid 作为激活 epoch
 * 的依据（见 vendor/cordis/src/fiber.ts 的 `_refresh`），替换 provider fiber 会由原生
 * 机制重新级联。因此重载数据层插件（connection/runtime）会自动影响其 UI 依赖方。
 *
 * 延迟 CJS 表的重载顺序为：invalidate（删除旧 factory 和实例化记录）→ prefetch
 * （加载并注册新 factory）→ 先删注册表再拆除 → 等待旧 fiber unload 排空 → 删除归属
 * 本插件的 `<style data-plugin>` 标签 → `entry.refresh()` 实例化新 factory。
 * invalidate 必须先于 prefetch：仍存活的 factory 会使 prefetch 无操作，而未删除注册
 * 就再次执行 bundle 会触发重复注册错误。延迟模型下，执行 bundle 只是注册，所有模块
 * 副作用（包括注入 CSS）都在 factory 闭包内，于 refresh() 的实例化阶段发生，因此
 * 替换是安全的。这也保证 CSS 顺序：先等待旧 fiber disposer 排空（SlotCore 单所有者
 * 注销），再删除旧样式，最后实例化并以相同稳定标签 ID 重新注入。
 *
 * 失败窗口：若 invalidate 后 prefetch 被拒绝，模块会保持未注册，但旧 fiber 不受影响
 * 继续运行，因为拆除尚未开始。这是可恢复的降级状态，下一帧 rebuilt 会从头重试，
 * 与下述不回滚策略一致。已知的开发环境竞态是：rebuilt 帧若与尚未完成的启动到达
 * 重叠，会共享该到达任务，可能实例化重建前的字节；下一帧 rebuilt 会自行修复。
 *
 * 不能简单执行 `entry.fiber.dispose()` → `entry.refresh()`，原因有二：
 * 1. 销毁时不会清空 `Entry.fiber`（vendor/loader/src/config/entry.ts 只在 `_init`
 *    中赋值），所以 `refresh()` 会命中 `if (this.fiber) return` 保护并直接返回。
 * 2. 单独调用 `fiber.dispose()` 会进入 Loader 的自销毁分支
 *    （vendor/loader/src/index.ts 的 `internal/plugin` case 4；发出事件时注册表仍持有
 *    runtime），从而把条目永久标记为 `disabled: true`。
 * vendor/hmr 的重载骨架给出了正确做法：先删除 runtime 记录（`registry.delete` 使
 * case 4 提前返回，条目仍启用），再重建。同时清空 `entry.fiber`，使
 * `entry.refresh()` 通过 Loader 自身的 `_init` 重新导入并注册插件，从而沿用条目已
 * 解析配置和自动 `fiber.entry` 重新绑定，而不是手写 `registry.plugin`。每个 runtime
 * 中客户端条目恰好只有一个 fiber，因此 `registry.delete` 不会连带销毁同级项。
 *
 * 自重载：本插件自身也是图条目，所以 rebuilt 帧可能指向它。进行中的重载继续在旧
 * bundle 闭包中运行，其 EventSource 随旧 fiber effects 一同关闭；新 bundle 的 apply
 * 会打开新通道。间隙中到达的帧会丢失，这对开发通道可接受，下次重建会再次通知。
 *
 * 失败策略是不回滚。导入失败会使条目暂时没有 fiber，下一帧 rebuilt 从头重试；
 * apply 失败会留下 FAILED fiber，供 shell 投影状态。两种失败都会明确记录日志。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Entry, Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { PluginsEventFrame } from '../events.ts'
import { EVENTS_ENDPOINT } from '../events.ts'

export type { PluginsEventFrame } from '../events.ts'
export { EVENTS_ENDPOINT } from '../events.ts'

/** Cordis 插件名称。 */
export const name = 'client-hmr'

/** 必需服务：负责条目治理的 vendored Loader，以及启动时以 `modules` 提供的客户端模块系统。 */
export const inject = ['loader', 'modules']

/** 查找模块 specifier 为 `id` 的 Loader 条目；条目树 ID 是随机值，包名位于 `options.name`。 */
function findEntry(loader: Loader, id: string): Entry | undefined {
  for (const entry of loader.entries()) {
    if (entry.options.name === id) return entry
  }
  return undefined
}

/** 删除归 `id` 所有的全部 `<style data-plugin>` 标签；逐字比较属性，避免 CSS selector 转义问题。 */
function removeOwnedStyles(id: string): void {
  for (const el of document.querySelectorAll('style[data-plugin]')) {
    if (el.getAttribute('data-plugin') === id) el.remove()
  }
}

/**
 * 挂载 HMR 驱动器：订阅系统 SSE 通道并热替换已重建条目。
 * @param ctx - 可使用 `loader` 和 `modules` 的插件上下文。
 */
export function apply(ctx: Context): void {
  // 两者都是已声明的注入项；Context 类型合并中，`modules` 来自客户端模块 Loader
  // 包，`loader` 来自 vendored Loader。
  const modLoader = ctx.modules
  const loader: Loader = ctx.loader

  async function reload(id: string): Promise<void> {
    const entry = findEntry(loader, id)
    if (entry === undefined) {
      ctx.logger.warn(`client-hmr: rebuilt frame for unknown entry "${id}" (not in the loader tree)`)
      return
    }
    // 先 invalidate，删除旧 factory 和记录；仍存活的 factory 会使 prefetch 无操作，
    // 再注册则会触发重复错误。随后在旧 fiber 仍提供服务时执行异步部分：加载 script
    // 只注册新 factory，不产生副作用；延迟 CJS 的模块体在实例化而非执行时运行。
    modLoader.invalidate(id)
    await modLoader.prefetch(id)

    const oldFiber = entry.fiber
    if (oldFiber !== undefined) {
      // 按模块注释所述，拆除时先删注册表：fiber disposer 发出 internal/plugin 前必须
      // 删除 runtime 记录，否则 Loader 会把条目标为 disabled。
      const runtime = oldFiber.runtime
      if (runtime !== null) entry.ctx.registry.delete(runtime.callback)
      // 等待 unload 排空：effect disposer（槽位、订阅）必须在新 bundle 执行以及新
      // apply 重新注册前完成。
      while (oldFiber.inertia !== undefined) await oldFiber.inertia
      delete entry.fiber
    }
    // 在实例化重新注入样式前删除旧的自有样式；CSS 幂等保护以稳定标签 ID 为键。
    removeOwnedStyles(id)
    // 通过条目重新初始化：上方已清空 fiber，所以 refresh() 会重新导入、实例化已预取
    // factory（CSS 在此注入），并在条目上下文中重新注册插件。Entry._init 会记录导入
    // 失败，并让条目保持无 fiber 状态，以便重试。
    await entry.refresh()
    // 明确暴露 apply 失败；不回滚并保留 FAILED 状态。
    await entry.fiber?.await()
  }

  // 串行执行重载：帧可能比替换完成更快到达，交错的销毁/执行链会破坏单槽位交接。
  let queue: Promise<void> = Promise.resolve()
  const handle = (frame: PluginsEventFrame): void => {
    switch (frame.type) {
      case 'rebuilt':
        queue = queue.then(() => reload(frame.id)).catch((error: unknown) => {
          ctx.logger.error(`client-hmr: reload of "${frame.id}" failed`)
          ctx.logger.error(error)
        })
        break
      case 'graph':
        // 连接时快照，当前未使用。重建后 Loader 缓存的图 rev 会过期，但不影响行为，
        // 因为 prefetch 总会访问网络且宿主以 no-cache 提供 bundle；重连握手机制会刷新
        // 图 rev。
        break
      default:
        // 帧联合类型允许通过合并扩展，因此有意忽略较新宿主发送的未知帧类型。
        break
    }
  }

  ctx.effect(() => {
    const source = new EventSource(EVENTS_ENDPOINT)
    source.addEventListener('message', (event: MessageEvent<string>) => {
      let frame: PluginsEventFrame
      try {
        frame = JSON.parse(event.data) as PluginsEventFrame
      } catch {
        // 传输边界：格式错误的开发通道帧会被明确记录并丢弃。
        ctx.logger.warn(`client-hmr: unparseable event frame: ${event.data}`)
        return
      }
      handle(frame)
    })
    return () => { source.close() }
  }, 'client-hmr: event source')
}
