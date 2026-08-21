/**
 * 客户端模块系统的 Node 端（`dsh.client` 双端包）：扫描宿主 Loader 中声明了
 * `dsh.client` 的条目，组装 `window.__DSH_BOOT__` 条目图（传输格式的唯一来源是
 * `./client/manifest.ts` 中的 {@link WebBootEntry}），提供
 * `/plugins/<id>/client.js` 及其 source map，在渲染首页时注入启动清单，并提供
 * `clientModuleHost` 服务（供 HMR 的 Node 端注册和发送通知）。
 *
 * 扫描以包为单位增量进行，不存在全量重扫路径。cordis 每次发出
 * `internal/plugin` 事件（fiber 创建或销毁）时，都会把该 fiber 的条目名标为待处理；
 * 随后的微任务会将各待处理名称与 Loader 的实时条目对齐。激活阶段把所有当前条目
 * 放入同一个集合并同步刷新，因此首次扫描与稳定运行共用同一套实现。包元数据
 * （包括“不是客户端包”的否定结果）按名称缓存且永不过期：插件集合变更要重启后
 * 才生效；bundle 内容变更只能通过 {@link ClientModuleRegistry.rebuilt} 写回条目图。
 * @module @deepseek-ai/dsh-client-modules
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebBootEntry, WebBootGraph } from './client/manifest.ts'

export type {
  BootManifest, BootModuleRow, BootPluginRow, WebBootEntry, WebBootGraph,
} from './client/manifest.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Web 插件表，由 client-modules 的 Node 端提供。 */
    clientModules: ClientModuleRegistry
  }
}

/** package.json 中 `dsh.client` 的声明字段；读取文件后逐项校验。 */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  /** 启动第一阶段的预取标记；未提供时按需延迟获取。 */
  immediately?: boolean
}

/** 一个 `dsh.client` 包解析后的元数据；按名称缓存且永不过期。 */
interface PkgMeta {
  clientPath: string
  inject?: string[]
  immediately: boolean
}

/** 启动聚合诊断与稳定运行期 bundle 诊断共用的恢复说明。 */
const CLIENT_BUNDLE_BUILD_INSTRUCTION = 'run `pnpm run build` before launch'

/** 缺少已构建客户端导出；保留结构化字段，以便激活错误按类聚合。 */
class MissingClientBundleError extends Error {
  constructor(
    readonly packageName: string,
    readonly clientPath: string,
    cause: unknown,
  ) {
    super(
      [
        `client-modules: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`,
        `  package: ${packageName}`,
        `  path: ${clientPath}`,
      ].join('\n'),
      { cause },
    )
  }
}

/** 激活失败：把可处理的包构建错误与其他失败分组展示。 */
class ClientPackageCompositionError extends AggregateError {
  constructor(failures: Error[]) {
    const missingBundles = failures.filter((error): error is MissingClientBundleError => error instanceof MissingClientBundleError)
    const otherFailures = failures.filter(error => !(error instanceof MissingClientBundleError))
    const packageNoun = failures.length === 1 ? 'package' : 'packages'
    const lines = [`client-modules: ${String(failures.length)} client ${packageNoun} failed to compose:`]
    if (missingBundles.length > 0) {
      lines.push(`  client bundles not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`)
      for (const error of missingBundles) {
        lines.push(`    - package: ${error.packageName}`, `      path: ${error.clientPath}`)
      }
    }
    if (otherFailures.length > 0) {
      lines.push('  other failures:', ...otherFailures.map(error => `    - ${error.message}`))
    }
    super(failures, lines.join('\n'))
  }
}

/** 组装表中的一行：传输条目及其 bundle 路径。 */
interface WebPluginRecord {
  entry: WebBootEntry
  clientPath: string
}

/** 将解析后的未知 JSON 值收窄为 `dsh.client` 声明；字段格式错误时抛出异常。 */
function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  if (decl.inject !== undefined && (!Array.isArray(decl.inject) || decl.inject.some(i => typeof i !== 'string'))) {
    throw new Error(`client-modules: ${pkgName} dsh.client.inject must be a string array`)
  }
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(decl.inject !== undefined ? { inject: decl.inject as string[] } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}

/** 将 `exports["./client"]` 解析为相对路径，接受字符串或一层条件导出对象。 */
function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

/** 截取为 12 位十六进制字符的 sha1 内容哈希，用作 bundle rev 或 graph rev。 */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** 某个 bundle rev 对应的图条目；URL 以查询参数携带 rev，用于使旧缓存失效。 */
function graphRow(id: string, rev: string, injectEdges: string[] | undefined, immediately: boolean): WebBootEntry {
  return {
    id,
    url: `/plugins/${id}/client.js?rev=${rev}`,
    rev,
    ...(injectEdges !== undefined ? { inject: injectEdges } : {}),
    ...(immediately ? { immediately: true } : {}),
  }
}

/**
 * 把启动条目图注入 index.html：将 `window.__DSH_BOOT__` 放在 <head> 的第一个
 * script 中，确保 shell bundle 读取前已经存在。JSON 中会转义 `<`，避免插件可控
 * 字符串越出 script 元素。
 * @param html - index.html 源文本。
 * @param graph - 已组装的条目图。
 * @returns 已注入条目图脚本的 HTML。
 */
export function injectBootManifest(html: string, graph: WebBootGraph): string {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  const script = `<script>window.__DSH_BOOT__ = ${json}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  // 无界面测试页面可能没有 <head>；直接前置仍能保证 shell 先读到清单。
  return `${script}${html}`
}

// 中文说明：该服务负责增量扫描客户端插件、组装启动图并提供 bundle 路由；构造阶段
// 会聚合已加载条目的声明或构建错误。下方英文 JSDoc 会生成到英文 API 目录，故保留。
/**
 * The web plugin table service: incremental `dsh.client` scan + wire composition
 * + bundle route + index tap. Construction runs the activation scan
 * synchronously — a malformed declaration or missing bundle among the
 * already-loaded entries aggregates into one loud throw (FAILED fiber; the
 * boot activation audit reports it).
 */
export class ClientModuleRegistry extends Service {
  static inject = ['webServer', 'loader']

  private readonly table = new Map<string, WebPluginRecord>()
  // 否定结果（无法解析的 specifier，如 cordis:include 内置项、子路径条目，或没有
  // Web `dsh.client` 声明的包）以 null 缓存且永不过期；插件集合变更要重启后才生效。
  private readonly pkgMeta = new Map<string, PkgMeta | null>()
  private readonly rebuildListeners = new Set<(id: string, rev: string) => void>()
  private readonly graphListeners = new Set<() => void>()
  private readonly dirty = new Set<string>()
  private readonly resolvePkgJson: (spec: string) => string
  private flushQueued = false
  private composed: WebBootGraph

  /**
   * 构建服务：订阅事件、填充初始集合并执行激活刷新。
   * @param ctx - 提供 webServer 和 loader 的插件上下文。
   */
  constructor(ctx: Context) {
    super(ctx, 'clientModules')
    // 解析锚点是配置树的 baseUrl（cordis.yml 所在目录，其 package 声明所有被组装
    // 插件为依赖）。若使用 modules 包自身的 URL，在 pnpm 隔离的 node_modules 中
    // 无法解析同级包。
    if (ctx.baseUrl === undefined) {
      throw new Error('client-modules: ctx.baseUrl is unset — the node half needs the config-tree anchor to resolve plugin packages')
    }
    const require = createRequire(ctx.baseUrl)
    this.resolvePkgJson = spec => require.resolve(`${spec}/package.json`)

    // 先订阅再填充，使激活期间到达的 fiber 也进入同一个待处理集合；Set 的幂等性
    // 使重复加入无害。没有 entry 的 fiber 属于子插件或手动挂载，不是 Loader 条目，
    // 可在 O(1) 时间内忽略。
    ctx.on('internal/plugin', (fiber) => {
      const entryName = fiber.entry?.options.name
      if (entryName === undefined) return
      this.dirty.add(entryName)
      if (this.flushQueued) return
      this.flushQueued = true
      queueMicrotask(() => {
        this.flushQueued = false
        this.flush((err) => { ctx.logger.warn(err) })
      })
    })

    // 激活扫描就是对当前条目执行一次增量路径，并同步刷新；订阅、填充与刷新之间
    // 没有异步步骤。
    for (const entry of ctx.loader.entries()) this.dirty.add(entry.options.name)
    this.composed = this.compose()
    const failures: Error[] = []
    this.flush(err => failures.push(err))
    if (failures.length > 0) {
      throw new ClientPackageCompositionError(failures)
    }

    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: '/plugins', handler: this.serveBundle }),
      'client-modules: bundle route',
    )
    ctx.effect(
      () => ctx.webServer.tapIndex(html => injectBootManifest(html, this.composed)),
      'client-modules: boot manifest injection',
    )
  }

  // 中文：返回当前启动条目图；无变更时对象引用稳定。
  /**
   * Current composed entry graph (stable object between changes).
   * @returns the graph served as `window.__DSH_BOOT__`.
   */
  graph(): WebBootGraph {
    return this.composed
  }

  // 中文：按包名查询客户端 bundle 的绝对路径。
  /**
   * Absolute path of an entry's client bundle.
   * @param id - entry id (package name).
   * @returns the path, or undefined for an unknown id.
   */
  clientPath(id: string): string | undefined {
    return this.table.get(id)?.clientPath
  }

  // 中文：重新计算 bundle 哈希；这是 HMR 将内容变化写入启动图的唯一入口。
  /**
   * Re-hash one bundle (the HMR watch's registration hook — the only entry
   * point through which bundle content changes reach the graph).
   * @param id - entry id (package name).
   * @returns the new rev, or undefined for an unknown id.
   */
  rebuilt(id: string): string | undefined {
    const record = this.table.get(id)
    if (record === undefined) return undefined
    const rev = shortHash(readFileSync(record.clientPath))
    if (rev === record.entry.rev) return rev
    record.entry = graphRow(id, rev, record.entry.inject, record.entry.immediately === true)
    this.composed = this.compose()
    for (const notify of this.rebuildListeners) {
      // rebuilt() 在 HMR 监听回调中执行；单个订阅者抛错不能终止轮询，也不能跳过
      // 后续订阅者。
      try {
        notify(id, rev)
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
    this.notifyGraphChanged()
    return rev
  }

  // 中文：订阅实际改变 rev 的 bundle 重建。
  /**
   * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
   * @param listener - receives the entry id and its new bundle rev.
   * @returns the unsubscriber.
   */
  onRebuilt(listener: (id: string, rev: string) => void): () => void {
    this.rebuildListeners.add(listener)
    return () => { this.rebuildListeners.delete(listener) }
  }

  // 中文：条目图重组后发出无载荷通知，监听器需重新读取 graph()。
  /**
   * Fires after any flush that recomposed the graph (row added/removed, or a
   * rebuilt rev change). Pull model: listeners re-read {@link graph}.
   * @param listener - notified with no payload.
   * @returns the unsubscriber.
   */
  onGraphChanged(listener: () => void): () => void {
    this.graphListeners.add(listener)
    return () => { this.graphListeners.delete(listener) }
  }

  private compose(): WebBootGraph {
    const entries = [...this.table.values()].map(record => record.entry)
    return { rev: shortHash(JSON.stringify(entries)), entries }
  }

  private notifyGraphChanged(): void {
    for (const listener of this.graphListeners) {
      // 单个订阅者抛错不能跳过后续订阅者，也不能逸出到触发本次刷新的调用方
      // （调用方可能是 fs.watchFile 回调）。
      try {
        listener()
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
  }

  private resolveMeta(pkgName: string): PkgMeta | null {
    const cached = this.pkgMeta.get(pkgName)
    if (cached !== undefined) return cached
    let pkgPath: string
    try {
      pkgPath = this.resolvePkgJson(pkgName)
    } catch {
      // 无法解析为包根目录：Loader 内置项（cordis:include）和子路径条目
      // （如 …/gateway）会进入这里，并被永久判定为非客户端条目。
      this.pkgMeta.set(pkgName, null)
      return null
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh
    const decl = parseDshClient(
      pkgName,
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined,
    )
    if (decl === undefined || decl.platform !== 'web') {
      this.pkgMeta.set(pkgName, null)
      return null
    }
    const clientRel = clientExportOf(pkgName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`client-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`)
    }
    const meta: PkgMeta = {
      clientPath: join(dirname(pkgPath), clientRel),
      ...(decl.inject !== undefined ? { inject: decl.inject } : {}),
      immediately: decl.immediately === true,
    }
    this.pkgMeta.set(pkgName, meta)
    return meta
  }

  /**
   * 读取激活时的 bundle 修订号。
   * @param pkgName - 声明客户端 bundle 的包。
   * @param clientPath - 已构建客户端产物的绝对路径。
   * @returns bundle 内容的短哈希，用作修订号。
   * @throws {MissingClientBundleError} 读取因 `ENOENT` 失败时抛出；其他文件系统错误原样抛出。
   */
  private initialBundleRevision(pkgName: string, clientPath: string): string {
    try {
      return shortHash(readFileSync(clientPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new MissingClientBundleError(pkgName, clientPath, error)
    }
  }

  /** 将一个条目名与 Loader 实时条目对齐。@returns 表是否发生变化。 */
  private processOne(entryName: string): boolean {
    let qualifies = false
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.name === entryName && entry.fiber !== undefined && !entry.disabled) {
        qualifies = true
        break
      }
    }
    if (!qualifies) return this.table.delete(entryName)
    if (this.table.has(entryName)) return false
    const meta = this.resolveMeta(entryName)
    if (meta === null) return false
    // 从此处起 rev 随条目保存：fiber 重启会原样复用条目及其 rev；只有 rebuilt()
    // 会重新读取 bundle。
    const rev = this.initialBundleRevision(entryName, meta.clientPath)
    this.table.set(entryName, { entry: graphRow(entryName, rev, meta.inject, meta.immediately), clientPath: meta.clientPath })
    return true
  }

  private flush(onError: (err: Error) => void): void {
    let changed = false
    for (const entryName of [...this.dirty]) {
      this.dirty.delete(entryName)
      try {
        if (this.processOne(entryName)) changed = true
      } catch (error) {
        // 稳定运行期中，一个损坏的包不能影响其他包；激活阶段则会聚合这些错误并
        // 明确抛出。
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (changed) {
      this.composed = this.compose()
      this.notifyGraphChanged()
    }
  }

  private readonly serveBundle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- `?? '/'` 分支：node:http 始终会为服务端请求设置 url。 */
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    // ID 可能包含 scope 斜杠。/plugins 下的其他路径（包括 HMR 条目缺失时的
    // /plugins/events）都属于未知资源。
    const prefix = '/plugins/'
    const mapSuffix = '/client.js.map'
    const bundleSuffix = '/client.js'
    const isSourceMap = pathname.startsWith(prefix) && pathname.endsWith(mapSuffix)
    const suffix = isSourceMap ? mapSuffix : bundleSuffix
    const clientPath = pathname.startsWith(prefix) && pathname.endsWith(suffix)
      ? this.clientPath(pathname.slice(prefix.length, -suffix.length))
      : undefined
    const path = clientPath === undefined ? undefined : `${clientPath}${isSourceMap ? '.map' : ''}`
    if (path === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      const body = await readFile(path)
      res.writeHead(200, {
        'content-type': isSourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(body)
    } catch {
      // 已注册但无法读取（bundle 尚未构建）时明确返回 404，避免静默回退为 SPA HTML。
      res.writeHead(404)
      res.end()
    }
  }
}

export default ClientModuleRegistry
