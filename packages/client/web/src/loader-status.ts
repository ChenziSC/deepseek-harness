/**
 * 不依赖框架的启动页所用 fiber 状态投影词汇。启动链订阅 `internal/status`，并投影
 * 所属 Loader 条目的当前状态。
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
