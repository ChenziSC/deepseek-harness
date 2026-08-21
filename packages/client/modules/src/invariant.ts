/**
 * `@deepseek-ai/dsh-client-modules` 包自有的不变量伴随插件。
 * @module @deepseek-ai/dsh-client-modules/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-modules'

/** Cordis 伴随插件名称。 */
export const name = 'client-modules-invariant'
/** 伴随插件声明包所有权前必须存在的服务。 */
export const inject = ['invariants']

/**
 * 本包负责的不变量：Node 端的启动条目图必须保持自洽，每一行都应以同一 ID 解析出
 * clientPath；否则刚收到图的浏览器访问其声明的 /plugins/<id>/client.js 会得到 404。
 * 每次扫描触发（cordis 'internal/plugin'）时检查。graph() 与 clientPath() 读取同一个
 * 表对象，所以任意时刻都能判断该关系，无需等待 Node 端微任务防抖刷新结束。
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/plugin', () => {
    const host = ctx.get('clientModules')
    if (host === undefined) return // 浏览器端或没有 Node 端的宿主无需审计。
    for (const row of host.graph().entries) {
      if (host.clientPath(row.id) === undefined) {
        fail(`web plugin graph row "${row.id}" advertises ${row.url} but resolves no client bundle path — the served __DSH_BOOT__ would 404 on fetch`)
      }
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
