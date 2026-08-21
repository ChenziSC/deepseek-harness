/**
 * 客户端模块系统的 Node 端（`dsh.client` 双端包）：扫描 Host Loader 中声明
 * `dsh.client` 的包，按模块图顺序组装 `window.__DSH_BOOT__` 条目图（传输结构唯一
 * 来源为 `./client/manifest.ts` 的 {@link WebBootEntry}），提供
 * `/plugins/<id>/client.js` 及 source map，把启动清单和阻塞 parser 的 bootstrap
 * 预加载项加入 webserver index 注入表，并提供 `clientModuleHost` 服务，供 HMR
 * Node 端注册和通知。
 *
 * 扫描按包增量执行，不存在完整重扫路径。每次 Cordis `internal/plugin` 事件（fiber
 * 构造或销毁）都会把 fiber 条目名标记为 dirty；微任务刷新逐个将其与活动 Loader
 * 条目对齐。激活阶段用所有当前条目填充同一 dirty 集合并同步刷新，因此首次扫描与
 * 稳态共享一套实现。包元数据（包括“不是 client 包”的否定结论）按名称永久缓存；
 * 插件集合变更重启后生效，bundle 内容变更只能通过
 * {@link ClientModuleRegistry.rebuilt} 进入图。
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
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { optionalStringArray, stripClientSuffix } from './client/manifest.ts'
import type { WebBootEntry, WebBootGraph } from './client/manifest.ts'

export { stripClientSuffix } from './client/manifest.ts'
export type {
  BootManifest, BootModuleRow, BootPluginRow, WebBootEntry, WebBootGraph,
} from './client/manifest.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Web 插件表，由 client-modules Node 端提供。 */
    clientModules: ClientModuleRegistry
  }
}

/** package.json 的 `dsh.client` 声明字段；读取文件后逐项校验。 */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  /** 启动第一阶段预取标记；缺失表示延迟到按需获取。 */
  immediately?: boolean
  /**
   * 隐式客户端基线之外的精确模块表请求。任意 specifier 都有效，包括
   * `<pkg>/client` 等子路径；每个导入包声明自己的例外请求。类型导入在解析前已被
   * transform 擦除，因此不构成请求。缺失表示该包只使用基线 externals。
   */
  external?: string[]
}

/** 图条目携带的规范化声明字段；缺失的数组声明转换为空数组。 */
interface WebBootRowFields {
  inject?: string[]
  /** 该包向模块表请求的模块 specifier。 */
  external: string[]
  immediately: boolean
}

/** 一个 `dsh.client` 包解析后的元数据；按名称缓存且永不过期。 */
interface PkgMeta extends WebBootRowFields {
  clientPath: string
}

/** 启动阶段分组诊断和稳态 bundle 诊断共用的恢复指引。 */
const CLIENT_BUNDLE_BUILD_INSTRUCTION = 'run `pnpm run build` before launch'

/** 缺失的已构建 client export；保留结构化字段供激活错误分组。 */
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

/** 一个已组装表行：传输条目及其对应的已解析包元数据。 */
interface WebPluginRecord {
  entry: WebBootEntry
  meta: PkgMeta
}

/** 将未知 JSON 值收窄为 `dsh.client` 声明；字段格式错误时抛出。 */
function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external)
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(inject !== undefined ? { inject } : {}),
    ...(external !== undefined ? { external } : {}),
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

/** 截短为 12 个十六进制字符的 sha1 内容哈希，用作 bundle rev 或 graph rev。 */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** 一个 bundle rev 对应的图条目；URL 通过查询参数携带 rev 以使缓存失效。 */
function graphRow(id: string, rev: string, fields: WebBootRowFields): WebBootEntry {
  return {
    id,
    url: `/plugins/${id}/client.js?rev=${rev}`,
    rev,
    ...(fields.inject !== undefined ? { inject: fields.inject } : {}),
    ...(fields.immediately ? { immediately: true } : {}),
    ...(fields.external.length > 0 ? { external: fields.external } : {}),
  }
}

/**
 * 对组合条目排序，使每个被请求的动态包位于消费者之前。`external` specifier 要么
 * 指向对应包条目（`<pkg>/client` 是裸包名的别名），要么是不会增加图边的静态表名称。
 * @param entries - 按扫描顺序排列的组合条目。
 * @returns 重排后的同一组条目；扫描顺序用于打破并列。
 * @throws {Error} 条目请求自身或模块图存在循环时抛出；消息列出环上的包。
 */
export function orderByModuleGraph(entries: readonly WebBootEntry[]): WebBootEntry[] {
  const rowsById = new Map<string, WebBootEntry>()
  for (const entry of entries) rowsById.set(entry.id, entry)
  const ordered: WebBootEntry[] = []
  const placed = new Set<string>()
  const open: string[] = []
  const visit = (entry: WebBootEntry): void => {
    if (placed.has(entry.id)) return
    const cycleStart = open.indexOf(entry.id)
    if (cycleStart !== -1) {
      throw new Error(
        `client-modules: module graph cycle ${[...open.slice(cycleStart), entry.id].join(' -> ')} `
        + '— a requested package row must precede its consumers, and factory-form CJS cannot deliver partial exports',
      )
    }
    open.push(entry.id)
    for (const name of entry.external ?? []) {
      const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name))
      if (dependency === entry) {
        throw new Error(
          `client-modules: "${entry.id}" requests module "${name}" that it answers itself `
          + '— a row must not declare its own package in dsh.client.external',
        )
      }
      if (dependency !== undefined) visit(dependency)
    }
    open.pop()
    placed.add(entry.id)
    ordered.push(entry)
  }
  for (const entry of entries) visit(entry)
  return ordered
}

/** 其普通 client bundle 提供模块系统实现的 bootstrap 包。 */
const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'

/** 其普通 client bundle 必须在插件启动前注册的动态包。 */
const CLIENT_RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'

/** HTML parser 在 Vite shell 之前执行的普通动态 bundle。 */
const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID, CLIENT_RUNTIME_ID] as const

/**
 * 以 index 注入行表示的启动协议。内联注册队列位于阻塞 classic script 之前；后者
 * 加载 modules 和 runtime 的普通 `lib/client.js` 产物。队列的 `create()` 会实例化
 * modules bundle，把构造委托给该 bundle，并让同一个 facade 保持活动注册模式。
 * shell 读取之前，随后注入图全局变量。
 * @param graph - 已组装的条目图。
 * @returns 按执行顺序排列的 head 行：队列 script、预载 script、图全局变量。
 */
export function bootInjections(graph: WebBootGraph): IndexInjection[] {
  const bootstrapId = JSON.stringify(CLIENT_MODULES_ID)
  const queue = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${bootstrapId})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`
  const preload = PARSER_PRELOAD_IDS.map(id => graph.entries.find(entry => entry.id === id))
    .filter((entry): entry is WebBootEntry => entry !== undefined)
    .map((entry): IndexInjection => ({ kind: 'script-src', placement: 'head', src: entry.url }))
  return [
    { kind: 'script', placement: 'head', text: queue },
    ...preload,
    { kind: 'global', name: '__DSH_BOOT__', value: graph },
  ]
}

// 中文：Web 插件表服务负责增量扫描、传输数据组装、bundle 路由与 index 注入；
// 激活扫描中的声明或 bundle 错误会聚合后明确失败。
/**
 * The web plugin table service: incremental `dsh.client` scan + wire composition
 * + bundle route + index injection rows. Construction runs the activation scan
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
    ctx.on('webserver/index-inject', (table) => {
      table.push(...bootInjections(this.composed))
    })
  }

  // 中文：返回当前组装图；两次变更之间对象标识保持稳定。
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
    return this.table.get(id)?.meta.clientPath
  }

  // 中文：重新哈希 bundle；这是内容变更进入组装图的唯一入口。
  /**
   * Re-hash one bundle (the HMR watch's registration hook — the only entry
   * point through which bundle content changes reach the graph).
   * @param id - entry id (package name).
   * @returns the new rev, or undefined for an unknown id.
   */
  rebuilt(id: string): string | undefined {
    const record = this.table.get(id)
    if (record === undefined) return undefined
    const rev = shortHash(readFileSync(record.meta.clientPath))
    if (rev === record.entry.rev) return rev
    record.entry = graphRow(id, rev, record.meta)
    this.composed = this.compose()
    for (const notify of this.rebuildListeners) {
      // rebuilt() 在 HMR watch 回调内运行；抛错的订阅者不能终止轮询或跳过后续订阅者。
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
    const entries = orderByModuleGraph([...this.table.values()].map(record => record.entry))
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
      external: decl.external ?? [],
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
    // 从这里开始 rev 随条目保存：fiber 重启会原样复用条目及其 rev；只有 rebuilt()
    // 会重新读取 bundle。
    const rev = this.initialBundleRevision(entryName, meta.clientPath)
    this.table.set(entryName, { entry: graphRow(entryName, rev, meta), meta })
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
    if (!changed) return
    let composed: WebBootGraph
    try {
      composed = this.compose()
    } catch (error) {
      // 无法排序是整张表的属性，不属于单个到达包，因此在这里报告：激活时聚合抛出；
      // 稳态下发出警告，并继续提供上一张可排序图。
      onError(error as Error)
      return
    }
    this.composed = composed
    this.notifyGraphChanged()
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
