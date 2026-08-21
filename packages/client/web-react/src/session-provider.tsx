/** 渲染器宿主与当前会话 provide bundle 的内部 React 绑定。 */
import { createContext, useContext, type ReactNode } from 'react'
import type {
  HostObservable, MaybeSnapshotSelectorHook, SessionMaybeProvideInfo, SessionProvideInfo,
  SlotRendererHost, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from './bind.ts'

/**
 * 提供方缺失的装配错误，表示 shell 对树的接线有误。slot 错误边界会重新抛出此类，
 * 让错误装配保持明确失败；注册方错误（inject 工厂、配置项组件）则按配置项隔离。
 */
export class SlotAssemblyError extends Error {}

/** 包内渲染器宿主上下文。 */
export const HostContext = createContext<SlotRendererHost | null>(null)

/**
 * 读取已安装的渲染器宿主。在已渲染根树之外调用会抛错，因为框架组件不得脱离渲染器
 * 单独渲染。
 * @returns 宿主 API。
 */
export function useHost(): SlotRendererHost {
  const host = useContext(HostContext)
  if (!host) throw new SlotAssemblyError('slot machinery rendered outside the installed renderer tree')
  return host
}

const BindingContext = createContext<SessionMaybeProvideInfo | null>(null)

/** 读取根部提供的当前会话可选 bundle。 */
export function useSessionMaybeProvideInfo(): SessionMaybeProvideInfo {
  const info = useContext(BindingContext)
  if (!info) throw new SlotAssemblyError('session-aware slot rendered outside the root binding provider')
  return info
}

/**
 * 读取外层会话 provide bundle。在 SessionProvider 子树之外调用会抛错，因为会话 slot
 * 不得在没有会话时渲染。
 * @returns 外层 bundle。
 */
export function useSessionProvideInfo(): SessionProvideInfo {
  const info = useSessionMaybeProvideInfo()
  if (info.sessionId === undefined) throw new SlotAssemblyError('strict session slot rendered without a session')
  return info as SessionProvideInfo
}

/**
 * 每个宿主 observable 对应一个标识稳定的选择器钩子。subscribe 引用变化时 uSES 会
 * 重新订阅，因此每个数据源只能创建一次绑定钩子；这里按数据源标识缓存，而数据源是
 * 宿主所有的单例。
 * @param source - 宿主提供的 observable。
 * @returns 缓存的选择器钩子。
 */
export function observableHook<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  let hook = hookCache.get(source)
  if (hook === undefined) {
    hook = bindSnapshotSelector(source)
    hookCache.set(source, hook)
  }
  return hook as SnapshotSelectorHook<T>
}
const hookCache = new WeakMap<object, unknown>()

const absentSource: HostObservable<undefined> = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
}

/** 把会随当前会话消失的数据源绑定为可选选择器钩子。 */
export function maybeObservableHook<T>(source: HostObservable<T> | undefined): MaybeSnapshotSelectorHook<T> {
  if (source !== undefined) return observableHook(source)
  return useAbsentSnapshot
}

function useAbsentSnapshot<S>(_selector: (snapshot: never) => S, _equal?: (a: S, b: S) => boolean): S | undefined {
  // 为保持钩子顺序稳定，仍必须运行 uSES 订阅；缺失数据源始终产生 undefined 快照，
  // 并在此显式返回。
  observableHook(absentSource)(() => undefined)
  return undefined
}

/**
 * useProjection 框架 seat，参见 docs/subsystems/session-projection.md。每个
 * provide bundle 对应一个绑定函数，按 info 标识缓存，组件可跨渲染持有。它按键寻址：
 * 键从投影存储解析每会话值接口；绑定后的选择器钩子与其他工具包钩子共用按数据源
 * 缓存，因此每次调用恰好运行一个 uSES 订阅，且每个键的 subscribe 引用保持稳定。
 * 尚未由基线或帧携带的键以及无会话 bundle 都读取为 `undefined`，表示能力缺失，
 * 同时保持钩子顺序不变。
 */
export function projectionHook(info: SessionMaybeProvideInfo): (
  key: string, selector?: (value: unknown) => unknown, eq?: (a: unknown, b: unknown) => boolean,
) => unknown {
  let hook = projectionHookCache.get(info)
  if (hook === undefined) {
    hook = (key, selector, eq) => {
      // 无会话（无接口）分支绑定共享缺失数据源，使调用方选择器仍针对 `undefined`
      // 运行，让缺失状态穿过选择器，并保持 uSES 调用次数不变。
      const useValue = observableHook(info.projections?.faceOf(key) ?? absentSource)
      // 完整值是已完成的协议载荷，仅在帧或基线到达时改变引用，因此标识选择器不需要
      // 相等性函数。
      return useValue(selector ?? (value => value), eq)
    }
    projectionHookCache.set(info, hook)
  }
  return hook
}
const projectionHookCache = new WeakMap<SessionMaybeProvideInfo, (
  key: string, selector?: (value: unknown) => unknown, eq?: (a: unknown, b: unknown) => boolean,
) => unknown>()

/**
 * 根级绑定提供方。它不使用 key 而跟随当前选择；每配置项标识由 outlet 的接管记录
 * SessionMaybeEntry 管理：从空白创建的 incarnation 不重新挂载即可接管首个会话，
 * 后续每次切换或丢失都像严格配置项一样重新挂载。
 */
export function SessionMaybeProvider({ children }: { children: ReactNode }) {
  const host = useHost()
  const info = observableHook(host.sessions.provideInfo)(s => s)
  return (
    <BindingContext.Provider value={info}>
      {children}
    </BindingContext.Provider>
  )
}

/** SessionProvider API：render prop 内容和无会话分支。 */
export interface SessionProviderProps {
  /** 无会话内容；也覆盖当前 id 无法解析到会话的情况。 */
  empty?: (() => ReactNode) | undefined
  /** 会话内容；通过 key={sessionId} 按会话重新挂载。 */
  children: (sessionId: string) => ReactNode
}

/**
 * 由框架接线的会话区域：订阅宿主的当前 provide 数据源，并在
 * `key={sessionId}` 下重新挂载内容，使切换会话时重建会话子树。该依赖反转层使用
 * 普通字符串 id；`PropsRuntime` 在组件边界应用品牌类型。
 */
export function SessionProvider({ empty, children }: SessionProviderProps) {
  const host = useHost()
  const info = observableHook(host.sessions.provideInfo)(s => s)
  const id = info.sessionId
  if (id === undefined) return <>{empty?.() ?? null}</>
  return (
    <BindingContext.Provider value={info} key={id}>
      {children(id)}
    </BindingContext.Provider>
  )
}
