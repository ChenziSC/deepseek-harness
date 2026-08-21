/**
 * 权限默认设置控制器。权限 descriptor 来自共享 describe 镜像；动态 preset 枚举
 * 位于命名空间 schema 中，而每命名空间作用域不携带它。写入只针对 `defaultPreset`，
 * 携带 descriptor 修订号，并把响应折叠回镜像。
 */

import type {
  IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  SchemaNode, SettingsDescribeFace, SettingsSchemaService,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import { displayPermissionPreset } from './presentation.ts'

/** 权限在线协议中的 Host 设置命名空间。 */
export const PERMISSION_SETTINGS_NS = 'permission'

/** 一个可选择的新会话默认值。 */
export interface PermissionDefaultOption {
  /** 写入 Settings 的 preset 键。 */
  id: string
  /** Host 提供的标签，或转为标题格式的 preset 键。 */
  label: string
}

/** 权限设置行快照。 */
export interface PermissionSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  writable: boolean
  currentValue: string
  options: readonly PermissionDefaultOption[]
  revision: number
}

interface ConstChoice {
  type: string
  value?: unknown
  meta?: { description?: unknown }
}

/**
 * 读取 Host `defaultPreset` schema 编码的动态 preset 枚举。
 * @param view - 权限命名空间 descriptor。
 * @param schema - settings schema 操作。
 * @returns 当前值和可选项。
 */
export function permissionDefaultOf(view: SettingsNamespaceView, schema: SettingsSchemaService): {
  currentValue: string
  options: PermissionDefaultOption[]
} {
  const value = (view.value as { defaultPreset?: unknown } | null)?.defaultPreset
  if (typeof value !== 'string') throw new Error('permission settings has no defaultPreset value')
  const node = schema.nodeAtPath(schema.rehydrate(view.schema), ['defaultPreset'])
  if (node === undefined) throw new Error('permission settings schema has no defaultPreset field')
  const rawChoices = node.type === 'union'
    ? (node.list as SchemaNode[] | undefined) ?? []
    : [node]
  const options = rawChoices.flatMap((candidate) => {
    const choice = candidate as unknown as ConstChoice
    if (choice.type !== 'const' || typeof choice.value !== 'string') return []
    const described = choice.meta?.description
    return [{
      id: choice.value,
      label: typeof described === 'string' && described.length > 0
        ? displayPermissionPreset(choice.value, described)
        : displayPermissionPreset(choice.value, choice.value),
    }]
  })
  if (options.length === 0 || !options.some(option => option.id === value)) {
    throw new Error('permission settings schema does not advertise its current preset')
  }
  return { currentValue: value, options }
}

/** 从共享镜像派生设置行并通过该镜像写入默认值的控制器。 */
export class PermissionPresetSettingsController {
  /** 通过已绑定 selector hook 消费的行快照。 */
  readonly store: SnapshotStore<PermissionSettingsState> = createSnapshotStore({
    status: 'idle',
    error: null,
    writable: false,
    currentValue: '',
    options: [],
    revision: 0,
  })

  private following: (() => void) | undefined
  private saving = false
  private disposed = false

  /**
   * @param describeFace - 共享镜像的读取/折叠接口，也是 descriptor 和 schema 来源。
   * @param api - 写入 `defaultPreset` 的 settings 线协议接口。
   * @param schema - settings 拥有的 schema 操作。
   */
  constructor(
    private readonly describeFace: SettingsDescribeFace,
    private readonly api: Pick<IApiClient, 'settings'>,
    private readonly schema: SettingsSchemaService,
  ) {}

  /**
   * 开始跟随镜像（幂等），并反映其当前回答。
   * @returns 快照反映镜像后完成。
   */
  async load(): Promise<void> {
    if (this.disposed) return
    this.following ??= this.describeFace.subscribe(() => { this.derive() })
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    await this.describeFace.ensure()
    this.derive()
  }

  /**
   * 把一个 preset 持久化为后续新建会话的默认值。已有保存进行时的
   * 新选择会被忽略；保存期间行控件已禁用，因此这里只会丢弃程序化重复提交，
   * 不会丢失用户意图。
   * @param preset - 已公布的 preset 键。
   * @returns 无返回值；成功或失败由 {@link store} 承载。
   */
  async select(preset: string): Promise<void> {
    const state = this.store.getSnapshot()
    const view = this.describeFace.getSnapshot().view?.namespaces
      .find(entry => entry.ns === PERMISSION_SETTINGS_NS)
    if (view === undefined || !state.writable || this.saving) return
    this.saving = true
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
    })
    try {
      const response = await this.api.settings.mutate({
        ns: PERMISSION_SETTINGS_NS,
        ops: [{ op: 'set', path: ['defaultPreset'], value: preset }],
        expectedRevision: view.revision,
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      this.saving = false
      if (this.disposed) return
      // 镜像发布会到达本行自身订阅，因此折叠同时会在这里重新发布已接受值。
      this.describeFace.acceptView(response.result.value)
    } catch (error) {
      this.saving = false
      if (this.disposed) return
      this.fail(error)
    }
  }

  /** 停止跟随镜像；后续发布不再改变快照。 */
  dispose(): void {
    this.disposed = true
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.disposed || this.saving) return
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.status === 'unavailable') {
      // 终止的非 loopback 状态：settings RPC 仅支持 loopback，因此该行像未提供的
      // 命名空间一样隐藏自身。
      this.store.update((state) => {
        state.status = 'unavailable'
        state.writable = false
        state.currentValue = ''
        state.options = []
      })
      return
    }
    if (mirrored.view === undefined) {
      // 没有回答但持有失败时，该行进入失败；没有失败则说明读取仍在途，保持 loading。
      if (mirrored.error !== null) this.fail(new Error(mirrored.error))
      return
    }
    const view = mirrored.view.namespaces.find(entry => entry.ns === PERMISSION_SETTINGS_NS)
    if (view === undefined) {
      this.store.update((state) => {
        state.status = 'unavailable'
        state.writable = false
        state.currentValue = ''
        state.options = []
      })
      return
    }
    try {
      const resolved = permissionDefaultOf(view, this.schema)
      const { writable } = mirrored.view
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
        state.writable = writable
        state.currentValue = resolved.currentValue
        state.options = resolved.options
        state.revision = view.revision
      })
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    this.store.update((state) => {
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
    })
  }
}
