/** slot Host 与已安装 renderer 之间不依赖 React 的约定。 */
import type { ReactNode } from 'react'
import type { SlotEntryDef, SlotSpec, StoredEntry, Translate } from './index.ts'

/**
 * 渲染基础设施消费的 locale 接口：包含命名空间绑定和可观察 revision，即
 * getSnapshot/subscribe 对，与其他标准工具包数据源使用相同 HostObservable 形式。
 * 当前 locale 或注册表每次变化都会推进 revision；renderer 依据“命名空间、revision”
 * 重新推导各配置项的 `t`，因此切换 locale 会产生新的函数引用，让记忆化组件自然
 * 重渲染。接口由 locale 插件实现，并通过 runtime SlotRegistry 的 installLocale
 * 安装。
 *
 * 必须在首次需要该 seat 的渲染前安装。outlet 在挂载时绑定 revision 订阅，较晚出现的
 * 接口没有通道通知已经挂载的 outlet。locale 插件属于 immediately 层基础设施，正常
 * 组合会在启动期间完成安装。
 */
export interface LocaleFace extends HostObservable<{ revision: number }> {
  /**
   * 把命名空间绑定到调用时读取当前 locale 的翻译函数。函数标识可以在每个命名空间内
   * 保持稳定；渲染文案的新鲜度由 renderer 的“ns、revision”seat 推导保证，而不是
   * 本绑定。
   * @param ns - 字典命名空间。
   * @returns 绑定该命名空间的翻译函数。
   */
  bind(ns: string): Translate
}

/** Host 提供的标准工具包数据源所需的最小可观察 API。 */
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/**
 * 渲染边界上类型擦除的 store 实例接口，类型化对应项为 {@link StoreInstance}：包含裸
 * 快照数据源和已移除 draft 参数的 action 回调。React hook 不会跨越该边界；渲染
 * 基础设施在自身一侧从数据源绑定 `useStore` 并按实例缓存；类型通过
 * {@link PropsStore} 落在组件边界。
 */
export interface StoreInstanceLike {
  getSnapshot(): unknown
  /**
   * 订阅状态变化，即 uSES 的 subscribe 侧。
   * @param fn - 变更回调。
   * @returns 取消订阅函数。
   */
  subscribe(fn: () => void): () => void
  readonly actions: Record<string, (...params: never[]) => void>
}

/**
 * 按 session id 解析的每 session 标准属性。在同一 session scope 内标识稳定；重建
 * scope 会产生新的 info。插件通过 runtime `sessions.provide` 约定贡献成员；渲染侧把
 * 每个 `hooks` 数据源绑定为 `use<Name>` selector hook，hook 本身不会出现在 Host
 * 约定中，并原样展开 `props`。runtime 自身提供第一项：`session` → `useSession`。
 */
export interface SessionMaybeProvideInfo {
  /** 当前 session id；应用处于无 session 模式时不存在。 */
  sessionId: string | undefined
  /**
   * 静态 hook 名单。没有 session 时每个值都不存在，但键继续保留，使 session-maybe
   * 配置项始终接收相同 hook 结构的标准工具包。
   */
  hooks: Record<string, HostObservable<unknown> | undefined>
  /** 静态普通成员名单；没有 session 时值为 undefined。 */
  props: Record<string, unknown>
  /**
   * 按键寻址的投影值数据源，即 useProjection 框架 seat；参见
   * docs/subsystems/session-projection.md。与 `hooks` 不同，其键空间开放，值来自
   * Host 计算的推送帧，因此渲染侧按已解析键而不是静态名单成员绑定。每个键始终具有
   * 接口，缺失用 `undefined` 快照表示；没有 session 时整个成员不存在。
   */
  projections?: { faceOf(key: string): HostObservable<unknown> } | undefined
}

/** 为严格 session slot 解析的确定每 session 标准属性。 */
export interface SessionProvideInfo extends SessionMaybeProvideInfo {
  sessionId: string
  /** 按 hook 基础名称索引的裸可观察数据源，例如 `session` → useSession。 */
  hooks: Record<string, HostObservable<unknown>>
}

/** 基础设施层的 renderSlot 分发选项。 */
export interface RenderOpts {
  entryKey?: string
  only?: string
  fallback?: ReactNode
  /** 仅由函数值注入 Hook 消费的单次调用不透明上下文。 */
  hookContext?: unknown
}

/** runtime SlotRegistry 提供给已安装 renderer 的 Host API。 */
export interface SlotRendererHost {
  /**
   * 订阅某键的注册变更，通知按微任务批处理。
   * @param key - slot 键。
   * @param fn - 变更回调。
   * @returns 取消订阅函数。
   */
  subscribe(key: string, fn: () => void): () => void
  /**
   * 用于 uSES 配对的单调 version。
   * @param key - slot 键。
   * @returns 当前 version。
   */
  getVersion(key: string): number
  /**
   * 获取某键注册项的快照；变更之间引用保持稳定。
   * @param key - slot 键。
   * @returns 按注册顺序排列的配置项；list 按 order 排列。
   */
  entriesOf(key: string): readonly StoredEntry[]
  /**
   * 某键每个单元格的遮蔽胜出项，也是 single、keyed、list 分发的渲染读取：按优先级
   * 取每格首个实时且未退出的配置项。chain 键原样透传，因为选举会消费全部配置项。
   * 每次调用返回新数组，用于渲染体读取，不能作为 uSES getSnapshot 数据源。
   * @param key - slot 键。
   * @returns 每个已占用单元格的胜出配置项。
   */
  entriesOfSlot(key: string): readonly StoredEntry[]
  /**
   * 报告配置项边界崩溃。对于支持遮蔽的 kind，`info.abdicate` 会把配置项一次性移出
   * 单元格，使下一个存活项渲染；chain 崩溃只报告而不退出。两种情况下注册都继续
   * 留在 ledger 上。
   * @param key - 配置项所在的 slot 键。
   * @param entry - 崩溃的配置项。
   * @param error - 崩溃原因。
   * @param info - `abdicate` 表示是否将配置项移出单元格。
   */
  reportEntryError(key: string, entry: StoredEntry, error: unknown, info: { abdicate: boolean }): void
  /**
   * 从声明 ledger 读取运行时规格。
   * @param key - slot 键。
   * @returns 规格；键未声明时返回 undefined，outlet 渲染为空。
   */
  specOf(key: string): SlotSpec<SlotEntryDef> | undefined
  /**
   * 陈旧授权检查：配置项是否仍在 ledger 中。
   * @param entry - 先前渲染过的配置项。
   * @returns 配置项注册被 dispose 后返回 false。
   */
  isLive(entry: StoredEntry): boolean
  /**
   * 在 scope 键下解析配置项已声明 handle 的 store 实例，必要时创建，否则返回缓存。
   * 生命周期沿 ledger 轴管理。
   * @param entry - 声明中携带 handle 的配置项。
   * @param scopeKey - session scope slot 使用 session id；root scope 使用 undefined。
   * @returns store 实例；配置项未声明 store 时返回 undefined。
   */
  storeOf(entry: StoredEntry, scopeKey: string | undefined): StoreInstanceLike | undefined
  /** Session 侧标准工具包数据源。 */
  sessions: {
    /** 支撑 useSessions 标准 hook 的 session 列表数据源。 */
    list: HostObservable<unknown>
    /**
     * SessionProvider 使用的原子当前 session provide 投影。选择变化与 provider 名单
     * 变化均通过同一数据源发布，因此即使当前 id 稳定，也不会让已挂载配置项停留在
     * 陈旧 hook/prop schema 上。无法解析当前 session 时仍携带静态名单，但
     * sessionId 为 undefined。
     */
    provideInfo: HostObservable<SessionMaybeProvideInfo>
  }
  /** Workspace 侧标准工具包数据源。 */
  workspaces: {
    /** 支撑 useWorkspaces 标准 hook 的 Workspace 列表数据源。 */
    list: HostObservable<unknown>
  }
  /**
   * 支撑 `t` 标准 seat 的已安装 locale 接口。locale 插件安装前不存在；缺少接口时
   * 渲染声明了 `locale:` 的配置项属于装配失败。
   */
  locale?: LocaleFace | undefined
}

/** 安装约定：runtime 拥有 install()/renderSlot()，ui-renderer 实现渲染。 */
export interface SlotRenderer {
  /**
   * 基于 Host API 渲染 root slot 树，也是唯一的 ctx 级入口。
   * @param host - 安装服务的 Host API。
   * @param ownerProps - shell 调用 renderSlot('root', ...) 时传入的 owner props。
   * @returns 渲染后的树。
   */
  renderRoot(host: SlotRendererHost, ownerProps: object): ReactNode
}

/** 保留的 renderSlot 绑定在声明它的配置项已 dispose 后仍被调用时抛出。 */
export class StaleAuthorizationError extends Error {}

/**
 * renderSlot 绑定收到配置项 children 声明之外的键时抛出。这是普通 JavaScript 的
 * 后备保护；类型化调用方已经静态收窄。
 */
export class SlotOwnershipError extends Error {}
