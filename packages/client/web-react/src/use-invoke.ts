/**
 * useInvoke：把异步 action 包装为稳定触发器和 pending 标志。pending 使用每个钩子
 * 独立的外部存储并通过 uSES 读取，而非 setState；这样渲染体不产生副作用，invoke
 * 引用也能跨渲染保持稳定，符合幂等钩子规则。
 */
import { useRef, useSyncExternalStore } from 'react'

interface InvokeCell {
  inflight: number
  listeners: Set<() => void>
  fn: () => Promise<unknown>
  invoke: () => void
  subscribe: (fn: () => void) => () => void
  getPending: () => boolean
}

function createCell(fn: () => Promise<unknown>): InvokeCell {
  const cell: InvokeCell = {
    inflight: 0,
    listeners: new Set(),
    fn,
    invoke: () => {
      bump(cell, 1)
      cell.fn().catch((error: unknown) => {
        // 领域错误通过事件回显（会话日志）展示；框架只保证重置 pending 并留下记录。
        console.error('useInvoke action failed:', error)
      }).finally(() => { bump(cell, -1) })
    },
    subscribe: (listener) => {
      cell.listeners.add(listener)
      return () => { cell.listeners.delete(listener) }
    },
    getPending: () => cell.inflight > 0,
  }
  return cell
}

function bump(cell: InvokeCell, delta: number): void {
  const wasPending = cell.inflight > 0
  cell.inflight += delta
  if (wasPending !== cell.inflight > 0) {
    for (const listener of [...cell.listeners]) listener()
  }
}

/**
 * 把异步 action 包装为稳定 invoke 回调和 pending 标志。并发调用会计数，最后一个
 * 进行中的调用结算前 pending 始终为 true；执行时总是调用最新的 `fn`。
 * @param fn - 异步 action。
 * @returns invoke 触发器和 pending 状态。
 */
export function useInvoke(fn: () => Promise<unknown>): [invoke: () => void, pending: boolean] {
  const ref = useRef<InvokeCell | null>(null)
  ref.current ??= createCell(fn)
  const cell = ref.current
  cell.fn = fn
  const pending = useSyncExternalStore(cell.subscribe, cell.getPending)
  return [cell.invoke, pending]
}
