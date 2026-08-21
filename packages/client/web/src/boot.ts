/**
 * Web 启动内核。它只拥有模块系统、Cordis loader 和不依赖 UI 框架的启动页。
 * 所有客户端配置项激活后，动态 UI renderer 才接管挂载点。
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type {
  BootManifest, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BootPage } from './boot-page.ts'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS } from './loader-status.ts'
import './base.css'

/** 模块传输钩子；jsdom 测试会替换它。 */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/** `apps/web` 消费的浏览器启动入口。 */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest

  /**
   * 绘制启动页；{@link run} 负责启动 loader。
   * @param container - 应用挂载点。
   * @param seams - 可选的模块传输替代实现。
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * 加载并激活每个客户端配置项，再把挂载点交给 UI renderer。插件失败会继续显示
   * 在启动页上。
   * @returns 应用完成挂载或失败报告完成渲染后 resolve。
   */
  async run(): Promise<void> {
    try {
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      // 预注入的传输层（worker 预览页）拥有 bundle 字节，其 loadBundle 作为默认值，
      // 显式 seams 仍优先。全局对象是 @deepseek-ai/dsh-client-connection 所有的
      // `ClientTransportHooks`；这里通过结构类型只读取一个可选成员，不新增包依赖边。
      const transport = (globalThis as {
        __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
      }).__DSH_TRANSPORT__
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
        ...this.seams,
      })
      this.manifest = this.modules.manifest

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      await this.runPluginBoot(ctx, prefetching)
      await this.mountApp(ctx)
    } catch (reason) {
      console.error(reason)
      this.page.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** 释放客户端插件树以及当前拥有挂载点的页面。 */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page.dispose()
  }

  /** 通过依赖 fiber 挂载，使替换 uiRenderer 时能够重新挂载应用。 */
  private async mountApp(ctx: Context): Promise<void> {
    const mounted = ctx.inject(['uiRenderer'], (scope) => {
      scope.effect(() => scope.uiRenderer.mount(this.container), 'web boot: application mount')
    })
    await mounted
  }

  /** 预取第一阶段 bundle；最终失败由其 import 路径负责。 */
  private async prefetchImmediateTier(): Promise<void> {
    // 携带 loadBundle 的传输层拥有 bundle 字节，对静态部署发起 HTTP 预取不会得到
    // 内容。没有 loadBundle 时 bundle 仍位于 HTTP 上，因此保留预取。
    const transport = (globalThis as {
      __DSH_TRANSPORT__?: { loadBundle?: unknown }
    }).__DSH_TRANSPORT__
    if (transport?.loadBundle !== undefined) return
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // 预取只负责提前启动传输；Loader import 会重试并报告该 bundle 的失败。
      })))
  }

  /** 挂载 Loader，创建全部图配置项，等待完全停稳并审计激活状态。 */
  private async runPluginBoot(ctx: Context, prefetching: Promise<void>): Promise<void> {
    await ctx.plugin(Loader)
    const loader = ctx.loader
    loader.internal = this.modules as never

    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.page.setState(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    const rows = this.manifest.plugins.map(row => row.id)
    this.page.setTotal(rows.length)
    await prefetching
    await Promise.all(rows.map(async (name) => {
      this.page.setState(name, 'loading')
      const id = await loader.create({ name })
      if (loader.resolve(id).fiber === undefined) this.page.setState(name, 'failed')
    }))

    await loader.await()
    this.assertEntriesActive(ctx)
  }

  /** 拒绝 import/apply 失败或仍在等待缺失服务的配置项。 */
  private assertEntriesActive(ctx: Context): void {
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
