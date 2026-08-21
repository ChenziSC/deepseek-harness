/**
 * Web shell 启动内核，也是 apps/web 入口消费的接口。这里存放无法成为 loader
 * 配置项的基础设施，且不会以值导入任何插件包。shell 自给规则要求即使插件
 * 失败，加载页仍能工作。唯一获准的例外是 modules 包：模块系统无法通过自身
 * 到达，因此其类与客户端包装层随 shell 打包；Cordis 就绪后，内核接管其插件
 * 配置项。
 *
 * AppWebEntry.run() 先建立模块接口，再建立插件接口：把
 * `window.__DSH_BOOT__` 解析为双视图 BootManifest（协议边界）→ 根据模块视图
 * 创建模块系统 → 渲染加载页 → 在挂载 vendored Cordis Loader 的同时并行预取
 * 每个 `immediately` 配置项（任何配置项创建前注入 `internal` 约定；浏览器中
 * 绝不能走 tree.import 的裸导入回退）→ 等待预取层 → 接管 modules 配置项，
 * 再为每个插件视图配置项以及 shell 所有的 app-shell 装配配置项创建 loader
 * 配置项 → 执行 loader.await() 并完整扫描 fiber（必须全部 ACTIVE，否则列出
 * 失败主体、原因及缺失服务）→ 切换 settled 信号，使 AppRoot 一次切换到真实 UI。
 *
 * 配置项创建必须等待整个 immediately 层。物化会执行同步的跨包 require 边
 * （例如 locale → runtime/client），fiber 的 inject 等待无法保护这一步；任何
 * 依赖配置项物化前，其 bundle 工厂必须已注册。单项预取失败仍会静默结算，
 * 因为创建侧 import 会重新加载并负责明确报错；这样屏障不会让一个坏 bundle
 * 提前变成全局快速失败。
 *
 * 组合关系位于宿主图中，shell 不作组合决策。app-shell 装配本身也是图配置项，
 * 同时是模块系统登记的唯一 shell 所有模块。
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createRoot, type Root } from 'react-dom/client'
import * as ModulesClient from '@deepseek-ai/dsh-client-modules/client'
import {
  ClientModuleSystem, parseBootManifest,
  type BootManifest, type ClientModuleSystemOptions, type DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import * as AppShell from './app-shell.ts'
import { APP_SHELL_ID } from './app-shell.ts'
import { AppRoot } from './AppRoot.tsx'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS, createLoaderStatusStore, createSignal } from './loader-status.ts'
import './base.css'

/** shell 透传的模块传输钩子；jsdom 测试用它替换 `<script>` 路径。 */
export type BootSeams = Pick<ClientModuleSystemOptions, 'loadBundle'>

/**
 * modules 包自身的图行 id。内核自行接管该配置项：其包装层静态注册并随 shell
 * 打包，不通过网络获取。因此插件行循环必须跳过它；vendored Group.create 不会
 * 按名称去重，第二个 fiber 会重复提供 `modules`。
 */
const MODULES_ID = '@deepseek-ai/dsh-client-modules'

/**
 * Web shell 内核：把加载页挂载到 DOM 元素，并在宿主图上运行两阶段启动。
 * 字段只保存 Cordis 之前必须存在的内容：解析后的 manifest、模块系统和加载页
 * UI 句柄；其他状态均由插件所有。
 */
export class AppWebEntry {
  private readonly el: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly status = createLoaderStatusStore()
  private readonly settled = createSignal(false)
  private readonly error = createSignal<string | undefined>(undefined)
  // run() 会在任何私有方法或 settled 门控闭包读取前完成赋值。
  private ctx!: Context
  private modules!: ClientModuleSystem
  private manifest!: BootManifest
  private root: Root | undefined

  /**
   * 保存挂载点；所有工作都由 {@link run} 完成。
   * @param el - 挂载点，即应用的 #root。
   * @param seams - 测试环境可选的模块传输覆盖项。
   */
  constructor(el: HTMLElement, seams?: BootSeams) {
    this.el = el
    this.seams = seams
  }

  /**
   * 运行启动链直到结算。启动链失败会正常 resolve 而非 reject：加载页继续显示，
   * 并渲染由内核所有的明确失败报告。只有启动 manifest 缺失或格式错误时才 reject，
   * 因为此时不存在可供启动的输入。
   * @returns UI 完成结算或失败报告完成渲染时 resolve。
   */
  async run(): Promise<void> {
    this.manifest = parseBootManifest((globalThis as DshWindow).__DSH_BOOT__)

    this.modules = new ClientModuleSystem({
      modules: this.manifest.modules, staticModules: getStaticModules(), ...this.seams,
    })
    // app-shell 装配是唯一由 shell 所有的模块；其他图行都是通过 fetch 到达的插件 bundle。
    this.modules.registerStatic(APP_SHELL_ID, AppShell)
    // 接管交接的供给侧：以 modules 包的裸包名注册其客户端部分。该名称同时等于图行
    // id 和配置项名称；带后缀的键会错过静态分支并触发真实 fetch。随后把实例放到
    // 内核 slot，包装层的 apply 从这里读取并提供 ctx.modules。
    this.modules.registerStatic(MODULES_ID, ModulesClient)
    ;(globalThis as DshWindow).__DSH_MODULES__ = this.modules

    this.root = createRoot(this.el)
    this.root.render(
      <AppRoot
        settled={this.settled}
        status={this.status}
        error={this.error}
        renderApp={() => {
          const shell = this.ctx.get('appShell')
          // 正常结算后不可达，因为每张图都包含 app-shell 配置项。
          if (shell === undefined) throw new Error('web boot: appShell service missing after settled')
          return shell.renderApp()
        }}
      />,
    )

    // immediately 层与 Loader 挂载并行预取；runPluginBoot 在创建配置项前等待完成。
    // 原因见模块注释：同步跨包 require 边要求所有 immediately 工厂先于物化注册。
    const prefetching = this.prefetchImmediateTier()
    this.ctx = new Context()
    try {
      await this.runPluginBoot(prefetching)
      this.settled.set(true)
    } catch (reason) {
      // 保持加载页并展示扫描报告，明确失败。
      console.error(reason)
      this.error.set(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** 卸载 shell，包括加载页或已结算 UI。 */
  dispose(): void {
    this.root?.unmount()
  }

  /** 预取 immediately 层；这里只注册工厂，失败交给 import 路径处理。 */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch(() => {
        // import 会按配置项重新加载并明确报告错误；这里吞掉异常，避免一个预取失败
        // 掩盖其他预取结果。
      })))
  }

  /** 插件接口：挂载 Loader、注入 `internal` 约定、接管 modules、创建图配置项、结算并扫描。 */
  private async runPluginBoot(prefetching: Promise<void>): Promise<void> {
    const ctx = this.ctx
    await ctx.plugin(Loader)
    const loader = ctx.loader
    // 必须在任何配置项存在前注入模块系统。internal 为 undefined 时，tree.import
    // 会回退到裸动态导入；这在浏览器中必然明确失败，只适合作为触发器，不能成为正常路径。
    loader.internal = this.modules as never

    // 状态投影：AppRoot 展示真实 fiber 状态。配置项下每次 internal/status 转换，
    // 都从其根 fiber 重新投影该行；子插件 fiber 共用同一个配置项。
    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.status.set(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    // 在任何配置项创建前设置屏障。创建配置项会物化 bundle，而物化会执行同步跨包
    // require 边，因此所有 immediately 层工厂必须先注册。个别预取失败时屏障仍会结算。
    await prefetching

    // 接管交接的插件侧：先创建 modules 配置项，其包装层 apply 读取内核 slot 并
    // 提供 ctx.modules。provide 位于插件接口；行循环为何必须跳过它见 MODULES_ID。
    const rows = [MODULES_ID, ...this.manifest.plugins.map(row => row.id).filter(id => id !== MODULES_ID), APP_SHELL_ID]
    // 配置项创建顺序没有语义，激活顺序由 fiber inject 等待负责；并发创建可并行加载
    // 未预取的 bundle。内核追加 app-shell 装配配置项，因为它是 shell 所有代码，
    // 而宿主图行全是插件 bundle。挂载装配不是组合决策；它沿用相同配置项生命周期，
    // 因而扫描和状态投影可以统一覆盖。
    await Promise.all(rows.map(async (name) => {
      this.status.set(name, 'loading')
      const id = await loader.create({ name })
      // import 失败会留下没有 fiber 的配置项：Entry._init 记录后返回。将其投影为
      // failed，因为没有 fiber 就不会产生状态事件。
      if (loader.resolve(id).fiber === undefined) {
        this.status.set(name, 'failed')
      }
    }))

    await loader.await()
    this.assertEntriesActive()
  }

  /**
   * 树完全停稳后扫描每个 loader 配置项。没有 fiber 表示 import 失败；非 ACTIVE
   * fiber 为 FAILED（apply 抛错）或 PENDING（所需服务始终未到达）。Cordis 的
   * inject 等待没有超时，因此本扫描负责补上明确失败行为。
   */
  private assertEntriesActive(): void {
    const ctx = this.ctx
    const failures: string[] = []
    for (const entry of ctx.loader.entries()) {
      const name = entry.options.name
      if (entry.fiber === undefined) {
        failures.push(`${name}: import failed (see console for the import error)`)
        continue
      }
      const state = STATE_LABELS[entry.fiber.state]
      if (state === 'active') continue
      if (state === 'pending') {
        const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
        failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: ${state}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }
}
