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
 * import 的解析分支顺序为：seed word → shell 实例；缓存记录 → exports；静态注册表
 * （shell 自带模块，如 app-shell）→ 模块；已注册 factory → 实例化；图条目 → 加载并
 * 实例化；其余情况明确抛错。这是构建期 bundle 纯度门禁在运行时的对应检查。
 * 交给 factory 的同步 `require` 遵循同一顺序，但没有异步加载分支，因此只能 require
 * 已注册的 bundle；跨插件值导入本来也会在构建期报错。
 *
 * 本文件是不含 Node 导入、可在浏览器使用的约定层：定义 `__DSH_BOOT__` 传输类型、
 * 启动清单解析器以及 {@link ClientModuleSystem} 的接口。包根入口则是组装传输数据的
 * 宿主端服务。
 */

import type {} from '@deepseek-ai/cordis'
import type { ClientModuleSystem } from './system.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Web shell 启动时构建的客户端模块系统，由 `./client` 包装插件提供。 */
    modules: ClientModuleLoader
  }
}

// 中文：这是宿主推送的客户端图条目；immediately 控制第一阶段预取，inject 仅供
// 展示，权威依赖边仍来自各包的 dsh.client 声明。英文 JSDoc 与类型等价文档同步。
/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks stage-one prefetch; `inject` is informational graph
 * metadata (the authoritative edges live in each package's `dsh.client`
 * declaration and reach fibers through entry creation).
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
  // 中文：仅供预检展示和 HMR 差异比较的包名依赖边。
  /** Package-name dependency edges, informational (preflight display / HMR diffing). */
  inject?: string[]
  // 中文：第一阶段预取标记，用于提前加载 script 并注册 factory。
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
}

// 中文：宿主以 window.__DSH_BOOT__ 注入的完整客户端条目图。
/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
export interface WebBootGraph {
  // 中文：覆盖整张图内容与 bundle 哈希的一致性锚点。
  /** Consistency anchor over the whole graph (content + bundle hashes). */
  rev: string
  // 中文：已组装条目；数组顺序不决定激活顺序。
  /** Composed entries; order carries no semantics (activation order is fiber inject waiting). */
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
}

/** 启动条目的 cordis 插件视图：包含组装条目所需信息，并规范化可选传输字段。 */
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
    if (row.inject !== undefined && (!Array.isArray(row.inject) || row.inject.some(i => typeof i !== 'string'))) {
      throw new Error(`client-modules: boot manifest entry ${where} inject must be a string array`)
    }
    if (row.immediately !== undefined && typeof row.immediately !== 'boolean') {
      throw new Error(`client-modules: boot manifest entry ${where} immediately must be a boolean`)
    }
    modules.push({ id: row.id, url: row.url, rev: row.rev })
    plugins.push({
      id: row.id,
      inject: row.inject === undefined ? [] : [...row.inject as string[]],
      immediately: row.immediately === true,
    })
  }
  return { rev: graph.rev, modules, plugins }
}

/** 客户端 bundle 交给 `window.__ModuleLoader__.load` 的注册交接结构。 */
export interface ClientPluginHandoff {
  /** 插件 ID（包名），也是注册键；必须与当前执行的图条目一致。 */
  id: string
  /**
   * 包含整个 bundle 主体的闭包 factory：接收绑定到模块表的同步 require，并返回
   * bundle exports；只在实例化时执行一次。
   */
  factory: (require: (spec: string) => unknown) => Record<string, unknown>
}

/** Web 启动协议的 Window API：宿主注入的图、注册接收器和内核交接槽位。 */
export interface DshWindow {
  /** 宿主组装的条目图，在 shell bundle 运行前注入；经 {@link parseBootManifest} 前保持原始传输值。 */
  __DSH_BOOT__?: unknown
  /** Bundle 注册接收器；每个页面由 {@link ClientModuleSystem} 构造器安装一次。 */
  __ModuleLoader__?: { load(handoff: ClientPluginHandoff): void }
  /**
   * 内核交接槽位：shell 内核构造实例后（此时 cordis 尚不存在）立即存入这里，使
   * `./client` 包装插件能将其作为 `ctx.modules` 提供。包装插件 apply 时槽位缺失
   * 表示内核时序错误，必须明确抛出。
   */
  __DSH_MODULES__?: ClientModuleSystem
}

/** {@link ClientModuleLoader.loadCache} 中逐模块保存的记录；当前模块图为扁平结构。 */
export interface ClientModuleRecord {
  /** 模块 ID，即条目名或包名。 */
  id: string
  /** 已实例化 exports：来自 factory 的 `module.exports` 或静态注册的 shell 模块。 */
  exports: unknown
  /** 实例化期间注入并归本模块所有的 `<style data-plugin>` 标签 ID，即 `data-plugin-css` 值。 */
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
   * 注册 shell 自带模块（如 app-shell，其代码随 shell bundle 分发，不会作为插件
   * bundle 到达）。
   * @param id - 条目名，即 shell 拥有的伪 ID。
   * @param module - 静态导入的模块命名空间。
   */
  registerStatic(id: string, module: unknown): void
  /**
   * 第一阶段到达：加载条目 script 以注册 factory，但不实例化，模块副作用会等到
   * import。对静态注册 ID 或 factory 已注册的 ID 不执行操作；并发调用共享同一个
   * 进行中任务。HMR 若要强制重新加载，需先调用 {@link invalidate}。
   * @param id - 图条目名。
   */
  prefetch(id: string): Promise<void>
  /**
   * 完整重置一个模块：删除已注册 factory 和实例化记录，使下次 prefetch/import
   * 重新加载；这是 HMR 的失效钩子。
   * @param id - 要失效的条目名。
   */
  invalidate(id: string): void
}

/** {@link ClientModuleSystem} 选项，由 Web shell 内核在启动时组装。 */
export interface ClientModuleSystemOptions {
  /** 模块表视图中的启动条目，来自 {@link parseBootManifest}。 */
  modules: BootModuleRow[]
  /** 模块表 seed：平台单例 specifier → shell 实例。 */
  staticModules: Record<string, unknown>
  /** Bundle 加载钩子；默认为同源的经典 `<script src>` 元素。 */
  loadBundle?: (url: string) => Promise<void>
}
