/**
 * 客户端模块系统：Node 内部 ESM Loader 的浏览器端对应实现，采用延迟 CJS 表。
 * vendored cordis Loader 通过其 `internal` 约定使用本对象（唯一调用链为
 * `EntryTree.import` → `internal.import`），因此条目治理（fiber 生命周期、等待
 * inject、update/refresh）仍完全由 vendored 侧负责，本包只负责代码到达。
 *
 * 延迟 CJS 模型中，执行插件 bundle 只会注册其 factory
 * (`window.__ModuleLoader__.load({id, factory})`)；模块体的一切副作用（包括注入
 * CSS）都位于 factory 闭包内，在实例化而非 script 执行时发生。首次
 * import/require 时执行 factory(require) → exports，并把结果缓存在
 * {@link ClientModuleLoader.loadCache}。若 factory require 了另一个已注册但未实例化
 * 的模块，则递归实例化，因此加载顺序不需要外部编排。
 *
 * import 的解析分支顺序为：seed word → shell 实例；缓存记录 → exports；图条目 →
 * 注册依赖 factory 和自身 factory；已注册 factory → 实例化；其余情况明确抛错。
 * 这是构建期 bundle 纯度检查在运行时的对应保护。交给 factory 的同步 `require`
 * 遵循同一顺序，但没有异步加载分支，因此被请求的动态包必须在消费者实例化前注册。
 *
 * 本文件是不含 Node 导入、可在浏览器使用的约定层：定义 `__DSH_BOOT__` 传输类型、
 * 启动清单解析器以及 {@link ClientModuleSystem} 的接口。包根入口则是组装传输数据的
 * Host 端服务。
 */

import type {} from '@deepseek-ai/cordis'
import type { ClientModuleSystem } from './system.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Web shell 启动时构建的客户端模块系统，由 `./client` 包装插件提供。 */
    modules: ClientModuleLoader
  }
}

// 中文：这是 Host 推送的客户端图条目；immediately 控制第一阶段预取，inject 仅供
// 展示，权威服务依赖边仍来自各包的 dsh.client 声明。external 是模块图依赖，因
// require 同步而约束代码到达顺序。英文 JSDoc 与类型等价文档同步。
/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks stage-one prefetch; `inject` is informational graph
 * metadata (the authoritative edges live in each package's `dsh.client`
 * declaration and reach fibers through entry creation). `external` carries
 * module-graph edges: unlike `inject`, they constrain code arrival because
 * `require` is synchronous (see {@link WebBootGraph.entries}).
 */
export interface WebBootEntry {
  // 中文：条目名等于包名。
  /** Entry name == package name. */
  id: string
  // 中文：bundle 获取端点。
  /** Bundle endpoint, '/plugins/<id>/client.js?rev=<rev>'. */
  url: string
  // 中文：bundle 内容哈希，用于缓存失效和一致性判断。
  /** Bundle content hash (cache-busting consistency anchor). */
  rev: string
  // 中文：仅供预检展示和 HMR 差异比较的包名服务依赖边。
  /** Package-name dependency edges, informational (preflight display / HMR diffing). */
  inject?: string[]
  // 中文：第一阶段预取标记，用于提前加载 script 并注册 factory。
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
  // 中文：本行请求的非基线模块；没有请求时省略。
  /** Non-baseline module specifiers this row requests; omitted when it requests none. */
  external?: string[]
}

// 中文：这是 Host 通过 `window.__DSH_BOOT__` 注入的完整客户端条目图。
/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
export interface WebBootGraph {
  // 中文：该修订号覆盖整张图的内容与 bundle 哈希。
  /** Consistency anchor over the whole graph (content + bundle hashes). */
  rev: string
  // 中文：条目按模块图排序；动态提供方先于通过 external 请求它的消费者。
  /**
   * Composed entries in module-graph order — a dynamic package row precedes
   * rows whose `external` requests that package. Cordis activation order is
   * unrelated and remains owned by fiber service waiting.
   */
  entries: WebBootEntry[]
}

/** 启动条目的 npm 包视图：包含模块表获取 bundle 所需的信息。 */
export interface BootModuleRow {
  /** 条目名等于包名，也是模块表的键。 */
  id: string
  /** Bundle 端点：'/plugins/<id>/client.js?rev=<rev>'。 */
  url: string
  /** Bundle 内容哈希。 */
  rev: string
  /** 本行向模块表请求的模块 specifier；传输数据省略时为 []。 */
  external: string[]
}

/** 启动条目的 Cordis 插件视图：包含组装条目所需信息，并规范化可选传输字段。 */
export interface BootPluginRow {
  /** 条目名等于包名。 */
  id: string
  /** 以包名表示的依赖边；传输数据省略时为 []。 */
  inject: string[]
  /** 第一阶段预取层级；传输数据省略时为 false。 */
  immediately: boolean
}

/** 解析后的启动清单：一份传输数据，对应两种消费者视图。 */
export interface BootManifest {
  /** 覆盖整张图的一致性锚点。 */
  rev: string
  /** 供模块表使用的条目。 */
  modules: BootModuleRow[]
  /** 供条目组装逻辑使用的条目。 */
  plugins: BootPluginRow[]
}

/**
 * 校验从 `dsh.client` 声明或启动传输数据读取的可选字符串数组字段。
 * @param subject - 指明包或传输行的诊断前缀。
 * @param field - 诊断中使用的字段名。
 * @param value - 原始字段值。
 * @returns 校验后的数组；字段缺失时返回 undefined。
 * @throws {Error} 字段存在但不是字符串数组时抛出。
 */
export function optionalStringArray(subject: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`client-modules: ${subject} ${field} must be a string array`)
  }
  return value as string[]
}

/**
 * 把模块 specifier 规范到拥有它的图条目。插件 bundle 就是包的 client half，因此
 * `<id>/client`（外部 bundle 发出的 exports 子路径）和裸包名解析为同一 exports。
 * require 路径和图组合都在这里规范化，使每个导入包可以请求其代码实际导入的子路径。
 * @param spec - bundle require 或声明写出的模块 specifier。
 * @returns 移除末尾 `/client` 后的 specifier。
 */
export function stripClientSuffix(spec: string): string {
  return spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec
}

/**
 * 将 `window.__DSH_BOOT__` 解析为两种消费者视图。这里是传输边界：图缺失或格式错误
 * 时抛出异常，由 shell 明确展示失败；没有有效清单的页面无法启动任何内容。
 * @param wire - 原始 `window.__DSH_BOOT__` 值。
 * @returns 已规范化插件视图可选字段的清单。
 */
export function parseBootManifest(wire: unknown): BootManifest {
  if (typeof wire !== 'object' || wire === null) {
    throw new Error('client-modules: window.__DSH_BOOT__ is missing or not an object')
  }
  const graph = wire as Record<string, unknown>
  if (typeof graph.rev !== 'string') {
    throw new Error('client-modules: boot manifest rev must be a string')
  }
  if (!Array.isArray(graph.entries)) {
    throw new Error('client-modules: boot manifest entries must be an array')
  }
  const modules: BootModuleRow[] = []
  const plugins: BootPluginRow[] = []
  for (const value of graph.entries as unknown[]) {
    if (typeof value !== 'object' || value === null) {
      throw new Error('client-modules: boot manifest entry is not an object')
    }
    const row = value as Record<string, unknown>
    const where = typeof row.id === 'string' ? `"${row.id}"` : JSON.stringify(row)
    if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.rev !== 'string') {
      throw new Error(`client-modules: boot manifest entry ${where} must carry string id/url/rev`)
    }
    const subject = `boot manifest entry ${where}`
    const inject = optionalStringArray(subject, 'inject', row.inject)
    const external = optionalStringArray(subject, 'external', row.external)
    if (row.immediately !== undefined && typeof row.immediately !== 'boolean') {
      throw new Error(`client-modules: boot manifest entry ${where} immediately must be a boolean`)
    }
    modules.push({
      id: row.id,
      url: row.url,
      rev: row.rev,
      external: external === undefined ? [] : [...external],
    })
    plugins.push({
      id: row.id,
      inject: inject === undefined ? [] : [...inject],
      immediately: row.immediately === true,
    })
  }
  return { rev: graph.rev, modules, plugins }
}

/** 一个 client bundle 通过 `window.__ModuleLoader__.load` 提交的 factory 注册。 */
export interface ClientBundleRegistration {
  /** 插件 id（包名），也是注册键；必须与当前执行的图条目一致。 */
  id: string
  /**
   * 包含整个 bundle 主体的闭包 factory：接收绑定到模块表的同步 require，并返回
   * bundle exports；只在实例化时执行一次。
   */
  factory: (require: (spec: string) => unknown) => Record<string, unknown>
}

/** Web 入口创建客户端模块系统时传入的参数。 */
export interface ClientModuleCreateOptions {
  /** Host 注入的原始启动图；modules bundle 负责校验和投影。 */
  boot: unknown
  /** 模块表 seed：平台单例 specifier → shell 实例。 */
  staticModules: Record<string, unknown>
  /** Bundle 加载钩子；默认为同源 classic `<script src>` 元素。 */
  loadBundle?: (url: string) => Promise<void>
}

/** Factory 经 HTML bootstrap facade 实例化后的 modules bundle。 */
export interface ClientBootstrapModule {
  /** Modules bundle 注册携带的图/模块 id。 */
  id: string
  /** Cordis 随后激活 modules 条目时复用的已实例化 exports。 */
  exports: Record<string, unknown>
}

/** 稳定的页面全局 facade：先排队早期 bundle 注册，随后切换为活动注册。 */
export interface ClientModuleLoaderTarget {
  /** {@link create} 前进入队列；返回后直接注册。 */
  mode: 'queue' | 'live'
  /** 模块系统创建前由解析器预载 script 提交的注册。 */
  pendingQueue: ClientBundleRegistration[]
  /** 根据 {@link mode} 排队或立即注册一个 bundle factory。 */
  load(registration: ClientBundleRegistration): void
  /** 根据解析器预载的 modules bundle 恰好创建一次模块系统。 */
  create(options: ClientModuleCreateOptions): ClientModuleSystem
}

/** Web 启动协议的 Window API：Host 注入的图和注册 facade。 */
export interface DshWindow {
  /** Host 组装的条目图，在 shell bundle 运行前注入；经 {@link parseBootManifest} 前保持原始传输值。 */
  __DSH_BOOT__?: unknown
  /** HTML 安装的 facade：先是待处理注册队列，随后成为活动模块系统目标。 */
  __ModuleLoader__?: ClientModuleLoaderTarget
}

/** {@link ClientModuleLoader.loadCache} 中逐模块保存的记录；当前模块图为扁平结构。 */
export interface ClientModuleRecord {
  /** 模块 id，即条目名或包名。 */
  id: string
  /** 已实例化 exports：来自 factory 或 bootstrap 注册的 `module.exports`。 */
  exports: unknown
  /** 实例化期间注入并归本模块所有的 `<style data-plugin>` 标签 id，即 `data-plugin-css` 值。 */
  styles: string[]
  /** 已观测到的 `require()` 依赖边；当前只会出现模块表中的名称。 */
  edges: Set<string>
}

/**
 * vendored Loader 与客户端 HMR 插件使用的内部接口子集。shell 启动时将其挂到
 * `ctx.loader.internal`，并以 `ctx.modules` 提供。
 */
export interface ClientModuleLoader {
  /** 用于区分 Node 内部 Loader 结构（'v1'/'v2'）的判别字段。 */
  version: 'client'
  /** 模块系统创建后与 Web 入口共享的已解析 Host 启动图。 */
  manifest: BootManifest
  /** 已实例化模块注册表：id → record；条目治理侧通过它读取 exports。 */
  loadCache: Map<string, ClientModuleRecord>
  /**
   * vendored Loader 的 `tree.import` 使用的内部接口。按照模块文档所述的分支顺序
   * 解析 `specifier`，必要时获取并执行 bundle。
   * @param specifier - 模块 specifier，即条目名或模块表名称。
   * @param parentURL - 导入方 URL；客户端模块图为扁平结构，因此未使用。
   * @param attrs - Import attributes；未使用，仅用于与 Node Loader 接口保持一致。
   * @returns 模块 exports。
   */
  import(specifier: string, parentURL: string, attrs: Record<string, unknown>): Promise<unknown>
  /**
   * 第一阶段到达：先加载条目声明的动态请求，再加载自身 script，从而注册各自 factory；
   * 此时不实例化，模块副作用会等到 import。对已经实例化的 bootstrap id 不执行操作。
   * 已注册图条目仍会先注册未解析的声明请求，再跳过自身 script；并发到达共享同一个
   * 进行中任务。HMR 若要强制重新加载，需先调用 {@link invalidate}。
   * @param id - 图条目名。
   */
  prefetch(id: string): Promise<void>
  /**
   * 完整重置一个非 bootstrap 模块：删除已注册 factory 和实例化记录，使下次
   * prefetch/import 重新加载；这是 HMR 的失效钩子。bootstrap 模块保持实例化。
   * @param id - 要失效的条目名。
   */
  invalidate(id: string): void
}

/** Modules bundle 的 bootstrap 导出组装的内部构造参数。 */
export interface ClientModuleSystemOptions {
  /** 由最终模块系统拥有的已解析启动图。 */
  manifest: BootManifest
  /** 模块表 seed：平台单例 specifier → shell 实例。 */
  staticModules: Record<string, unknown>
  /** HTML 安装的稳定注册 facade，用于从队列模式切换到活动模式。 */
  registrationTarget: ClientModuleLoaderTarget
  /** 创建系统时消费的已实例化 modules bundle。 */
  bootstrapModule: ClientBootstrapModule
  /** Bundle 加载钩子；默认为同源 classic `<script src>` 元素。 */
  loadBundle?: (url: string) => Promise<void>
}
