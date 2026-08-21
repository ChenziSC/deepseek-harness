/** 可选本地设置文档操作的状态拥有者。 */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Host 所拥有设置文档的浏览器状态。 */
export interface SettingsDocumentState {
  /** 元数据加载阶段；unavailable 表示提供方没有本地文档或读取失败。 */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** 是否有一个原生打开请求在途。 */
  opening: boolean
  /** 最近的元数据/原生打开诊断；UI 只显示本地化文案。 */
  error: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从共享镜像派生本地文档可用性，并调用 Host 拥有的无路径打开操作。 */
export class SettingsDocumentStore {
  /** 由已注册 header 操作共享、符合 uSES 要求的状态来源。 */
  readonly store: SnapshotStore<SettingsDocumentState> = createSnapshotStore({
    status: 'idle', opening: false, error: null,
  })

  private following: (() => void) | undefined

  /**
   * @param api - 打开提供方文档的 loopback settings 线协议接口。
   * @param describeFace - 共享镜像的 describe 接口，也是 `hasDocument` 来源。
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings'>,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * 开始跟随镜像（幂等），并反映当前提供方是否拥有本地文档。
   * @returns 快照反映镜像后完成。
   */
  async load(): Promise<void> {
    this.following ??= this.describeFace.subscribe(() => { this.derive() })
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    await this.describeFace.ensure()
    this.derive()
  }

  /**
   * 打开已加载文档一次；并发手势合并到在途操作之后。
   * @returns 原生打开请求结算后完成；不可用或已在打开时立即完成。
   */
  async open(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.status !== 'ready' || current.opening) return
    this.store.update((state) => {
      state.opening = true
      state.error = null
    })
    try {
      const response = await this.api.settings.openDocument({})
      if (!response.result.ok) throw new Error(response.result.error.message)
    } catch (error) {
      this.store.update((state) => { state.error = messageOf(error) })
    } finally {
      this.store.update((state) => { state.opening = false })
    }
  }

  /** 停止跟随镜像。 */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      // 没有回答但持有失败表示无法定位文档；若没有失败，则读取仍在途，保持 loading。
      if (mirrored.error !== null) {
        this.store.update((state) => {
          state.status = 'unavailable'
          state.error = mirrored.error
        })
      }
      return
    }
    const { hasDocument } = mirrored.view
    this.store.update((state) => {
      state.status = hasDocument ? 'ready' : 'unavailable'
      state.error = null
    })
  }
}
