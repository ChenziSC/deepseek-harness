/**
 * Settings namespace scope 约定的 Host transport。约定类型位于 `dsh-client-runtime`，
 * 它是所有拥有偏好设置功能的共同依赖；本文件负责在共享 {@link SettingsDescribeMirror}
 * 上派生逐 namespace 视图，以及串行写入路径，二者都属于 Settings 界面职责。读取在这里
 * 从不接触 wire：Mirror 是唯一的 `settings.describe` reader，每个 scope 都只是其快照上的
 * selector。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionHandle, IApiClient, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot,
  type SettingsScopeSpec, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
// 仅导入类型，并且有意不从 `@deepseek-ai/dsh-api-remotes/client` 导入：本包会经功能包调用方
// 进入 Host 构建图，而 api-remotes 的 Client 接口会导入由 Host tsdown 生成的 `/remote`
// 产物，从而导致 Host tsc 阶段死锁。Gateway 的 Client half 不依赖生成导入即可声明
// `ctx.remote`；allowlist 的 `types` 子路径是纯类型源码，因此两者组合可以提供 `$on` 及其
// 键接口，而不把构建产物拖入。运行时 `remote` inject 属于提供方插件的 apply；该 apply
// 负责注册 Mirror 的失效订阅。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
// 转发事件自身的声明：`$on` 的键接口是 `Extract<keyof Events, keyof Selection>`，因此只导入
// allowlist 会解析为 never。所有者包的 client-safe 纯类型子路径负责提供 Cordis `Events`
// 条目，以及随之而来的 branded `SettingsNamespace`。
import type {} from '@deepseek-ai/dsh-settings/types'
import type { SettingsSchemaService } from './schema.ts'
import { SettingsDescribeMirror, type SettingsDescribeFace } from './settings-mirror.ts'

type SettingsFace = Pick<IApiClient, 'settings'>

/**
 * 单个 namespace 在共享 describe mirror 上的派生视图，以及该 namespace 的串行 Host 写入。
 * 写入携带最新已知 namespace revision，并把响应折叠回 Mirror；拆除时会等待已经跨越 wire
 * 的操作结束。
 */
export class SettingsScopeController<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  private tail: Promise<void> = Promise.resolve()
  private writeGeneration = 0
  private disposed = false
  private readonly unsubscribe: (() => void) | undefined
  /**
   * 已被取代的写入返回、但仍领先于 Mirror 的 revision。Mirror 只折叠最新一次写入结果，
   * 因此队列中的后继写入会优先从这里取得 fence。
   */
  private pendingRevision: number | undefined

  /**
   * @param api - Settings wire 接口；只用于写入，读取经由 Mirror。
   * @param spec - namespace identity 与可选的窄化 decoder。
   * @param mirror - 当前 scope 的派生来源，即共享 describe mirror。
   * @param persistence - Settings RPC 仅允许 loopback，因此远程浏览器只能使用进程内状态。
   * @param schema - Settings 所有的 schema 操作。
   */
  constructor(
    private readonly api: SettingsFace,
    private readonly spec: SettingsScopeSpec<T>,
    private readonly mirror: SettingsDescribeMirror,
    private readonly persistence: 'host' | 'memory',
    private readonly schema: SettingsSchemaService,
  ) {
    this.store = createSnapshotStore<SettingsScopeSnapshot<T>>({
      status: persistence === 'host' ? 'loading' : 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: persistence,
    })
    if (persistence === 'host') {
      this.unsubscribe = mirror.subscribe(() => { this.derive() })
      this.derive()
    }
  }

  /** @returns 当前同步快照；下次变化前引用保持稳定。 */
  getSnapshot(): SettingsScopeSnapshot<T> {
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
   * 把一次字段写入加入队列；顺序、revision 与恢复约定见 {@link SettingsScope.set}。
   * @param field - namespace section 内的标量字段。
   * @param value - 用户选择的 JSON 形式值。
   * @returns 写入以及可能的最新写入恢复读取结束后的 settlement。
   */
  set(field: string, value: unknown): Promise<void> {
    return this.write({ op: 'set', path: [field], value })
  }

  /**
   * 把一次字段清除加入队列；顺序、revision 与恢复约定见 {@link SettingsScope.unset}。
   * @param field - namespace section 内的标量字段。
   * @returns 清除以及可能的最新写入恢复读取结束后的 settlement。
   */
  unset(field: string): Promise<void> {
    return this.write({ op: 'unset', path: [field] })
  }

  private write(op: SettingsPathOpView): Promise<void> {
    const generation = ++this.writeGeneration
    return this.enqueue(async () => {
      const revision = this.pendingRevision ?? this.getSnapshot().revision
      let response: Awaited<ReturnType<SettingsFace['settings']['mutate']>>
      try {
        response = await this.api.settings.mutate({
          ns: this.spec.namespace,
          ops: [op],
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
      } catch (_settingsWriteFailure) {
        await this.recover(generation)
        return
      }
      if (!response.result.ok) {
        await this.recover(generation)
        return
      }
      if (this.disposed) return
      if (generation === this.writeGeneration) {
        this.pendingRevision = undefined
        this.mirror.acceptView(response.result.value)
      } else {
        this.pendingRevision = response.result.value.revision
      }
    })
  }

  /** 为最新失败写入重新加载 Host 状态；已被取代的失败把恢复交给最新写入。 */
  private async recover(generation: number): Promise<void> {
    if (this.disposed || generation !== this.writeGeneration) return
    this.pendingRevision = undefined
    await this.mirror.load()
  }

  /**
   * 停止队列操作和派生，并等待当前 wire 调用结束。
   * @returns Controller 进入静止状态后的 settlement。
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.writeGeneration += 1
    this.unsubscribe?.()
    await this.tail
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.persistence === 'memory' || this.disposed) return Promise.resolve()
    const task = this.tail.then(async () => {
      if (this.disposed) return
      await operation()
    })
    // 返回的 Task 向调用方携带自身 settlement；队列 tail 始终保持 fulfilled，使一次失败
    // 不会搁置后续操作。
    this.tail = task.catch(() => {})
    return task
  }

  private derive(): void {
    if (this.disposed) return
    const mirrored = this.mirror.getSnapshot()
    if (mirrored.view === undefined) return
    const { writable } = mirrored.view
    const view = mirrored.view.namespaces.find(candidate => candidate.ns === this.spec.namespace)
    if (view === undefined) {
      this.store.update((draft) => {
        draft.status = 'unavailable'
        draft.writable = writable
      })
      return
    }
    const decoded = this.decode(view)
    this.store.update((draft) => {
      draft.revision = view.revision
      draft.base = view.base
      draft.user = view.user
      draft.writable = writable
      if (decoded === undefined) return
      draft.status = 'ready'
      draft.value = decoded
    })
  }

  private decode(view: SettingsNamespaceView): T | undefined {
    if (this.spec.decode !== undefined) return this.spec.decode(view.value)
    // Section 按构造规则必须是 plain object；若只依赖 Schemastery，null 或数组会经 object
    // 默认值解析，而不是被拒绝。
    if (typeof view.value !== 'object' || view.value === null || Array.isArray(view.value)) return undefined
    let failure: string | undefined
    try {
      failure = this.schema.validate(this.schema.rehydrate(view.schema), view.value)
    } catch (_malformedSchemaEnvelope) {
      // 客户端无法重新水合的 schema envelope 无法为任何 section 提供保证，因此其值与
      // schema 校验失败的值同样处理。
      return undefined
    }
    return failure === undefined ? view.value as T : undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    settingsScope: SettingsScopeBinder
  }
}

/**
 * Settings 域基础服务。拥有偏好设置的功能通过本服务而非共享函数访问 Settings transport：
 * 客户端 Bundle 纯度门禁禁止跨插件导入值，并要求跨插件协作经由 Cordis 服务，参见
 * `packages/client/tsdown.client.ts`。
 */
export class SettingsScopeBinder extends Service {
  private readonly mirror: SettingsDescribeMirror
  private readonly schema: SettingsSchemaService

  /**
   * @param ctx - 提供方插件的 Context。
   * @param config - 所有已绑定 scope 的共享 describe mirror 派生来源，以及 Settings
   * 所有的 schema 操作。
   */
  constructor(ctx: Context, config: { mirror: SettingsDescribeMirror; schema: SettingsSchemaService }) {
    super(ctx, 'settingsScope')
    this.mirror = config.mirror
    this.schema = config.schema
  }

  /**
   * 共享 Mirror 向跨 namespace 界面提供的读取/折叠接口，例如 schema introspection 和已服务
   * namespace 目录。逐 namespace Consumer 使用 {@link bind}；二者都从同一快照派生，
   * 因此对文档的认知不会互相冲突。
   * @returns 共享 Mirror 上的 describe 接口。
   */
  describe(): SettingsDescribeFace {
    return this.mirror
  }

  /**
   * 在调用方插件生命周期上绑定一个 namespace scope。服务 proxy 在调用时把 `this.ctx`
   * 绑定到调用方，因此 scope disposer 属于调用 fiber。Scope 从共享 Mirror 派生；Mirror 的
   * 失效订阅归提供方插件所有，所以绑定不会自行增加 wire 读取，激活也不会等待 Settings
   * transport。
   * @param spec - 业务域拥有的 namespace 约定。
   * @returns 供业务域服务与 Row 消费的已绑定 scope。
   */
  bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T> {
    const ctx = this.ctx
    const connection = ctx.get('connection') as ConnectionHandle
    const controller = new SettingsScopeController<T>(
      connection.api,
      spec,
      this.mirror,
      connection.isLoopback ? 'host' : 'memory',
      this.schema,
    )
    ctx.effect(() => {
      void this.mirror.ensure()
      return async () => {
        await controller.dispose()
      }
    }, `ui-settings: ${spec.namespace} settings scope`)
    return controller
  }
}
