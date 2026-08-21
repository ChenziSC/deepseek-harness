/**
 * 启动加载页使用的 fiber 状态投影词汇，以及由内核所有的状态存储。AppRoot
 * 渲染的状态直接投影真实 Cordis fiber 状态，不作二次叙述；启动链订阅
 * `internal/status`，并按 loader 配置项重新计算对应行。
 *
 * 此处手写存储是为了满足 shell 自给规则。快照存储基础设施位于 runtime 插件包，
 * 而 shell 内核不得以值导入任何插件包；插件失败时，尤其需要保证加载页仍可工作。
 * @module @deepseek-ai/dsh-client-web/src/loader-status
 */
import type { FiberState } from '@deepseek-ai/cordis'

/**
 * Cordis `FiberState` const enum 的值镜像。const enum 没有可导入的运行时对象，
 * 基于 esbuild 的流水线也不能跨模块内联，因此这里在保留类型的同时镜像固定的
 * vendored 定义；理由与 dsh-tool-cordis 的镜像相同。
 */
export const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** 单个配置项的投影状态标签，即 {@link FiberState} 的小写接口。 */
export type LoaderEntryState = 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading'

/** 按成员索引的各 fiber 状态标签；可安全内联，不依赖反向映射。 */
export const STATE_LABELS: Record<FiberState, LoaderEntryState> = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: 'disposed',
  [FIBER_STATE.UNLOADING]: 'unloading',
}

/** 按配置项名称索引的状态投影，也是 AppRoot 的状态数据源。 */
export type LoaderStatus = Record<string, LoaderEntryState>

/** 内核组件消费的最小可观察快照，遵循 useSyncExternalStore 形式。 */
export interface KernelSignal<T> {
  /** 当前值；两次变更之间引用保持稳定。 */
  getSnapshot: () => T
  /**
   * 订阅变更。
   * @param fn - 变更监听器。
   * @returns 取消订阅的 disposer。
   */
  subscribe: (fn: () => void) => () => void
}

/** 可写的单值信号，用于 settled 标志和启动失败报告。 */
export interface KernelValueSignal<T> extends KernelSignal<T> {
  /**
   * 发布新值并通知订阅方。
   * @param next - 新值。
   */
  set: (next: T) => void
}

/**
 * 创建可写内核信号。
 * @param init - 初始值。
 * @returns 创建的信号。
 */
export function createSignal<T>(init: T): KernelValueSignal<T> {
  let value = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set: (next) => {
      value = next
      for (const fn of [...listeners]) fn()
    },
  }
}

/** 启动状态存储：在 {@link KernelSignal} 接口上提供按配置项排列的行。 */
export interface LoaderStatusStore extends KernelSignal<LoaderStatus> {
  /**
   * 投影一个配置项的状态。采用写时复制，因此 getSnapshot 引用只在写入时变化，
   * 以满足 useSyncExternalStore 约定。
   * @param id - 配置项名称。
   * @param state - 投影后的 fiber 状态。
   */
  set: (id: string, state: LoaderEntryState) => void
}

/**
 * 创建启动状态存储。
 * @returns 创建的存储；启动链投影行之前为空。
 */
export function createLoaderStatusStore(): LoaderStatusStore {
  let value: LoaderStatus = {}
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set: (id, state) => {
      value = { ...value, [id]: state }
      for (const fn of [...listeners]) fn()
    },
  }
}
