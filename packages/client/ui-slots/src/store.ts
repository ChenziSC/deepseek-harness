/** slot 注册与运行时引擎之间不依赖框架的存储约定。 */

/**
 * 基于快照数据源的类型化选择器钩子，是整个 slot 系统的规范形式。web-react 引擎
 * 钩子在结构上与之相同；只有框架会创建此类钩子。
 */
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S

/**
 * 基于跟随当前会话的数据源的选择器钩子。钩子始终存在；没有当前会话时，选择结果
 * 不存在。这样可在无会话与有会话之间保持钩子调用位置稳定，又不会虚构会话快照。
 */
export type MaybeSnapshotSelectorHook<T> =
  <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S | undefined

/**
 * action 声明表：针对存储状态的纯 immer draft 转换，也是存储完整写入集合和审计接口；
 * 组件只能通过这些 action 写入。
 */
/* oxlint-disable-next-line typescript/no-explicit-any --
 * 必须使用 any[] 而非 unknown[]。每个 action 都有自身参数列表；严格参数逆变下，
 * unknown[] 会拒绝所有具体签名。BakedActions 会按 action 重新推导参数。 */
export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>

/**
 * actions 表移除 draft 后的回调形式，也是组件的 `props.actions` 和 inject 工厂
 * 接收的内容。框架把每个 action 绑定到已解析实例，从而烘焙掉 draft 参数。
 */
export type BakedActions<T, A extends ActionsDecl<T>> = {
  [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
}

/**
 * 存储声明规格：初始状态工厂（使用 lambda 让每个实例取得新状态）、可选持久化键
 * （由框架机械执行）和 actions 写入集合。
 */
export interface StoreSpec<T, A extends ActionsDecl<T>> {
  init: () => T
  persist?: string
  actions: A
}

/**
 * 实时引擎实例，即渲染基础设施和测试消费的 create() 产物。它由裸快照数据源与烘焙后
 * 写入集合组成；React 钩子不会附着在引擎产物上，因为引擎位于不依赖 React 的
 * runtime。渲染基础设施在自身一侧从该数据源绑定 `useStore`，并按实例缓存。生产
 * 组件和渲染路径不自行调用 create()，实例生命周期归框架所有。
 */
export interface StoreInstance<T, A extends ActionsDecl<T>> {
  readonly actions: BakedActions<T, A>
  getSnapshot(): T
  /**
   * 订阅状态变化，即 uSES 的 subscribe 侧。
   * @param fn - 变更回调。
   * @returns 取消订阅函数。
   */
  subscribe(fn: () => void): () => void
  /**
   * 删除本实例的持久化值；非持久化规格为空操作。所有作用域彻底结束时由框架调用，
   * 被清理的会话不得留下遗留存储键。
   */
  clearPersisted(): void
}

/**
 * 存储句柄把规格、状态与 actions 类型、共享标识和实例工厂放在同一个值中。句柄可在
 * apply 环境创建并由同一插件的多个注册共享，也可由框架通过注册方工厂创建为独占实例。
 * 不得在模块级导出句柄；模块缓存标识会形成跨插件重载的隐式单例。
 */
export interface StoreHandle<T, A extends ActionsDecl<T>> {
  readonly spec: StoreSpec<T, A>
  /**
   * 创建实时引擎实例，仅供框架基础设施和测试使用。
   * @param scopeKey - 会话作用域实例使用会话 id，并把它附加到持久化键，使各会话实例
   * 独立持久化；根作用域实例省略。
   * @returns 由 `spec.init()` 播种的新实例。
   */
  create(scopeKey?: string): StoreInstance<T, A>
}

/**
 * 独占存储注册形式：注册方直接传入工厂，框架按“配置项 × 作用域”调用；不存在共享标识。
 */
/* oxlint-disable-next-line typescript/no-explicit-any --
 * 这是接受任意 StoreHandle 实例化的擦除位置；T/A 会在各使用位置由条件推导恢复，
 * 具体通过 HandleOf、BoundActions 和 PropsStore。 */
export type StoreFactory = () => StoreHandle<any, any>

/** register 的 `store` 选项位置：共享句柄或独占工厂。 */
// oxlint-disable-next-line typescript/no-explicit-any -- 与上方 StoreFactory 相同的擦除约束位置。
export type StoreDecl = StoreHandle<any, any> | StoreFactory

/** 把存储声明规范化为句柄类型；工厂取其返回类型。 */
export type HandleOf<H> = H extends () => infer R ? R : H

/**
 * 按句柄确定的烘焙 actions：声明了存储的注册项，其 inject 工厂接收的 `actions`
 * 参数；与组件通过 {@link PropsStore} 收到的烘焙回调集合相同。
 */
export type BoundActions<H> = H extends StoreHandle<infer T, infer A> ? BakedActions<T, A> : never

/**
 * 从已声明句柄推导的存储属性部分：类型化选择器钩子加烘焙后写入集合。组件看不到实例
 * 本身，也没有 update/set；读取只能通过 useStore，写入只能通过已声明 actions。
 */
export type PropsStore<H> = H extends StoreHandle<infer T, infer A>
  ? { useStore: SnapshotSelectorHook<T>; actions: BakedActions<T, A> }
  : object

/**
 * defineStore 约定：实现位于 runtime 包并绑定快照存储引擎。输入规格、输出句柄；
 * T 从 `init` 推导，actions 表受 T 约束。
 */
export type DefineStore = <T, A extends ActionsDecl<T>>(spec: StoreSpec<T, A>) => StoreHandle<T, A>
