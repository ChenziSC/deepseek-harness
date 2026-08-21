/**
 * 快照 store 引擎（zustand vanilla + immer + subscribeWithSelector + rafFlush
 * 中间件 + 可选持久化 + 开发环境冻结）及其声明式外壳。{@link defineStore} 把
 * init/persist/actions 字面量固化为 {@link StoreHandle}，作为 slot 终端注册侧的 store
 * 席位。本模块位于不依赖 React 的 runtime 中：数据层拥有引擎，ui-renderer 只提供
 * React 粘合。引擎产物是仅含 subscribe/getSnapshot/update/set 的裸 observable，
 * 不提供 selector hook；hook 由 ui-renderer 在绑定处通过单一 uSES 桥生成并按源缓存。
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'
import { shallow } from 'zustand/shallow'
import { produce } from 'immer'
import type {
  ActionsDecl, BakedActions, StoreHandle, StoreInstance, StoreSpec,
} from '@deepseek-ai/dsh-client-ui-slots'

// Store 接口类型以 ui-slots 为权威来源；这里在引擎旁重新导出，使消费者只需一条
// 导入路径。
export type {
  ActionsDecl, BakedActions, BoundActions, StoreFactory, StoreHandle, StoreInstance, StoreSpec,
} from '@deepseek-ai/dsh-client-ui-slots'

/** 最小可观察快照源；Session 对象和快照 store 都满足此接口。 */
export interface ObservableSnapshot<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }

/** 可写快照 store；这里只暴露裸数据接口，React selector hook 由 ui-renderer 生成。 */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  /**
   * 通过 immer draft 修改状态。
   * @param mutator - draft 修改函数。
   */
  update(mutator: (draft: T) => void): void
  /**
   * 整体替换状态。
   * @param next - 下一状态。
   */
  set(next: T): void
}

/**
 * selector 切片的浅比较，语义与 zustand/shallow 一致。该能力随引擎提供，因此 hook
 * 消费者不需要直接依赖 zustand。
 * @param a - 左值。
 * @param b - 右值。
 * @returns 两个值是否浅层相等。
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  return shallow(a, b)
}

/** 将订阅者通知合并为每个动画帧一次刷新。 */
function rafBatch(notify: () => void): () => void {
  // 没有 rAF 时（如 Node 单元测试）回退为微任务批处理；两者都保证同一 tick 内
  // N 次变更只通知一次。
  const schedule: (fn: () => void) => void =
    typeof requestAnimationFrame === 'function'
      ? (fn) => { requestAnimationFrame(() => { fn() }) }
      : (fn) => { queueMicrotask(fn) }
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    schedule(() => {
      scheduled = false
      notify()
    })
  }
}

/**
 * 创建快照 store。
 *
 * 默认刷新模式为 'sync'，因为受控输入需要在同一 tick 回显。按帧驱动的 store 可选择
 * 'raf'，将一帧内的更新合并为一次通知。raf 模式的已知取舍是：帧中途挂载的组件会
 * 读到最新状态，既有订阅者则要到下次刷新才收到通知，因而短暂出现帧级偏差；其性质
 * 与对象层的微任务批处理相同。
 *
 * @param init - 初始状态。
 * @param opts - 刷新模式和可选持久化；持久化使用 localStorage，以 name 为键。
 * @returns 创建的 store。
 */
export function createSnapshotStore<T>(
  init: T, opts?: { flush?: 'raf' | 'sync'; persist?: { name: string } }): SnapshotStore<T> {
  // Immer 通过下方 update() 中的 produce() 接入；语义与 immer 中间件相同，但不带
  // 其 setState 签名的修改函数泛型。
  const withSelector = subscribeWithSelector(() => init)
  const api: StoreApi<T> = createStore<T>()(withSelector)
  if (opts?.persist) attachPersistence(api, opts.persist.name)

  let subscribe = (fn: () => void) => api.subscribe(fn)
  if (opts?.flush === 'raf') {
    const listeners = new Set<() => void>()
    const flush = rafBatch(() => { for (const fn of [...listeners]) fn() })
    api.subscribe(flush)
    subscribe = (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }
  }

  return {
    getSnapshot: () => api.getState(),
    subscribe: fn => subscribe(fn),
    update: (mutator) => {
      // 使用 Immer produce 而非 setState 的部分合并路径，使标量和数组根节点也能
      // 正确替换；produce 在开发环境还会冻结结果。
      api.setState(produce(api.getState(), (draft) => { mutator(draft as T) }), true)
    },
    set: (next) => {
      api.setState(devFreeze(next), true)
    },
  }
}

/**
 * 将完整值以 JSON 持久化到 localStorage。这里没有使用 zustand persist 中间件，
 * 因为其写入路径会把状态展开为对象（`partialize({ ...get() })`），导致原始值状态被
 * 拆散，例如字符串草稿会变成 {0:'h',1:'e',...}。损坏发生在序列化前，无法通过
 * merge/deserialize 选项修复。存储失败（容量限制、隐私模式）只会禁用持久化，
 * 不会破坏 store。
 */
function attachPersistence<T>(api: StoreApi<T>, name: string): void {
  // 非浏览器运行环境（如由 Node e2e 启动客户端树）没有 localStorage，因此静默禁用
  // 持久化；语义与存储失败相同，但避免每个 store 都因 ReferenceError 输出日志。
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(name)
    if (raw !== null) {
      api.setState(devFreeze(JSON.parse(raw) as T), true)
    }
  } catch (error) {
    console.error(`snapshot store '${name}' rehydration failed:`, error)
  }
  api.subscribe((state) => {
    try {
      localStorage.setItem(name, JSON.stringify(state))
    } catch (error) {
      console.error(`snapshot store '${name}' persistence failed:`, error)
    }
  })
}

/** 非生产环境中深度冻结整体 set 的状态，因为 set() 绕过了 immer 的冻结。 */
function devFreeze<T>(value: T): T {
  if (process.env.NODE_ENV === 'production') return value
  deepFreeze(value)
  return value
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
}

// ui-slots 拥有接口定义，本模块提供引擎实现。

/** 活跃引擎实例：接口实例加底层引擎 store。 */
export interface EngineStoreInstance<T, A extends ActionsDecl<T>> extends StoreInstance<T, A> {
  /** 底层引擎 store，供框架和测试使用，组件不会接触。 */
  readonly store: SnapshotStore<T>
}

/** 由引擎支撑的 handle；create() 返回类型收窄为引擎实例。 */
export interface EngineStoreHandle<T, A extends ActionsDecl<T>> extends StoreHandle<T, A> {
  /**
   * 构造一个活跃引擎实例。scopeKey/persist 语义见 {@link StoreHandle.create} 的
   * 接口 JSDoc。
   *
   * 已知边界：persist key 就是存储身份，因此同一解析键下创建的多个活跃实例会共享
   * 一个 localStorage 条目并相互污染。调用方负责保证每个键的实例唯一。生产环境中，
   * 框架会按 handle × scope key 缓存一个实例；需要隔离的测试应使用不同 scope key
   * 或不带 persist 的声明。测试中允许多次创建是特性，所以 create() 有意不去重也
   * 不抛错。
   * @param scopeKey - session scope 实例使用的 session ID；根 scope 省略。
   * @returns 引擎实例。
   */
  create(scopeKey?: string): EngineStoreInstance<T, A>
}

/**
 * 声明一个 store：包括初始状态、可选持久化，以及以纯 draft 修改函数表示的完整写
 * 操作集合。返回的 handle 是 store 席位的注册凭据，其身份决定实例共享。该函数满足
 * ui-slots 的 DefineStore 接口，handle/instance 是由引擎扩展的子类型。
 *
 * `A & ActionsDecl<T>` 在 actions 位置不可省略：第一轮推断先从 `init` 得到 T，随后
 * 交叉类型为每个修改函数的 draft 参数提供上下文类型；上下文敏感函数会延迟推断。
 * 因此调用处可直接写 `(d, x: X) => { ... }`，无需标注 draft 类型。若未来 TypeScript
 * 版本破坏这种单字面量推断，既定回退方案是柯里化：
 * `defineStore(init).actions({...})`。
 * @param decl - init 函数（每实例创建新状态）、可选 persist key 和 actions 表。
 * @returns store handle。
 */
export function defineStore<T, A extends ActionsDecl<T>>(
  decl: StoreSpec<T, A> & { actions: A & ActionsDecl<T> }): EngineStoreHandle<T, A> {
  return {
    spec: decl,
    create(scopeKey?: string): EngineStoreInstance<T, A> {
      const persistKey = decl.persist === undefined
        ? undefined
        : scopeKey === undefined ? decl.persist : `${decl.persist}.${scopeKey}`
      const store = createSnapshotStore<T>(
        decl.init(),
        persistKey !== undefined ? { persist: { name: persistKey } } : undefined)
      const actions = {} as Record<string, (...params: unknown[]) => void>
      for (const key of Object.keys(decl.actions)) {
        const mutate = decl.actions[key] as (draft: T, ...params: unknown[]) => void
        actions[key] = (...params: unknown[]) => { store.update((draft) => { mutate(draft, ...params) }) }
      }
      return {
        actions: actions as BakedActions<T, A>,
        getSnapshot: () => store.getSnapshot(),
        subscribe: fn => store.subscribe(fn),
        store,
        clearPersisted: () => {
          if (persistKey === undefined || typeof localStorage === 'undefined') return
          try {
            localStorage.removeItem(persistKey)
          } catch {
            // 存储失败（隐私模式、容量清理竞态）只会跳过清理，与 attachPersistence
            // 一样属于非致命情况。
          }
        },
      }
    },
  }
}
