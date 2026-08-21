/**
 * HMR 插件的 Node 端，即开发环境重载链的宿主端。一个定时器通过 stat 轮询图中
 * 每个条目的客户端 bundle；这里有意使用轮询，因为网络挂载不会发送 inotify 事件。
 * 内容变化通过 `clientModuleHost.rebuilt(id)` 上报，并由 `/plugins/events` SSE 通道
 * 向浏览器端（src/client/）广播 graph/rebuilt 帧。Web bundle 无条件挂载本条目；若
 * 没有重建监听器改写客户端 bundle，轮询就观察不到变化，整条链保持空闲。
 */
import { statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// 空类型导入用于带入 clientModuleHost/webServer 的 Context 合并声明。
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PluginsEventFrame } from './events.ts'
import { EVENTS_ENDPOINT } from './events.ts'

export type { PluginsEventFrame } from './events.ts'
export { EVENTS_ENDPOINT } from './events.ts'

/** Cordis 插件名称。 */
export const name = 'client-hmr'

/** 必需服务：Web 插件表和路由注册表。 */
export const inject = ['clientModules', 'webServer']

// 中文：插件配置由下方同名 schemastery schema 校验；英文 JSDoc 会投影到英文配置目录。
// pollIntervalMs 是 bundle stat 轮询间隔，单位毫秒；默认值与构建端监听器一致。
/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(1).default(500),
})

/** 将一帧序列化为 SSE data 行。 */
function sseData(frame: PluginsEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

interface WatchedBundle {
  path: string
  mtimeMs: number
  size: number
  dirty: boolean
}

/**
 * 挂载开发环境链路：bundle 监听、重建上报和 SSE 通道。
 * @param ctx - 提供 clientModuleHost 和 webServer 的宿主插件上下文。
 * @param config - 已校验的 {@link Config}。
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery 的 .default() 保证校验后该字段一定存在。
  const pollIntervalMs = config.pollIntervalMs as number

  // --- bundle 监听：由 HMR 独占的一次 stat 轮询 ---------------------------
  const watched = new Map<string, WatchedBundle>()

  const rehash = (id: string, watch: WatchedBundle, current: { mtimeMs: number; size: number }): void => {
    try {
      // rebuilt() 会重新计算哈希；哈希未变时保持静默，clientModuleHost 只在 rev
      // 确实变化时触发 onRebuilt。
      ctx.clientModules.rebuilt(id)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        watch.dirty = true
        return
      }
      ctx.logger.warn(error)
    }
    watch.mtimeMs = current.mtimeMs
    watch.size = current.size
    watch.dirty = false
  }

  const watchRow = (id: string, path: string): void => {
    let baseline: { mtimeMs: number; size: number }
    try {
      baseline = statSync(path)
    } catch (error) {
      watched.set(id, { path, mtimeMs: 0, size: 0, dirty: true })
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
      return
    }
    const watch = { path, mtimeMs: baseline.mtimeMs, size: baseline.size, dirty: false }
    watched.set(id, watch)
    // 模块宿主在发布图之前已计算哈希。取得基线后立即再计算一次，避免中间发生的写入
    // 变成“最新基线却搭配旧图 rev”的不一致状态。
    rehash(id, watch, baseline)
  }

  const pollWatches = (): void => {
    for (const [id, watch] of watched) {
      let current: { mtimeMs: number; size: number }
      try {
        current = statSync(watch.path)
      } catch (error) {
        watch.dirty = true
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
        continue
      }
      if (!watch.dirty && current.mtimeMs === watch.mtimeMs && current.size === watch.size) continue
      // 先 stat 再计算哈希，可为哈希期间发生的写入保留一个可检测的旧基线；后续 stat
      // 再次变化时会修复撕裂读取。
      rehash(id, watch, current)
    }
  }

  // 将监听集合与当前图做差异比较：删除已移除条目或 bundle 路径已变条目的监听，
  // 并为新条目添加监听。
  const syncWatches = (): void => {
    const rows = new Map<string, string>()
    for (const row of ctx.clientModules.graph().entries) {
      const path = ctx.clientModules.clientPath(row.id)
      if (path !== undefined) rows.set(row.id, path)
    }
    for (const [id, watch] of watched) {
      if (rows.get(id) === watch.path) continue
      watched.delete(id)
    }
    for (const [id, path] of rows) {
      if (!watched.has(id)) watchRow(id, path)
    }
  }

  ctx.effect(() => {
    // 首次同步覆盖图中已有条目；订阅覆盖之后到达的条目，包括启动窗口内激活的本插件
    // 自身条目。本插件没有自我豁免，modules/hmr 重建也走同一条链。
    syncWatches()
    const unsubscribe = ctx.clientModules.onGraphChanged(syncWatches)
    const timer = setInterval(pollWatches, pollIntervalMs)
    timer.unref()
    return () => {
      unsubscribe()
      clearInterval(timer)
      watched.clear()
    }
  }, 'client-hmr: bundle watches')

  // --- /plugins/events SSE 通道 -------------------------------------------
  const connections = new Set<ServerResponse>()

  const connect = (res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })
    // 打开时先写一行注释，使客户端和代理即便从未发生重建也能看到活跃通道；
    // EventSource 解析帧时会自然跳过该行。
    res.write(': connected\n\n')
    res.write(sseData({ type: 'graph', graph: ctx.clientModules.graph() }))
    connections.add(res)
    res.on('close', () => { connections.delete(res) })
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_ENDPOINT,
      handler: (req, res) => {
        // 命名路由会在载体的方法门禁前匹配；对该端点的非 GET 请求仍保持原有全局
        // 405 语义。
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        connect(res)
      },
    })
    const unsubscribe = ctx.clientModules.onRebuilt((id, rev) => {
      const line = sseData({ type: 'rebuilt', id, rev })
      for (const res of connections) res.write(line)
    })
    return () => {
      unsubscribe()
      disposeRoute()
      for (const res of connections) res.destroy()
      connections.clear()
    }
  }, 'client-hmr: /plugins/events channel')
}
