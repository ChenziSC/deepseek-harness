/**
 * 通用的每 session 投影值 store，采用推送模型，详见
 * docs/subsystems/session-projection.md。Host 是唯一计算位置；客户端只按键保存完成的
 * 整体值：`key → { value, seq }`。历史尾页的 projections block 提供初始值，随后由
 * `session/projection` 推送帧更新，唯一规则是“较大 seq 胜出”。客户端不进行业务折叠，
 * 因而业务域无需客户端代码即可提供投影能力。按键的裸 observable 接口供
 * `useProjection` 使用，由 web-react 绑定。
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { ObservableSnapshot } from '../contract/store.ts'
import { Notifier } from './notifier.ts'

// 唯一投影类型表贯穿 Host 单元、传输 block、客户端 store 和 React hook。这里必须使用
// Service Definition 包的纯类型出口 `/types`（零导入），不能使用包根入口；包根的
// dsh-agent → dsh-session 链会把 Host `Context.sessions` 合并带入客户端程序，而同一
// 程序不能同时持有两端。客户端不再维护第二份 "views" 表；相关备选方案已在架构
// 说明中否决。
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

/**
 * 框架第五个 hook 席位，详见 docs/subsystems/session-projection.md：通过标准工具组
 * 提供、按键寻址的投影读取器。`undefined` 统一表示能力不存在，即 Host 单元未挂载，
 * 或尚无基线/帧携带该键。selector 重载与 useSession 对应，按键绑定 uSES；只有帧或
 * 基线到达时键值引用才变化，因此引用保持稳定。
 */
export type UseProjection = {
  <K extends Extract<keyof SessionProjectionMap, string>>(key: K): SessionProjectionMap[K] | undefined
  <K extends Extract<keyof SessionProjectionMap, string>, S>(
    key: K,
    selector: (value: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

/**
 * 尾页 projections 基线，结构与传输层 `SessionProjectionsBlock`（apiproxy API 层）
 * 相同。这里重新声明，使不依赖 React 的 store 只依赖类型表，而不依赖传输包的响应
 * 词汇。
 */
export interface ProjectionsBaseline {
  /** 一致性切点 seq；按构造等于窗口尾 seq。 */
  asOfSeq: number
  /** 按键保存的当前完整值；已注册键未出现表示能力不存在。 */
  values: Partial<SessionProjectionMap>
}

/** 一个键的行：最新完成值及其保持一致的 seq。 */
interface Row {
  value: unknown
  seq: number
}

/** 每键通知通道：裸接口及其批量 notifier。 */
interface Channel {
  face: ObservableSnapshot<unknown>
  notifier: Notifier
}

/**
 * 一个 session 的投影值。框架对所有键采用统一语义：基线在其切点填充行，推送帧更新
 * 一行；两条路径中都由较大 seq 胜出。重放帧不能让值倒退，旧基线不能覆盖较新帧。
 * store 从未见过的键读取为 `undefined`，表示能力不存在。每键接口按需创建并缓存，
 * 身份稳定，使 React 侧只绑定一次；store 级通道 `subscribeAny` 服务粗粒度消费者，
 * 如 manager 的列表投影会读取 `title` 键。
 */
export class ProjectionValueStore {
  private readonly rows = new Map<string, Row>()
  private readonly channels = new Map<string, Channel>()
  private valuesCache: Readonly<Partial<SessionProjectionMap>> | undefined
  /** 任意键变化的粗粒度通道；读取直接访问行，无快照缓存需要重建。 */
  private readonly anyNotifier = new Notifier(() => {})

  /**
   * 按键寻址的裸 observable 接口，即 useProjection 解析路径。接口始终存在；值缺失
   * 表现为 `undefined` 快照，而非接口缺失，因此组件可在该键首次有值前订阅。
   * @param key - 投影键。
   * @returns 该键身份稳定的接口。
   */
  faceOf(key: string): ObservableSnapshot<unknown> {
    return this.channel(key).face
  }

  /**
   * 某键的当前完整值。框架读取会擦除类型；类型化读取通过 `useProjection` 映射查询。
   * @param key - 投影键。
   * @returns 当前值；键不存在时返回 undefined。
   */
  get(key: string): unknown {
    return this.rows.get(key)?.value
  }

  /**
   * 将所有当前投影值读取为一份引用稳定快照。
   * @returns 某行变化前始终返回同一个冻结值映射。
   */
  values(): Readonly<Partial<SessionProjectionMap>> {
    if (this.valuesCache === undefined) {
      this.valuesCache = Object.freeze(Object.fromEntries(
        [...this.rows].map(([key, row]) => [key, row.value]),
      ))
    }
    return this.valuesCache
  }

  /**
   * 订阅任意键变化，通知按微任务合并；这是 manager 重建列表的通道。
   * @param listener - 变化回调。
   * @returns 取消订阅函数。
   */
  subscribeAny(listener: () => void): () => void {
    return this.anyNotifier.subscribe(listener)
  }

  /**
   * 应用一个完成值，即 `session/projection` 推送帧路径。
   * @param key - 投影键。
   * @param value - Host 单元计算的完整值。
   * @param seq - 单元发出值时的水位。
   */
  apply(key: string, value: unknown, seq: number): void {
    const row = this.rows.get(key)
    if (row !== undefined && seq <= row.seq) return // 较大 seq 胜出；丢弃重放和旧帧。
    this.rows.set(key, { value, seq })
    this.changed(key)
  }

  /**
   * 从历史尾页 projections block 填充初始值。所有携带键都遵循与帧相同的 seq 规则；
   * block 省略的键在切点处视为能力不存在，除非已有较新帧超过切点，否则清除其行。
   * 因此旧基线既不能覆盖也不能清除较新值。
   * @param baseline - 响应中的 projections block。
   */
  seed(baseline: ProjectionsBaseline): void {
    // 擦除类型后遍历：框架跨越开放键空间；消费者通过 useProjection 映射查询重新
    // 建立逐键类型。
    const values = baseline.values as Record<string, unknown>
    for (const key of Object.keys(values)) this.apply(key, values[key], baseline.asOfSeq)
    for (const [key, row] of this.rows) {
      if (Object.hasOwn(values, key)) continue
      if (row.seq > baseline.asOfSeq) continue
      this.rows.delete(key)
      this.changed(key)
    }
  }

  /**
   * 丢弃超过 mux 代次基线（`session/subscribed.lastSeq`）的行。声称掌握超过 Host 自身
   * 持久基线信息的行携带的是重启已丢失状态；若保留，在 last-wins 规则下会永久错误
   * 压过 Host 重新计算但 seq 更低的值。持久重放和下一份基线会重新填充真正存活的值，
   * 这是 title-snapshot 先例的通用化。
   * @param lastSeq - subscribed 帧的持久基线 seq。
   */
  truncate(lastSeq: number): void {
    for (const [key, row] of this.rows) {
      if (row.seq <= lastSeq) continue
      this.rows.delete(key)
      this.changed(key)
    }
  }

  private changed(key: string): void {
    this.valuesCache = undefined
    this.channels.get(key)?.notifier.markDirty()
    this.anyNotifier.markDirty()
  }

  private channel(key: string): Channel {
    let channel = this.channels.get(key)
    if (channel === undefined) {
      // notifier 只负责合并通知；接口直接读取行，无快照缓存需要重建。
      const notifier = new Notifier(() => {})
      channel = {
        notifier,
        face: {
          getSnapshot: () => this.rows.get(key)?.value,
          subscribe: listener => notifier.subscribe(listener),
        },
      }
      this.channels.set(key, channel)
    }
    return channel
  }
}
