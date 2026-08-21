/**
 * ClientModuleSystem 是 {@link ClientModuleLoader} 接口背后的实现。延迟 CJS 模型、
 * 解析分支顺序等概念约定记录在 `./manifest.ts` 的公开接口上；本文件负责状态表以及
 * 加载、实例化机制。
 */
import type {
  BootModuleRow, ClientModuleLoader, ClientModuleRecord,
  ClientModuleSystemOptions, ClientPluginHandoff, DshWindow,
} from './manifest.ts'

/** 默认 bundle 加载钩子：同源的外部经典 script。 */
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
 * 插件 bundle 就是对应包的客户端部分。外部 bundle 生成的 exports 子路径
 * `<id>/client` 与图中的裸 ID 指向同一份 exports，因此查表前要去掉该后缀。
 */
const stripClientSuffix = (spec: string): string =>
  spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec

/**
 * 认领并清点 factory 在实例化期间注入的 <style> 标签。preset 生成的标签已带有
 * data-plugin；其余未标记标签归当前正在实例化的插件所有，供 HMR 记账。
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
 * 客户端模块系统：由状态表以及实现 {@link ClientModuleLoader} 的到达、实例化机制
 * 组成；成员约定见该接口文档。构造时为启动条目建立索引，并为每个页面安装一次
 * `window.__ModuleLoader__` 注册接收器。
 */
export class ClientModuleSystem implements ClientModuleLoader {
  readonly version = 'client'
  readonly loadCache = new Map<string, ClientModuleRecord>()

  private readonly seed: Map<string, unknown>
  private readonly statics = new Map<string, unknown>()
  private readonly factories = new Map<string, ClientPluginHandoff['factory']>()
  /** 各 ID 正在进行的预取（script 加载）；并发调用方共享同一任务。 */
  private readonly pendingArrival = new Map<string, Promise<void>>()
  /** 实例化重入保护：factory 形式的 CJS 无法提供部分 exports，因此循环依赖必须失败。 */
  private readonly materializing = new Set<string>()
  private readonly graphRows = new Map<string, BootModuleRow>()
  private readonly loadBundle: (url: string) => Promise<void>

  /**
   * 根据已解析的启动条目构建模块系统。
   * @param options - 模块条目、模块表 staticModules 和 bundle 加载钩子。
   */
  constructor(options: ClientModuleSystemOptions) {
    this.seed = new Map(Object.entries(options.staticModules))
    this.loadBundle = options.loadBundle ?? defaultLoadBundle

    for (const row of options.modules) {
      if (this.graphRows.has(row.id)) throw new Error(`client-modules: duplicate graph entry "${row.id}"`)
      this.graphRows.set(row.id, row)
    }

    const win = globalThis as DshWindow
    if (win.__ModuleLoader__ !== undefined) throw new Error('client-modules: window.__ModuleLoader__ already installed (double boot?)')
    win.__ModuleLoader__ = {
      load: (handoff: ClientPluginHandoff): void => {
        // 注册以交接 ID 为键；重复注册表示 bundle 未经 invalidate 就执行了两次，
        // 属于必须明确报错的程序错误。
        if (this.factories.has(handoff.id)) throw new Error(`client-modules: duplicate factory registration for "${handoff.id}" (bundle executed twice without invalidate?)`)
        this.factories.set(handoff.id, handoff.factory)
      },
    }
  }

  /** 加载一个图条目以注册其 factory；对同一个进行中到达任务保持幂等。 */
  private arrive(row: BootModuleRow): Promise<void> {
    const { id, url } = row
    const pending = this.pendingArrival.get(id)
    if (pending !== undefined) return pending
    if (this.factories.has(id)) return Promise.resolve()
    const task = this.loadBundle(url).then(() => {
      if (!this.factories.has(id)) {
        throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`)
      }
    }).finally(() => { this.pendingArrival.delete(id) })
    this.pendingArrival.set(id, task)
    return task
  }

  /** 同步实例化已注册 factory，并在 loadCache 中缓存结果。 */
  private materialize(id: string): ClientModuleRecord {
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing
    const registered = this.factories.get(id)
    /* v8 ignore next -- 调用方会先检查 factory 分支再分派到这里。 */
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
   * 提供给 factory 的同步 require 按 seed → static → 缓存记录 → 已注册 factory 的
   * 顺序解析；最后一支会递归实例化，使加载顺序能够自行解析。获取 bundle 是异步
   * 操作，这里无法执行；未注册的插件 specifier 会明确报错，而跨插件值导入在上游
   * 构建阶段本就会失败。
   */
  private makeRequire(edges: Set<string>): (spec: string) => unknown {
    return (spec: string): unknown => {
      edges.add(spec)
      if (this.seed.has(spec)) return this.seed.get(spec)
      if (this.statics.has(spec)) return this.statics.get(spec)
      const id = stripClientSuffix(spec)
      const record = this.loadCache.get(id)
      if (record !== undefined) return record.exports
      if (this.factories.has(id)) return this.materialize(id).exports
      throw new Error(
        `client-modules: require("${spec}") missed the module table — not a platform seed word, not a shell-own module, `
        + 'and no registered factory (a build-time externals drift, or a forbidden cross-plugin value import)',
      )
    }
  }

  async import(specifier: string): Promise<unknown> {
    if (this.seed.has(specifier)) return this.seed.get(specifier)
    const existing = this.loadCache.get(specifier)
    if (existing !== undefined) return existing.exports
    if (this.statics.has(specifier)) {
      const exports = this.statics.get(specifier)
      this.loadCache.set(specifier, { id: specifier, exports, styles: [], edges: new Set() })
      return exports
    }
    if (!this.factories.has(specifier)) {
      const row = this.graphRows.get(specifier)
      if (row === undefined) {
        throw new Error(
          `client-modules: cannot resolve "${specifier}" — not a seed word, not a shell-own module, `
          + 'and not a row in the boot graph (the runtime mirror of the bundle purity gate)',
        )
      }
      await this.arrive(row)
    }
    return this.materialize(specifier).exports
  }

  registerStatic(id: string, module: unknown): void {
    if (this.statics.has(id)) throw new Error(`client-modules: shell-own module "${id}" registered twice`)
    this.statics.set(id, module)
  }

  async prefetch(id: string): Promise<void> {
    if (this.statics.has(id)) return
    const row = this.graphRows.get(id)
    if (row === undefined) throw new Error(`client-modules: prefetch("${id}") — not a graph entry`)
    await this.arrive(row)
  }

  invalidate(id: string): void {
    this.factories.delete(id)
    this.loadCache.delete(id)
  }
}
