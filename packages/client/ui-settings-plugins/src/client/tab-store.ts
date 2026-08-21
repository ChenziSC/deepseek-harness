/**
 * 可配置插件标签页的卡片列表。
 *
 * 标签页按 settings 命名空间分发 Slot，因此渲染的是两份台账的交集：Host 提供的
 * 命名空间，以及注册到 `settings.plugin.item` 的卡片。已提供但没有卡片认领的
 * 命名空间不渲染，说明它由其他界面拥有，或部署未携带其浏览器端；Host 未提供
 * 对应命名空间的卡片则永不分发，因此部署未组合的插件不留痕迹，也不影响空状态。
 */

import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** 分区渲染的状态。 */
export interface ConfigurablePluginsTabState {
  /**
   * Host 是否至少回答过一次。空状态要等待该回答：读取尚未回答不等于“此部署未配置
   * 插件”；若在前者仍成立时显示后者，每次打开都会闪现错误结论。
   */
  loaded: boolean
  /**
   * 要分发的命名空间，按卡片注册顺序排列，并收窄为 Host 实际提供者。采用卡片注册
   * 顺序而非 Host describe 顺序；后者跟随插件激活，异步 settings 注入可能使其在
   * 不同启动间重排。设置页卡片每次访问都移动，比遵循注册者选择的固定顺序更糟。
   */
  namespaces: string[]
}

/** 标签页 Slot 条目注入的注册侧接口。 */
export interface ConfigurablePluginsTabFace {
  hooks: {
    /** 由渲染器绑定为 usePluginConfigSection 的分区快照。 */
    configurablePlugins: SnapshotStore<ConfigurablePluginsTabState>
  }
}

/** 从共享 describe 镜像派生已提供命名空间，并与认领它们的卡片配对。 */
export class ConfigurablePluginsTabController {
  private readonly store = createSnapshotStore<ConfigurablePluginsTabState>({ loaded: false, namespaces: [] })
  private disposed = false
  private readonly unsubscribe: () => void

  /**
   * @param describeFace - 共享镜像的 describe 接口；文档提交、重连时的刷新使已提供
   * 集合保持最新。
   * @param entries - 读取当前注册到分区 Slot 的卡片。
   */
  constructor(
    private readonly describeFace: SettingsDescribeFace,
    private readonly entries: () => readonly StoredEntry[],
  ) {
    this.unsubscribe = describeFace.subscribe(() => { this.publish() })
    void describeFace.ensure()
    this.publish()
  }

  /** Slot 台账变化后重新发布；迟注册卡片在这里加入。 */
  refresh(): void {
    if (this.disposed) return
    this.publish()
  }

  /** 停止发布并停止跟随镜像。 */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  /**
   * 构造标签页 Slot 注册所注入的接口。
   * @returns 标签页快照来源。
   */
  inject(): ConfigurablePluginsTabFace {
    return { hooks: { configurablePlugins: this.store } }
  }

  private publish(): void {
    if (this.disposed) return
    const mirrored = this.describeFace.getSnapshot()
    const loaded = mirrored.view !== undefined
    const served = new Set(mirrored.view?.namespaces.map(view => view.ns) ?? [])
    const namespaces = this.entries().flatMap(entry =>
      entry.options.key !== undefined && served.has(entry.options.key) ? [entry.options.key] : [])
    const previous = this.store.getSnapshot()
    // 每次 settings 文档提交都会刷新镜像，但多数提交不改变本分区展示内容。observable
    // 来源必须在事实变化前保持快照引用，否则每次无关保存都会重渲染整份卡片列表；
    // 见 packages/client/AGENTS.md 响应式规则 5。
    if (previous.loaded === loaded
      && previous.namespaces.length === namespaces.length
      && previous.namespaces.every((ns, index) => ns === namespaces[index])) return
    this.store.set({ loaded, namespaces })
  }
}
