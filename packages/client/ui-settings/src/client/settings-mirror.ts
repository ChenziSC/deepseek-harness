/**
 * Host Settings 文档的客户端 Mirror，也是浏览器中唯一的 `settings.describe` reader。
 * 所有 Settings Consumer 都从本 store 派生：逐 namespace scope 经由
 * `SettingsScopeBinder.bind`，跨 namespace 界面经由 Binder 的共享 describe 接口。因此
 * 启动成本和数据新鲜度由本类决定，与多少功能拥有偏好设置无关。Host 始终是事实来源：
 * Mirror 在所有者插件订阅的失效事件到来时重新读取，并通过
 * {@link SettingsDescribeMirror.acceptView} 把写入响应折叠进来。
 */

import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

type SettingsFace = Pick<IApiClient, 'settings'>

/** Mirror 提供的完整 `settings.describe` 响应。 */
export interface SettingsDescribeView {
  /** 所有活动 Host 插件注册的 namespace，以 Host 报告为准。 */
  namespaces: readonly SettingsNamespaceView[]
  /** Settings Provider 是否接受写入。 */
  writable: boolean
  /** 是否存在可由 Host 打开的原生 Settings 文档。 */
  hasDocument: boolean
}

/** 所有派生 Settings 界面共同渲染的 Mirror 状态。 */
export interface SettingsMirrorSnapshot {
  /**
   * `unavailable` 是非 loopback 的终止状态；后续刷新失败时仍保持 `ready`，继续提供已保存
   * View；`idle` 表示没有保存响应且没有读取进行中，因此 `ensure` 会启动读取。
   */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** 最近一次成功响应；首次成功前为 undefined。 */
  view: SettingsDescribeView | undefined
  /** 最近一次刷新失败信息；下次成功时清除。 */
  error: string | null
}

/**
 * Mirror 向跨 namespace 界面提供的接口：当前响应、订阅、首次使用读取和写入响应折叠。
 * `load` 不属于该接口，因为失效刷新由 Mirror 所有者插件负责。
 */
export interface SettingsDescribeFace {
  /** @returns 当前同步快照；下次变化前引用保持稳定。 */
  getSnapshot(): SettingsMirrorSnapshot
  /**
   * 观察快照替换。
   * @param listener - 每次快照变化后调用。
   * @returns 移除此 listener 的 disposer。
   */
  subscribe(listener: () => void): () => void
  /**
   * 保存响应或 Mirror 进入终止不可用状态后 resolve；只从 `idle` 启动读取。
   * @returns 当前或新启动读取的 settlement；没有读取时直接结束。
   */
  ensure(): Promise<void>
  /**
   * 不发起 wire 读取，把一次写入响应中的 namespace View 折叠进已保存 View，并使仍在进行的
   * 更早读取失效。
   * @param view - Settings 写入返回的 namespace View。
   */
  acceptView(view: SettingsNamespaceView): void
}

/**
 * 在一个快照 store 后串行化所有 Host `settings.describe` 读取。并发 {@link load} 调用折叠
 * 为当前读取加至多一次重跑，使读取期间到达的失效信号既不会丢失，也不会重复执行。
 */
export class SettingsDescribeMirror implements SettingsDescribeFace {
  private readonly store: SnapshotStore<SettingsMirrorSnapshot>
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0

  /**
   * @param api - Settings wire 接口。
   * @param persistence - Settings RPC 仅允许 loopback，因此远程浏览器只能使用进程内状态。
   */
  constructor(
    private readonly api: SettingsFace,
    private readonly persistence: 'host' | 'memory' = 'host',
  ) {
    this.store = createSnapshotStore<SettingsMirrorSnapshot>({
      status: persistence === 'host' ? 'idle' : 'unavailable',
      view: undefined,
      error: null,
    })
  }

  /** @returns 当前同步快照；下次变化前引用保持稳定。 */
  getSnapshot(): SettingsMirrorSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * 观察快照替换。
   * @param listener - 每次快照变化后调用。
   * @returns 移除此 listener 的 disposer。
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * 从 Host 刷新。读取进行中再次调用时，只标记在其结束后重跑一次，而不并发第二次 wire
   * 读取。
   * @returns 当前调用要求的新鲜度得到反映后的 settlement。
   */
  load(): Promise<void> {
    if (this.persistence === 'memory') return Promise.resolve()
    if (this.inFlight !== undefined) {
      this.rerun = true
      return this.inFlight
    }
    // 在发布 loading 状态可能同步重入 load() 之前，先占有 in-flight Slot。
    const run = Promise.resolve().then(() => this.run())
    this.inFlight = run
    return run
  }

  /**
   * 保存响应或 Mirror 进入终止不可用状态后 resolve；只从 `idle` 启动读取。这是供首次使用
   * 才渲染的界面调用的低成本幂等入口。
   * @returns 当前或新启动读取的 settlement；没有读取时直接结束。
   */
  ensure(): Promise<void> {
    if (this.persistence === 'memory') return Promise.resolve()
    if (this.inFlight !== undefined) return this.inFlight
    if (this.getSnapshot().status === 'idle') return this.load()
    return Promise.resolve()
  }

  /**
   * 不发起 wire 读取，把一次写入响应中的 namespace View 折叠进已保存 View，并使仍在进行的
   * 读取失效。若尚未保存完整文档，不把响应发布为部分文档；进行中的读取会重跑，避免发布
   * 写入提交前取得的旧文档。
   * @param view - Settings 写入返回的 namespace View。
   */
  acceptView(view: SettingsNamespaceView): void {
    const before = this.store.getSnapshot()
    this.generation += 1
    if (this.inFlight !== undefined) this.rerun = true
    if (before.view === undefined) return
    const namespaces = before.view.namespaces.some(row => row.ns === view.ns)
      ? before.view.namespaces.map(row => row.ns === view.ns ? view : row)
      : [...before.view.namespaces, view]
    this.store.set({ ...before, view: { ...before.view, namespaces } })
  }

  /**
   * 在已保存 View 上便捷查找 Row。
   * @param ns - namespace identity。
   * @returns namespace View；尚无响应或未注册时为 undefined。
   */
  namespace(ns: string): SettingsNamespaceView | undefined {
    return this.store.getSnapshot().view?.namespaces.find(row => row.ns === ns)
  }

  private async run(): Promise<void> {
    // in-flight Slot 必须在观察到 `rerun` 为 false 的同一同步片段内清除，异常退出时也一样。
    // 若把它放在返回 Promise 的 `.finally()` 中，会晚一个 microtask；落在间隙中的 `load()`
    // 将标记无人读取的重跑，导致本次刷新丢失。
    try {
      do {
        const before = this.store.getSnapshot()
        if (before.status === 'idle') this.store.set({ ...before, status: 'loading' })
        // wire 读取发出前立即清除：更早标记的 load()（包括从上方 loading 发布同步重入的
        // 调用）已经由本次读取覆盖；此后到达的调用才需要重跑。
        this.rerun = false
        const generation = ++this.generation
        let outcome: { view: SettingsDescribeView } | { failure: string }
        try {
          const response = await this.api.settings.describe({})
          outcome = response.result.ok
            ? { view: response.result.value }
            : { failure: response.result.error.message }
        } catch (error) {
          outcome = { failure: error instanceof Error ? error.message : String(error) }
        }
        // 写入响应会使写入提交前发起的文档读取失效。
        if (generation !== this.generation) continue
        if ('view' in outcome) {
          this.store.set({ status: 'ready', view: outcome.view, error: null })
        } else {
          const held = this.store.getSnapshot()
          // 尚无响应时回到 idle，让 `ensure` 重试；已有响应时继续提供保存的 View，只通过
          // error 字段报告此次失败。
          this.store.set({
            status: held.view === undefined ? 'idle' : 'ready',
            view: held.view,
            error: outcome.failure,
          })
        }
      } while (this.shouldRerun())
    } finally {
      this.inFlight = undefined
    }
  }

  private shouldRerun(): boolean {
    return this.rerun
  }
}
