/**
 * uSES 桥：把任意裸可观察快照数据源转换为类型化选择器钩子。这里只进行客户端渲染，
 * 因此不接入服务端快照。这是客户端栈唯一的钩子构造器；引擎和宿主只传递裸数据源，
 * 绑定发生在 React 侧。
 */
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector.js'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * 把裸可观察数据源绑定为类型化 uSES 选择器钩子。每个数据源只捕获一次
 * subscribe/getSnapshot 并形成稳定闭包，同时为方法型数据源重新绑定 `this`，因此
 * 组件不会在多次渲染之间重新订阅。相等性判断默认使用 Object.is。
 * @param w - 快照数据源，例如引擎存储、Session 对象或存储实例。
 * @returns 选择器钩子。
 */
export function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => w.subscribe(fn)
  const getSnapshot = () => w.getSnapshot()
  return function useSelector<S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean): S {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)
  }
}
