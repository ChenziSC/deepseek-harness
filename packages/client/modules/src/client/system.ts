/**
 * ClientModuleSystem 是 {@link ClientModuleLoader} 约定的实现。延迟 CJS 模型和解析
 * 分支顺序记录在 `./manifest.ts` 的公共接口上；本文件负责状态表以及加载、实例化机制。
 */
import { stripClientSuffix } from './manifest.ts'
import type {
  BootManifest, BootModuleRow, ClientBundleRegistration, ClientModuleLoader, ClientModuleRecord,
  ClientModuleSystemOptions,
} from './manifest.ts'

/** 默认 bundle 加载钩子：同源外部 classic script。 */
const defaultLoadBundle = (url: string): Promise<void> => new Promise((resolve, reject) => {
  const el = document.createElement('script')
  el.async = true
  el.src = url
  el.addEventListener('load', () => {
    el.remove()
    resolve()
  }, { once: true })
  el.addEventListener('error', () => {
    el.remove()
    reject(new Error(`client-modules: bundle script ${url} failed to load`))
  }, { once: true })
  document.head.append(el)
})

/**
 * 认领并记录 factory 实例化期间注入的 <style> 标签。preset 生成的标签已经带有
 * data-plugin；其余无标签样式归当前实例化插件所有，用于 HMR 记账。
 */
const claimStyles = (id: string): string[] => {
  if (typeof document === 'undefined') return []
  for (const el of document.querySelectorAll('style:not([data-plugin])')) {
    el.setAttribute('data-plugin', id)
  }
  const owned: string[] = []
  for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) {
    owned.push(el.getAttribute('data-plugin-css') ?? id)
  }
  return owned
}

/**
 * 客户端模块系统：用状态表和到达/实例化机制实现 {@link ClientModuleLoader}；成员约定
 * 记录在相应接口上。构造过程会索引启动行、保留已经实例化的 bootstrap 模块，并把
 * HTML 安装的 loader facade 从待处理队列切换为活动注册。
 */
export class ClientModuleSystem implements ClientModuleLoader {
  readonly version = 'client'
  readonly manifest: BootManifest
  readonly loadCache = new Map<string, ClientModuleRecord>()

  private readonly seed: Map<string, unknown>
  private readonly factories = new Map<string, ClientBundleRegistration['factory']>()
  private readonly bootstrapIds = new Set<string>()
  /** 每个 id 正在进行的 prefetch（script 加载）；并发调用方共享。 */
  private readonly pendingArrival = new Map<string, Promise<void>>()
  /** 实例化重入保护：factory 形式的 CJS 无法提供部分 exports，因此循环依赖必须失败。 */
  private readonly materializing = new Set<string>()
  private readonly graphRows = new Map<string, BootModuleRow>()
  private readonly loadBundle: (url: string) => Promise<void>

  /**
   * 基于已解析启动行构建模块系统。
   * @param options - 已解析图、平台 seed、bootstrap 模块、注册 facade 和 transport。
   */
  constructor(options: ClientModuleSystemOptions) {
    this.manifest = options.manifest
    this.seed = new Map(Object.entries(options.staticModules))
    this.loadBundle = options.loadBundle ?? defaultLoadBundle

    for (const row of options.manifest.modules) {
      if (this.graphRows.has(row.id)) throw new Error(`client-modules: duplicate graph entry "${row.id}"`)
      this.graphRows.set(row.id, row)
    }

    const bootstrapId = stripClientSuffix(options.bootstrapModule.id)
    this.bootstrapIds.add(bootstrapId)
    this.loadCache.set(bootstrapId, {
      id: bootstrapId,
      exports: options.bootstrapModule.exports,
      styles: [],
      edges: new Set(),
    })

    const target = options.registrationTarget
    if (target.mode !== 'queue') {
      throw new Error('client-modules: window.__ModuleLoader__.create called after module-system boot')
    }
    const pending = target.pendingQueue.splice(0)
    // 先完成模式切换：清空待处理注册期间执行的 bundle 必须直接注册，不能继续追加到队尾。
    target.mode = 'live'
    target.load = (registration) => { this.register(registration) }
    for (const registration of pending) target.load(registration)
  }

  /** 注册一个 bundle factory；未经失效处理而重复执行的 script 会被拒绝。 */
  private register(registration: ClientBundleRegistration): void {
    const id = stripClientSuffix(registration.id)
    if (this.bootstrapIds.has(id) || this.factories.has(id)) {
      throw new Error(`client-modules: duplicate factory registration for "${registration.id}" (bundle executed twice without invalidate?)`)
    }
    this.factories.set(id, registration.factory)
  }

  /** 加载一个图条目并注册其 factory；同一次进行中的到达过程保持幂等。 */
  private arrive(row: BootModuleRow): Promise<void> {
    const { id, url } = row
    const pending = this.pendingArrival.get(id)
    if (pending !== undefined) return pending
    if (this.loadCache.has(id) || this.factories.has(id)) return Promise.resolve()
    const task = this.loadBundle(url).then(() => {
      if (!this.factories.has(id)) {
        throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`)
      }
    }).finally(() => { this.pendingArrival.delete(id) })
    this.pendingArrival.set(id, task)
    return task
  }

  /** 在注册消费者之前，先注册它尚未解析的每个动态请求。 */
  private async arriveGraphRow(row: BootModuleRow, open: readonly string[] = []): Promise<void> {
    const cycleStart = open.indexOf(row.id)
    if (cycleStart !== -1) {
      throw new Error(
        `client-modules: module arrival cycle ${[...open.slice(cycleStart), row.id].join(' -> ')} `
        + '(the host must reject this graph before serving it)',
      )
    }
    const next = [...open, row.id]
    for (const request of row.external) {
      const id = stripClientSuffix(request)
      if (this.seed.has(request) || this.loadCache.has(id)) continue
      const dependency = this.graphRows.get(id)
      if (dependency !== undefined) await this.arriveGraphRow(dependency, next)
    }
    await this.arrive(row)
  }

  /** 同步实例化已注册 factory，并把结果缓存在 loadCache。 */
  private materialize(id: string): ClientModuleRecord {
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing
    const registered = this.factories.get(id)
    /* v8 ignore next -- callers check the factory branch before dispatching here. */
    if (registered === undefined) throw new Error(`client-modules: no registered factory for "${id}"`)
    if (this.materializing.has(id)) {
      throw new Error(`client-modules: require cycle through "${id}" (factory-form CJS cannot deliver partial exports)`)
    }
    this.materializing.add(id)
    try {
      const edges = new Set<string>()
      const exports = registered(this.makeRequire(edges))
      const record: ClientModuleRecord = { id, exports, styles: claimStyles(id), edges }
      this.loadCache.set(id, record)
      return record
    } finally {
      this.materializing.delete(id)
    }
  }

  /**
   * 提供给 factory 的同步 require 按 seed → 缓存记录 → 已注册 factory 的顺序解析。
   * 获取过程是异步的，无法从这里触发；外部动态包必须在消费者实例化前已经到达。
   */
  private makeRequire(edges: Set<string>): (spec: string) => unknown {
    return (spec: string): unknown => {
      edges.add(spec)
      if (this.seed.has(spec)) return this.seed.get(spec)
      const id = stripClientSuffix(spec)
      const record = this.loadCache.get(id)
      if (record !== undefined) return record.exports
      if (this.factories.has(id)) return this.materialize(id).exports
      throw new Error(
        `client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, `
        + 'and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)',
      )
    }
  }

  async import(specifier: string): Promise<unknown> {
    if (this.seed.has(specifier)) return this.seed.get(specifier)
    const id = stripClientSuffix(specifier)
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing.exports
    const row = this.graphRows.get(id)
    if (row !== undefined) {
      await this.arriveGraphRow(row)
    } else if (!this.factories.has(id)) {
      throw new Error(
        `client-modules: cannot resolve "${specifier}" — not a seed word, not a materialized module, `
        + 'and not a row in the boot graph (the runtime mirror of the bundle purity gate)',
      )
    }
    return this.materialize(id).exports
  }

  async prefetch(id: string): Promise<void> {
    const normalized = stripClientSuffix(id)
    if (this.loadCache.has(normalized)) return
    const row = this.graphRows.get(normalized)
    if (row === undefined) throw new Error(`client-modules: prefetch("${id}") — not a graph entry`)
    await this.arriveGraphRow(row)
  }

  invalidate(id: string): void {
    const normalized = stripClientSuffix(id)
    if (this.bootstrapIds.has(normalized)) return
    this.factories.delete(normalized)
    this.loadCache.delete(normalized)
  }
}
