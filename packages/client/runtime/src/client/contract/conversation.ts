import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolEventView } from '@deepseek-ai/dsh-api-remotes/client'

/* oxlint-disable typescript/no-duplicate-type-constituents, typescript/no-redundant-type-constituents --
 * 未扩充的声明合并映射在 Runtime 程序中有意解析为 never；已安装业务包会在消费它的
 * Client 程序中提供具体键。 */

/** 一条原始日志事件及其可选的信封级展示视图。 */
export interface ConversationEventInput {
  readonly event: SessionEvent
  readonly view: ToolEventView | undefined
}

/** 从一条事件提取的 Definition 局部身份和生命周期角色。 */
export interface ConversationMatchResult {
  readonly id: string
  readonly role: 'start' | 'update'
}

/** 针对一个 Turn 发布、可通过声明合并扩展的业务值。 */
export interface ConversationTurnDataMap {}

/** 针对一个 Step 发布、可通过声明合并扩展的业务值。 */
export interface ConversationStepDataMap {}

/** 按键稳定读取各自独立所有的 Location 业务值。 */
export interface ConversationLocationDataStore<DataMap extends object> {
  /**
   * 读取一个业务值，不暴露其他所有者的可变 State。
   * @param key - 通过声明合并得到的业务键。
   * @returns 所属 Context 已发布时的最新不可变值。
   */
  get<Key extends keyof DataMap & string>(key: Key): Readonly<DataMap[Key]> | undefined
}

interface ConversationLocationDataValue {
  readonly kind: 'turn' | 'step'
  readonly turn: number
  readonly step?: number
  readonly key: string
  readonly value: unknown
}

type RegisteredTurnData = {
  [Key in keyof ConversationTurnDataMap & string]: {
    readonly kind: 'turn'
    readonly turn: number
    readonly key: Key
    readonly value: ConversationTurnDataMap[Key]
  }
}[keyof ConversationTurnDataMap & string]

type RegisteredStepData = {
  [Key in keyof ConversationStepDataMap & string]: {
    readonly kind: 'step'
    readonly turn: number
    readonly step: number
    readonly key: Key
    readonly value: ConversationStepDataMap[Key]
  }
}[keyof ConversationStepDataMap & string]

/** 由 Definition 拥有、附着到引擎所拥有 Turn 或 Step 的值。 */
export type ConversationLocationData =
  [keyof ConversationTurnDataMap | keyof ConversationStepDataMap] extends [never]
    ? ConversationLocationDataValue
    : RegisteredTurnData | RegisteredStepData

/** 一个 Agent step 已解析的不可变范围。 */
export interface StepLocation {
  readonly turn: number
  readonly step: number
  readonly start: SessionEvent<'step/start'> | undefined
  readonly end: SessionEvent<'step/end'> | undefined
  readonly status: 'open' | 'closed' | 'unknown'
  /** 稳定读取 Step scope 业务值。 */
  readonly data: ConversationLocationDataStore<ConversationStepDataMap>
}

/** 一个 Agent turn 已解析的不可变范围。 */
export interface TurnLocation {
  readonly turn: number
  readonly start: SessionEvent<'turn/start'> | undefined
  readonly end: SessionEvent<'turn/end'> | undefined
  readonly status: 'open' | 'closed' | 'unknown'
  readonly steps: readonly StepLocation[]
  /** 稳定读取 Turn scope 业务值。 */
  readonly data: ConversationLocationDataStore<ConversationTurnDataMap>
}

/** 引擎负责确定一条已匹配事件在 Session 层级中的位置。 */
export type ConversationLocation =
  | { readonly kind: 'session' }
  | { readonly kind: 'turn'; readonly turn: TurnLocation }
  | { readonly kind: 'step'; readonly turn: TurnLocation; readonly step: StepLocation }
  | { readonly kind: 'unresolved' }

/** 一条被 Definition 接受的事件及其当前已解析 Location。 */
export interface ConversationMatch extends ConversationEventInput {
  readonly role: 'start' | 'update'
  readonly location: ConversationLocation
}

/** 业务 Definition 返回的 target 无关身份。 */
export interface ConversationViewNode {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly target: string
  readonly data: unknown
}

/** 已注册视图 target 发布、可通过声明合并扩展的不可变快照。 */
export interface ConversationViewSnapshotMap {}

/** 稳定读取每个已注册视图 target 的最新快照。 */
export interface ConversationViewSnapshotStore {
  /** @param target - 已注册的视图 target。@returns 其当前快照。 */
  get<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ConversationViewSnapshotMap[Target] | undefined
}

/** 由业务 Definition 直接生成的最终 Chat 渲染单元。 */
export interface ChatConversationViewNode extends ConversationViewNode {
  readonly target: 'chat'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly visibility: 'visible' | 'hidden'
}

/** 已组装业务 Context 的不可变公开视图。 */
export interface ConversationNodeContext<State = unknown> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly matches: readonly ConversationMatch[]
  readonly start: ConversationMatch | undefined
  readonly state: State | undefined
  readonly current: ReadonlyMap<string, ConversationViewNode | null>
}

/** 返回给 Definition start 函数的只读前驱 Context。 */
export interface ConversationPreviousContext<State = unknown> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly startSeq: number
  readonly state: Readonly<State>
  readonly matches: readonly ConversationMatch[]
}

/** 计算 start 时可用的严格向后 Context 查询。 */
export interface ConversationContextReader {
  /**
   * 查找 `kind` 相同、start seq 小于当前 start 事件且最大的活跃 Context。
   * @param kind - 要查询的 Definition kind。
   * @returns 最近前驱；当前窗口中不存在时返回 undefined。
   */
  previous<State>(kind: string): ConversationPreviousContext<State> | undefined
}

/** 将更新后业务 State 实例化为视图 Node 时请求的节奏。 */
export type ConversationPublication = 'none' | 'animation-frame' | 'immediate'

/** 由引擎控制的 Location 数据发布阶段。 */
export type ConversationLocationDataScope = 'step' | 'turn'

/** 一个独立注册、把业务事件转换为 Node 的状态机。 */
export interface ConversationNodeDefinition<State = unknown> {
  readonly kind: string
  /** 本 Definition 唯一拥有的视图 target；仅含状态的 Context 可省略。 */
  readonly target?: string
  /**
   * 从一条事件提取本 Definition 的稳定业务身份。
   * @param event - 原始 Session 事件；此处不能访问 Context 或历史。
   * @returns 身份和生命周期角色；无关事件返回 null。
   */
  match(event: SessionEvent): ConversationMatchResult | null
  /**
   * 根据唯一 start Match 创建 State。
   * @param context - 当前为该 Context 收集到的完整证据。
   * @param match - start Match。
   * @param reader - 严格向后的只读 Context 查询器。
   * @returns 引擎采用的 State。
   */
  start(
    context: ConversationNodeContext<State>,
    match: ConversationMatch,
    reader: ConversationContextReader,
  ): State
  /**
   * 应用 start 之后的一条 update Match。
   * @param context - 含当前 State 的 Context。
   * @param match - 按日志升序到达的 update Match。
   * @returns 引擎采用的 State。
   */
  update(
    context: ConversationNodeContext<State> & { readonly state: State },
    match: ConversationMatch,
  ): State
  /**
   * 为一条已接受 Match 选择发布节奏。
   * @param match - 已接受的 Match。
   * @returns 请求的节奏；省略时默认为 immediate。
   */
  publication?(match: ConversationMatch): ConversationPublication
  /**
   * 为一个 Location 阶段发布本 Definition 的只读业务值。引擎会先按 Step、再按 Turn
   * 计算每个 Definition，负责替换和删除，并拒绝其他 Context 发布相同 Location 键。
   * @param context - 最新完整 Context。
   * @param scope - 当前正在实例化的 Location 层级。
   * @returns 当前 Location 值；暂不可用时返回 null。
   */
  buildLocationData?(
    context: ConversationNodeContext<State>,
    scope: ConversationLocationDataScope,
  ): ConversationLocationData | null
  /**
   * 为本 Definition 声明的视图 target 实例化一个最终 Node。
   * @param context - 最新完整 Context。
   * @returns 最终 Node；当前 Context 不可见时返回 null。
   */
  buildViewNode?(context: ConversationNodeContext<State>): ConversationViewNode | null
}

/** 与视图 Node 一同发布、引用稳定的 Turn/Step 信息。 */
export interface ConversationTimelineSnapshot {
  readonly turnOrder: readonly number[]
  readonly turns: ReadonlyMap<number, TurnLocation>
}

/** 针对一个视图 target、每个 Session 独立的增量构建器。 */
export interface ConversationViewBuilder<Node extends ConversationViewNode = ConversationViewNode, Snapshot = unknown> {
  readonly empty: Snapshot
  /**
   * 替换低频更新的完整已实例化 Node 集合。
   * @param input - 完整 Nodes 和当前时间线。
   * @returns 下一份视图快照。
   */
  replace(input: {
    readonly nodes: readonly Node[]
    readonly timeline: ConversationTimelineSnapshot
  }): Snapshot
  /**
   * 只应用本次事务中实例化值发生变化的 Nodes。
   * @param input - 已变化 Nodes 和当前时间线。
   * @returns 下一份视图快照。
   */
  apply(input: {
    readonly upserts: readonly Node[]
    readonly timeline: ConversationTimelineSnapshot
  }): Snapshot
}

/** 为每个 Session 创建独立视图构建器的注册表贡献项。 */
export interface ConversationViewDefinition<Node extends ConversationViewNode = ConversationViewNode, Snapshot = unknown> {
  readonly target: string
  /** @returns 新建、归 Session 所有的增量构建器。 */
  create(): ConversationViewBuilder<Node, Snapshot>
}

/**
 * 为一个 Definition 局部业务身份构建稳定且无冲突的键。
 * @param kind - Definition kind。
 * @param id - Definition 局部业务身份。
 * @returns 引擎拥有的 Context 键。
 */
export function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}
