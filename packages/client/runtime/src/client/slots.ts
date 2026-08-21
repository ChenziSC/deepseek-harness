/**
 * SlotRegistry 是构建在纯 SlotCore 之上的槽位系统 cordis Service 层。ui-slots 负责
 * 注册语义、声明账本、加载时校验和卸载级联；本层负责需要 runtime 参与的部分：
 * 'slots/changed' 事件桥、通过调用方 ctx.effect 执行注册和声明注入（fiber 卸载时两者
 * 一并回收）、渲染器安装约定（install()/renderSlot('root') 与 SlotRendererHost 接口），
 * 以及 store 实例轴：handle × scope key → 创建/缓存。最后一个持有条目卸载时删除记录，
 * scope 销毁时清除 session 实例及其持久状态。
 */
/* oxlint-disable typescript/no-redundant-type-constituents --
 * `keyof SlotMap & string` 是声明合并的键模式。本编译单元中的 SlotMap 只含本包的
 * 'root' 行，但消费者会合并更多键；规则命中的是窄映射视图，并非真实冗余。 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  LiveSlotNode, LocaleFace, OwnerOf, SlotEntryDef, SlotMap, SlotRenderer, SlotRendererHost,
  SlotScope, SlotSpec, StoreDecl, StoreFactory, StoredEntry, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // 中文说明：root 是 shell 唯一直接渲染的 single 槽位，由 AppFrame 占用。不要
    // 向此处追加条目，否则会遮蔽整个框架；全局浮层应注册到 `shell.overlay`。下方英文
    // JSDoc 会生成到客户端运行时槽位目录，故保留原文。
    /**
     * The built-in render-tree root hole (seeded by SlotCore): the one slot the
     * shell itself renders, and the ancestor of every other seat. OCCUPIED by
     * ui-layout's AppFrame, which declares the sidebar, conversation, details,
     * and shell.overlay seats inside it.
     *
     * DO NOT register here. This is a single slot, so a second entry does not
     * sit beside the frame — it shadows it, and a dynamically registered entry
     * is assigned a lower priority than the shipped one, which makes it the
     * winner: the page would render your component alone, with every seat the
     * frame declares gone. For a surface of your own that floats over the whole
     * app, register into `shell.overlay` instead (a list slot: additive, and
     * click-through until your entry opts into pointer events).
     */
    'root': { kind: 'single'; scope: 'root'; owner: RootOwnerProps }
  }
}

// 中文：root owner 不提供共享值，frame 由 inject 完成组装。
/** Root owner share: the shell supplies nothing — the frame is inject-assembled. */
export interface RootOwnerProps { children?: never }

/** Root scope store 记录的实例键；session 记录以 session ID 为键，因此不会冲突。 */
const ROOT_INSTANCE_KEY = 'root'

/** Runtime 生命周期映射使用的规范化类型擦除 store handle。 */
type EngineStoreHandle = Exclude<StoreDecl, StoreFactory>

/** 根据 handle create 接口得出的规范化引擎实例。 */
type EngineStoreInstance = ReturnType<EngineStoreHandle['create']>

/** Store 轴记录：每个活跃 handle 一条；最后一个持有条目卸载时删除。 */
interface StoreAxisRecord {
  /** Handle 所挂载槽位的 scope；core 已校验跨 scope 冲突。 */
  scope: SlotScope
  /** 当前持有 handle 的活跃注册数。 */
  refs: number
  /** Root scope 在 {@link ROOT_INSTANCE_KEY} 下只有一个实例；session scope 每个 session ID 一个。 */
  instances: Map<string, EngineStoreInstance>
}

/** 实现使用的类型擦除选项视图；类型化重载已验证共享数据。 */
interface ErasedRegisterOptions {
  name: string
  children?: Record<string, SlotSpec<SlotEntryDef>>
  store?: StoreDecl
  inject?: (...args: never[]) => Record<string, unknown>
  key?: string
  id?: string
  order?: number
  label?: string
  /** Chain 槽位路由 selector；纯函数，core 会校验 chain target 是否提供。 */
  select?: (owner: never) => unknown
  /** Chain 槽位显式顺序覆盖；升序排列，未提供时按注册顺序。 */
  priority?: number
  /** 声明的词典命名空间；渲染器据此生成 `t` 席位。 */
  locale?: string
  registrant?: string
}

/** 类型擦除的 core 调用接口；服务在自身边界重新擦除，core 类型化接口面向最终调用方。 */
interface ErasedCore { register(options: object, component: unknown): () => void }

/** 注入槽位声明存活期间安装的一个同步 effect。 */
type SlotInjectionEffect = (() => void) | Iterable<() => void, void, void>

/** 槽位系统的 cordis Service 层；与 SlotCore 的职责划分见模块注释。 */
export class SlotRegistry extends Service {
  private readonly _core = new SlotCore()
  /** Store 实例轴：handle → 挂载 scope、引用计数、已解析实例。 */
  private readonly _stores = new Map<EngineStoreHandle, StoreAxisRecord>()
  private _renderer: SlotRenderer | undefined
  private _locale: LocaleFace | undefined
  private _host: SlotRendererHost | undefined

  /**
   * @param ctx - 所属根上下文。
   */
  constructor(ctx: Context) {
    super(ctx, 'slots')
    this._core.onMutate((key) => { ctx.emit('slots/changed', key) })
  }

  /**
   * 唯一注册 API。类型化接口直接复用 core 的 register 两个重载，保持唯一权威而不
   * 复制结构。children 声明、store 席位、inject 接口、加载时校验和卸载级联见
   * SlotCore.register。本层补充：通过调用方 ctx.effect 销毁（fiber 卸载即级联）、
   * 创建独占 factory（`store: createXxxStore` 转为逐条目 handle）、registrant 诊断
   * 标记，以及条目轴上的 store 实例生命周期。
   *
   * 此处声明，类后通过 prototype 赋值实现。它必须保持 prototype 方法，不能改为实例
   * 箭头函数：cordis 服务代理会在调用时把 `this.ctx` 绑定到调用方上下文，从而将
   * effect 及卸载级联路由到调用方 fiber。箭头属性会把 `this` 固定为服务自身根 ctx，
   * 并静默破坏逐插件销毁。
   */
  declare readonly register: SlotCore['register']

  /**
   * 为槽位的每个声明生命周期安装 effect。声明已存在时同步执行 callback；否则在
   * 声明完成提交后，于相应 `register()` 调用内部执行。声明折叠时销毁 effect，之后
   * 再次声明会重新执行。callback effect 可以是同步 disposer；可迭代 effects 按事务
   * 安装并逆序销毁。控制器属于调用方 fiber，因此插件卸载会取消等待并移除活跃贡献。
   *
   * @param key - 要依赖的已声明 SlotMap 键。
   * @param callback - 创建一个 disposer 或一组可迭代 disposers。
   * @returns 同时清理等待和活跃 effect 的幂等 disposer。
   * @throws 槽位已声明时，callback 初始化失败会同步抛出。
   */
  inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void {
    const ctx = this.ctx
    const disposeController = ctx.effect(() => {
      let active: (() => void) | undefined
      let activeEpoch: number | undefined
      let stopped = false
      let unsubscribe = (): void => {}

      const stop = (): void => {
        if (stopped) return
        // 失败会永久终止本次注入；延迟初始化失败不会在之后的声明上重试。
        stopped = true
        unsubscribe()
        const dispose = active
        active = undefined
        activeEpoch = undefined
        dispose?.()
      }

      const reconcile = (): void => {
        if (stopped) return
        const spec = this._core.specDynamic(key)
        const epoch = this._core.declarationEpoch(key)
        if (active !== undefined && activeEpoch === epoch) return
        const dispose = active
        active = undefined
        activeEpoch = undefined
        dispose?.()
        if (spec === undefined) return
        // 声明生命周期是嵌套 Cordis effect，使 generator callback 与其他插件 effect
        // 一样获得事务化初始化、逆序拆除、诊断树和幂等性。
        const disposeEffect = ctx.effect(callback, `slots.inject(${JSON.stringify(key)}): declaration`)
        active = () => { void disposeEffect() }
        activeEpoch = epoch
      }

      const changed = (): void => {
        try {
          reconcile()
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT') {
            stop()
            return
          }
          stop()
          const failure = error instanceof Error ? error : new Error(String(error))
          queueMicrotask(() => { throw failure })
        }
      }

      unsubscribe = this._core.subscribeDeclaration(key, changed)
      try {
        reconcile()
      } catch (error) {
        stop()
        throw error
      }
      return stop
    }, `slots.inject(${JSON.stringify(key)})`)
    return () => { void disposeController() }
  }

  /**
   * 安装 shell 渲染器，即 web-react 的 createSlotRenderer 产物。每次启动只能安装一次，
   * 再次安装会抛错。通过调用方 ctx.effect 运行，因此 shell fiber 卸载会卸载渲染器。
   * @param renderer - 实现 SlotRenderer 的 outlet 机制。
   */
  install(renderer: SlotRenderer): void {
    if (this._renderer !== undefined) throw new Error('slot renderer already installed (install() is boot-once)')
    this.ctx.effect(() => {
      this._renderer = renderer
      return () => {
        if (this._renderer === renderer) this._renderer = undefined
      }
    }, 'slots.install()')
  }

  /**
   * 安装支撑 `t` 标准席位的 locale 接口，即 locale 插件产物；与渲染器一样每次启动
   * 只能安装一次。通过调用方 ctx.effect 运行，因此安装方 fiber 卸载会卸载该接口。
   * @param face - 命名空间 binder 和 revision observable。
   */
  installLocale(face: LocaleFace): void {
    if (this._locale !== undefined) throw new Error('locale face already installed (installLocale() is boot-once)')
    this.ctx.effect(() => {
      this._locale = face
      return () => {
        if (this._locale === face) this._locale = undefined
      }
    }, 'slots.installLocale()')
  }

  /**
   * 唯一 ctx 级渲染入口：shell 渲染 'root'；其他键都在组件内部通过 props renderSlot
   * 接口渲染。三个保护条件都是明确失败的启动顺序检查，不提供 fallback。
   * @param key - 必须为 'root'；runtime 会为动态组装调用方强制检查。
   * @param owner - root 条目的 owner 共享数据；shell 传入 {}。
   * @returns 已渲染根树。
   */
  renderSlot<K extends keyof SlotMap & string>(key: K, owner: OwnerOf<K>): ReturnType<SlotRenderer['renderRoot']> {
    // 在本包自身程序中 SlotMap 只有 'root'，类型收窄会让此保护折叠为恒 false；保留
    // 检查是为了普通 JavaScript 和 K 更宽的跨程序调用方。
    if ((key as string) !== 'root') {
      throw new Error(`ctx-level renderSlot only renders 'root' (got "${key}"); child slots render through the component props face`)
    }
    if (this._renderer === undefined) {
      throw new Error("slot renderer not installed — boot must call ctx.slots.install(createSlotRenderer()) before rendering 'root'")
    }
    if (this._core.entries('root').length === 0) {
      throw new Error("'root' has no registration — a layout entry must register into 'root' before the shell renders it")
    }
    return this._renderer.renderRoot(this.hostFace(), owner)
  }

  /**
   * 删除已结束 session 的逐 session store 实例。sessions 服务在拆除 scope 时调用，
   * root scope 记录不受影响。持久状态随 session 一同删除；从未渲染的已结束 session
   * 仍可能拥有上次页面加载留下的键，因此会临时实例化，仅用于清理存储；未持久化
   * store 上此操作无效。
   * @param sessionId - 已拆除的 session。
   */
  pruneStoreScope(sessionId: string): void {
    for (const [handle, record] of this._stores) {
      if (record.scope !== 'session') continue
      const instance = record.instances.get(sessionId) ?? handle.create(sessionId)
      instance.clearPersisted()
      record.instances.delete(sessionId)
    }
  }

  /**
   * 获取某键的条目快照；这是擦除渲染类型的视图，变化之间引用稳定。
   * @param key - SlotMap 键。
   * @returns 已注册条目。
   */
  entries(key: keyof SlotMap & string): readonly StoredEntry[] {
    return this._core.entries(key)
  }

  /**
   * 某键每个 cell 的遮蔽获胜者：按优先级排列的首个活跃且未放弃条目，也是 outlet
   * 实际渲染内容。chain 键原样透传，因为选举会消费全部条目。原始
   * {@link SlotsService.entries} 视图继续作为检查接口。每次调用返回新数组，不能作为
   * uSES getSnapshot 源。
   * @param key - SlotMap 键。
   * @returns 每个已占用 cell 的获胜条目。
   */
  entriesOfSlot(key: keyof SlotMap & string): readonly StoredEntry[] {
    return this._core.entriesOfSlot(key)
  }

  /**
   * 导出当前可安全序列化为 JSON 的 Slot 声明树，供只读检查。
   * @param root - 准确的活跃 Slot 根；省略时返回全部根。
   * @returns 所选 Slot 树。
   */
  snapshot(root?: string): LiveSlotNode[] {
    return this._core.snapshot(root)
  }

  /**
   * 观察条目边界崩溃，包括边界包住的每次渲染期失败，无论条目是否放弃。插件可通过
   * 此监督接口镜像贡献健康状态。每次报告同步触发；若崩溃导致放弃，则在注册表变更
   * 后触发。调用方拥有 disposer，应像 {@link SlotsService.subscribe} 一样通过
   * ctx.effect 接入，以便随 fiber 生命周期清理。
   * @param fn - 接收槽位键、崩溃条目、原因和 `abdicated`；后者表示崩溃是否使条目
   * 从其 cell 退出。
   * @returns 取消订阅函数。
   */
  onEntryError(fn: (key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean }) => void): () => void {
    return this._core.onEntryError(fn)
  }

  /**
   * 查询已声明 spec，来源可以是 register 声明或内置 'root'。
   * @param key - SlotMap 键。
   * @returns spec；不存在时返回 undefined。
   */
  spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined {
    return this._core.spec(key)
  }

  /**
   * 订阅某键的注册变化；通知按微任务合并。
   * @param key - SlotMap 键。
   * @param fn - 变化回调。
   * @returns 取消订阅函数。
   */
  subscribe(key: keyof SlotMap & string, fn: () => void): () => void {
    return this._core.subscribe(key, fn)
  }

  /**
   * 供 uSES 配对使用的版本计数器。
   * @param key - SlotMap 键。
   * @returns 当前版本。
   */
  getVersion(key: keyof SlotMap & string): number {
    return this._core.getVersion(key)
  }

  /** 委托注册路径：创建 factory、添加 registrant 标记、写入 core、记录实例轴。 */
  private _register(options: ErasedRegisterOptions, component: unknown): () => void {
    // 独占 store 直接传入 factory；这里将其创建为逐条目 handle，使存储条目始终携带
    // 可解析 handle。core 的共享 handle scope 固定规则对它同样适用且无害。
    const store = typeof options.store === 'function' ? options.store() : options.store
    const registrant = options.registrant ?? (this.ctx.fiber as { name?: string } | undefined)?.name
    const erased: ErasedRegisterOptions = {
      ...options,
      ...(store !== undefined ? { store } : {}),
      ...(registrant !== undefined ? { registrant } : {}),
    }
    // 先写 core：所有加载时校验（未声明 target、重复声明、kind 冲突、跨 scope handle）
    // 都会在本层提交任何内容前由 core 抛出。
    const dispose = (this._core as unknown as ErasedCore).register(erased, component)
    if (store !== undefined) {
      // 注册已成功，因此 target spec 已写入账本。
      const scope = (this._core.specDynamic(options.name) as SlotSpec<SlotEntryDef>).scope
      this._acquire(store, scope)
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      dispose()
      if (store !== undefined) this._release(store)
    }
  }

  /** 两个对象层服务都挂载后只构建一次；逐 session provide bundles 仍延迟解析。 */
  private hostFace(): SlotRendererHost {
    if (this._host !== undefined) return this._host
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) {
      throw new Error("renderSlot('root') before the sessions service mounted — boot order puts runtime apply first")
    }
    const workspaces = this.ctx.get('workspaces')
    if (workspaces === undefined) {
      throw new Error("renderSlot('root') before the workspaces service mounted — boot order puts runtime apply first")
    }
    // `locale` 是实时 getter：接口随 locale 插件自身 fiber 生命周期安装，并在 HMR 下
    // 替换，而本 host 对象只构建一次。若捕获固定值，渲染会停留在已失效接口上。这里
    // 必须使用别名，因为 getter 内的 `this` 指向 host 字面量。
    // oxlint-disable-next-line typescript/no-this-alias
    const service = this
    this._host = {
      subscribe: (key, fn) => this._core.subscribe(key, fn),
      getVersion: key => this._core.getVersion(key),
      entriesOf: key => this._core.entries(key),
      entriesOfSlot: key => this._core.entriesOfSlot(key),
      reportEntryError: (key, entry, error, info) => { this._core.reportEntryError(key, entry, error, info) },
      specOf: key => this._core.specDynamic(key),
      isLive: entry => this._core.isLive(entry),
      storeOf: (entry, scopeKey) =>
        entry.store === undefined ? undefined : this.resolveStore(entry.store as unknown as EngineStoreHandle, scopeKey),
      sessions: {
        list: sessions.list,
        provideInfo: sessions.currentProvideInfo,
      },
      workspaces: { list: workspaces.list },
      get locale() { return service._locale },
    }
    return this._host
  }

  /** 在 scope key 下解析已注册 handle 的 store 实例：创建或复用。 */
  private resolveStore(handle: EngineStoreHandle, sessionId: string | undefined): StoreInstanceLike {
    const record = this._stores.get(handle)
    if (record === undefined) throw new Error('store handle is not registered (entry unloaded, or the handle never went through register)')
    const key = record.scope === 'root' ? ROOT_INSTANCE_KEY : sessionId
    if (key === undefined) throw new Error(`${record.scope} store resolution requires a session id`)
    let instance = record.instances.get(key)
    if (instance === undefined) {
      // Session 实例接收 scope key，引擎会按 session 为 persist key 添加后缀；root
      // 实例不传键。
      instance = record.scope === 'root' ? handle.create() : handle.create(key)
      record.instances.set(key, instance)
    }
    return instance
  }

  /** 在实例轴上绑定或再次引用 handle；跨 scope 冲突已由 core 抛出。 */
  private _acquire(handle: EngineStoreHandle, scope: SlotScope): void {
    const record = this._stores.get(handle)
    if (record === undefined) {
      this._stores.set(handle, { scope, refs: 1, instances: new Map() })
      return
    }
    record.refs += 1
  }

  /** 删除一个引用；最后持有者卸载时删除记录及其实例，引擎 store 无需显式 dispose。 */
  private _release(handle: EngineStoreHandle): void {
    const record = this._stores.get(handle)
    /* v8 ignore next -- 防御性保护：release 只会由注册同一 handle 的 disposer 调用，
     * 因此记录必然存在；保留检查可防止未来调用点使实例轴下溢。 */
    if (record === undefined) return
    record.refs -= 1
    if (record.refs === 0) this._stores.delete(handle)
  }
}

// register 的实现：prototype 赋值与类内 `declare` 配对。它必须位于 prototype 的原因
// 见对应 JSDoc。元素访问可合法调用私有 _register，并让 TypeScript 将其视为可见读取。
;(SlotRegistry.prototype as { register: (options: object, component: unknown) => () => void }).register
  = function register(this: SlotRegistry, rawOptions: object, component: unknown): () => void {
    // core 重载已验证共享类型；实现使用擦除视图，与 core 自身实现分支采用同一模式。
    const options = rawOptions as ErasedRegisterOptions
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(() => this['_register'](options, component), 'slots.register()')
  }
