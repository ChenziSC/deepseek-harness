// Notifier 是 Session 与 SessionManager 共用的订阅和批量通知基元。N 次 markDirty 调用
// 合并为一次微任务刷新，N 次 markFrameDirty 调用合并为一次动画帧刷新。刷新会先重建
// 快照缓存再通知，因为 useSyncExternalStore 要求 getSnapshot 引用稳定。没有监听器时
// 跳过重建，只设置 dirty 标记，以降低帧风暴成本；下次 getSnapshot 再延迟重建。
//
// 新鲜度与通知是两个独立标记：若在 markDirty 与计划刷新之间调用 ensureFresh 拉取，
// 会重建快照，但不能吞掉通知；否则任何读取方率先拉取时，推送订阅者（对象层 watcher）
// 都会收不到通知。

/** Session 与 SessionManager 共用的订阅和批量通知基元。 */
export class Notifier {
  private listeners = new Set<() => void>()
  private dirty = false
  private notifyPending = false
  private scheduled: 'none' | 'microtask' | 'frame' = 'none'
  private scheduleGeneration = 0

  /** @param rebuild - 所有者注入的快照重建函数；写入其 snapshotCache。 */
  constructor(private readonly rebuild: () => void) {}

  /**
   * uSES 订阅入口。
   * @param listener - 变化回调。
   * @returns 取消订阅函数。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 状态变化入口：标为 dirty 并计划批量刷新。 */
  markDirty(): void {
    this.dirty = true
    this.notifyPending = true
    if (this.scheduled === 'microtask') return
    this.schedule('microtask')
  }

  /** 流变化入口：标为 dirty，并且每帧最多发布一次累计状态。 */
  markFrameDirty(): void {
    this.dirty = true
    this.notifyPending = true
    if (this.scheduled !== 'none') return
    this.schedule(typeof globalThis.requestAnimationFrame === 'function' ? 'frame' : 'microtask')
  }

  /**
   * 同步刷新：受控输入写入必须与 onChange 在同一 tick 通知，否则 React 会把 DOM
   * 回滚到旧值，光标也会跳到末尾。
   */
  notifyNow(): void {
    this.dirty = true
    this.notifyPending = true
    this.invalidateSchedule()
    this.flush()
  }

  /**
   * getSnapshot 前检查：dirty 时同步重建，用于首次订阅前或无人观察时的读取路径；
   * 通知仍保持等待状态。
   */
  ensureFresh(): void {
    if (!this.dirty) return
    this.dirty = false
    this.rebuild()
  }

  private schedule(kind: 'microtask' | 'frame'): void {
    const generation = ++this.scheduleGeneration
    this.scheduled = kind
    const publish = () => {
      if (generation !== this.scheduleGeneration) return
      this.scheduled = 'none'
      this.flush()
    }
    if (kind === 'frame') {
      globalThis.requestAnimationFrame(publish)
    } else {
      queueMicrotask(publish)
    }
  }

  private invalidateSchedule(): void {
    this.scheduleGeneration++
    this.scheduled = 'none'
  }

  private flush(): void {
    if (!this.notifyPending) return
    if (this.listeners.size === 0) return // 延迟处理：dirty 仍存在时，下次 getSnapshot 重建。
    this.notifyPending = false
    if (this.dirty) {
      this.dirty = false
      this.rebuild()
    }
    for (const listener of this.listeners) listener()
  }
}
