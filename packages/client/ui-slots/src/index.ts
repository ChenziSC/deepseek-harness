/**
 * slot 注册表的纯核心。所有方通过合并 {@link SlotMap} 声明 slot 约定；一次
 * `register` 调用提供组件，还可声明子 slot、存储 seat 和注册方业务接口。模块没有
 * 运行时依赖，只使用 React 类型。
 *
 * SlotMap 和标准工具包接口直接位于本入口模块。消费方的 `declare module` 扩充会
 * 与目标模块中的词法声明合并，不会与重新导出的声明合并。
 */
/* oxlint-disable typescript/no-redundant-type-constituents --
 * `keyof SlotMap & string` 是声明合并的键模式。SlotMap 在本编译单元中为空，
 * 因而交叉类型表现为 `never`；每个消费方都会合并键，而这个交叉类型负责保持字符串
 * 键类型。规则命中的是空映射视图，并非真实冗余。 */
import type { ReactNode } from 'react'
import type { HostObservable } from './renderer.ts'
import type { BoundActions, HandleOf, PropsStore, SnapshotSelectorHook, StoreDecl } from './store.ts'

export * from './store.ts'
export * from './renderer.ts'

/** slot 约定表。所有方通过声明合并扩展，配置项类型为 {@link SlotEntryDef}。 */
export interface SlotMap {}

/**
 * locale 命名空间表。字典所有方通过声明合并扩展，方式与 {@link SlotMap} 完全
 * 相同；出于同样的词法合并原因，它也声明在本入口模块中。键是命名空间字符串，值是
 * 字典键联合。注册位置通过 `locale:` 声明其中一个命名空间，从而把类型化的标准
 * `t` seat 放入组件属性。
 */
export interface LocaleNamespaceMap {}

/**
 * 翻译字典键，可带 `{name}` 模板参数。`K` 把可接受键收窄到所属命名空间的字典键
 * 联合；组合时还包含共享 common 词汇。
 */
export type Translate<K extends string = string> =
  (key: K, params?: Record<string, unknown>) => string

/**
 * locale 插件合并的共享 `common` 词汇键。没有该合并的程序（例如本包测试）会解析为
 * `never`，使联合折叠不产生副作用。
 */
export type CommonKeyOf = LocaleNamespaceMap extends { common: infer C } ? C & string : never

/**
 * 绑定命名空间的翻译键域：命名空间自身字典键联合加共享 common 词汇。查找链在
 * 命名空间未命中后查询 common。
 */
export type LocaleKeysOf<N extends keyof LocaleNamespaceMap & string> =
  (LocaleNamespaceMap[N] & string) | CommonKeyOf

/**
 * 按命名空间寻址的翻译函数，是 {@link Translate} 的开发者接口别名。
 * `TranslateNS<'model'>` 表示 `model` 命名空间的翻译函数，其键域为该字典键联合
 * 加共享 common 词汇；这也是框架注入的 `t` seat 以及 locale 服务类型化 `bind`
 * 的精确类型。
 */
export type TranslateNS<N extends keyof LocaleNamespaceMap & string> = Translate<LocaleKeysOf<N>>

/**
 * 已声明命名空间的字典结构，精确对应命名空间合并到 {@link LocaleNamespaceMap}
 * 的键。在类型化注册位置缺少或多出键都会导致编译错误。
 */
export type LocaleDictOf<N extends keyof LocaleNamespaceMap & string> =
  Record<LocaleNamespaceMap[N] & string, string>

/** 组合组件属性的 locale 部分：框架注入的 `t` seat，仅存在于声明 `locale:` 的注册项。 */
export type PropsLocale<N> = N extends keyof LocaleNamespaceMap & string
  ? {
    /** 翻译已声明命名空间或共享 common 词汇中的字典键。 */
    t: TranslateNS<N>
  }
  : object

/** slot 基数：单占用项、有序列表、按键分发或由选择器路由的 chain。 */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** slot 数据上下文：全局、当前会话可选或严格绑定会话。 */
export type SlotScope = 'root' | 'session-maybe' | 'session'

/**
 * 一项 SlotMap 配置：包含 kind、scope 两个轴及可选的所有方属性部分。`owner` 是
 * 父级在 renderSlot 调用位置传入的内容；框架标准工具包和注册方注入部分不会进入
 * 本表。完整组件属性在组件处组合为四部分交叉类型，见 {@link ComposedProps}。
 */
export interface SlotEntryDef {
  kind: SlotKind
  scope: SlotScope
  owner?: object
  /**
   * 可选的 keyed 配置项属性表。keyed 注册提供一个字面量键并接收对应属性部分；
   * 普通所有方属性仍由所有键共享。
   */
  keyProps?: Record<string, object>
  /**
   * 一次 renderSlot 调用携带的可选不透明上下文。只有 slot 级注入 hooks 分区中的
   * 函数成员会接收它；slot 基础设施从不解释该值。
   */
  hookContext?: unknown
  /**
   * 父注册项的子声明提供的可选 slot 级 inject 接口。每个已注册配置项都会收到绑定后的
   * 组件接口；子注册方不拥有也不能替换这项公共能力。
   */
  inject?: object
}

/**
 * 单个 slot 的运行时分发规格，取自 register 调用的 `children` 值。字面量会在编译期
 * 对照 SlotMap 配置项检查，即 {@link ChildrenDecl} 中的 `SlotSpec<SlotMap[P]>`，
 * 因而 kind、scope 和公共 inject 接口在同一位置声明并互相校验。
 */
export type SlotSpec<E extends SlotEntryDef> = {
  kind: E['kind']
  scope: E['scope']
} & ('inject' extends keyof E
  ? E extends { inject: infer Injected extends object }
    ? { inject: Injected }
    : { inject?: object }
  : { inject?: never })

/**
 * register() 的子 slot 声明表。键是已声明并因此获得渲染授权的 slot 名称，值是
 * 对应运行时分发规格。声明即认领：注册配置项成为唯一获准渲染这些键的配置项。
 */
export type ChildrenDecl = { [P in keyof SlotMap & string]?: SlotSpec<SlotMap[P]> }

/** 某 slot 键由所有方提供的属性部分；未声明 `owner` 时为 {}。 */
export type OwnerOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { owner: infer O extends object } ? O : object

/** 单个 keyed slot 的注册与分发键域。 */
export type EntryKeyOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
    ? keyof P & string
    : string

/** 所有方在一次 keyed 分发位置提供的、依赖键的属性。 */
export type KeyPropsOf<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
> = SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
  ? EntryKey extends keyof P
    ? P[EntryKey] extends object ? P[EntryKey] : never
    : never
  : object

/** 单个 slot 声明的每次渲染不透明上下文。 */
export type HookContextOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { hookContext: infer Context } ? Context : never

/** 单个 slot 声明的渲染调用公共 inject 接口。 */
export type SlotInjectOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { inject: infer Injected extends object } ? Injected : object

/** 某 slot 键对应 SlotMap 配置项的 scope 轴。 */
export type ScopeOf<K extends keyof SlotMap & string> = SlotMap[K]['scope']

/**
 * 交给每个会话作用域 slot 组件的框架标准工具包。作为零依赖层，这里声明为空；
 * runtime 包会合并真实成员，包括绑定会话快照的 `useSession` 和框架提供的
 * `sessionId`，方式与消费方合并 SlotMap 键相同。
 */
export interface SessionStandardProps {}

/**
 * 交给当前会话可选 slot 的框架标准工具包。未选择会话时钩子仍可调用，并在会话成为
 * 当前项前返回 `undefined`；具体成员由 runtime 包合并。
 */
export interface SessionMaybeStandardProps {}

/**
 * 交给所有 slot 组件的框架标准工具包，即全局 seat。这里声明为空；runtime 包会
 * 合并共享页面组合所消费的全局对象层选择器钩子。
 */
export interface GlobalStandardProps {}

/**
 * runtime 的 SessionStandardProps 合并所声明的会话 id 类型，带有品牌类型。
 * 没有该合并的程序（例如本包测试）会回退到 `string`。
 */
export type SessionIdOf = SessionStandardProps extends { sessionId: infer S } ? S : string

/**
 * 某 slot 键的运行时属性部分：所有方部分（父级 renderSlot 调用位置）、仅会话作用域
 * 使用的会话标准工具包，以及全局 seat。
 */
export type PropsRuntime<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
> =
  OwnerOf<K> &
  KeyPropsOf<K, EntryKey> &
  SlotInjectFace<SlotInjectOf<K>> &
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps

/** renderSlot 分发选项：keyed 分发键、list 筛选和空结果回退。 */
export interface RenderOpts<EntryKey extends string = string> {
  entryKey?: EntryKey
  only?: string
  fallback?: ReactNode
  /** 类型擦除的运行时 seat；PropsRenderSlots 按 slot 声明收窄或移除。 */
  hookContext?: unknown
}

/** renderSlotChain 分发选项。 */
export interface ChainRenderOpts {
  /** 所有配置项选择器都拒绝时渲染的所有方回退内容。 */
  fallback?: ReactNode
  /**
   * 永久挂载回退内容。选举发生时仅用包装层和 display:none 隐藏，不卸载；所有项都
   * 拒绝时原样显示。因此回退内容持有的状态（例如编辑器草稿和 DOM 状态）可跨接管
   * 保留。仅适用于 chain kind；当前唯一消费方是 `conversation.composer` chain。
   */
  overlay?: boolean
}

/**
 * chain 配置项选择器，负责一个 chain 贡献的路由决策。渲染时按 chain 顺序运行：
 * `priority` 升序、默认 0、较小值先尝试，相同值保持注册顺序即装配顺序。第一个
 * 非 null 返回值选中对应配置项，并成为组件的 `matched` 属性；`null` 交给下一项；
 * 全部为 null 时使用所有方的 {@link ChainRenderOpts} 回退。
 *
 * 选择器必须是只依赖所有方属性的纯函数，不得读取外部可变状态或产生副作用。拒绝
 * 决策必须位于此处，不能让已挂载组件检查自身属性后再决定。
 */
export type ChainSelect<O extends object, M> = (owner: O) => M | null

/** slot 键联合中 SlotMap 配置项为 chain kind 的键，即 renderSlotChain 的分发域。 */
export type ChainKeysOf<S extends keyof SlotMap & string> =
  S extends unknown ? (SlotMap[S]['kind'] extends 'chain' ? S : never) : never

/** 渲染部分中每次分发都要求 hookContext 的键。 */
type ContextualKeysOf<S extends keyof SlotMap & string> =
  S extends unknown ? (SlotMap[S] extends { hookContext: unknown } ? S : never) : never

/** 渲染部分中使用普通可选选项对象的键。 */
type OrdinaryKeysOf<S extends keyof SlotMap & string> = Exclude<S, ContextualKeysOf<S>>

/**
 * 普通与带上下文的子分发签名。分开保留两个调用签名，既维持普通 renderSlot 的可赋值性，
 * 又只对确实需要的 slot 键强制要求已声明 hookContext。
 */
type RenderSlotFn<S extends keyof SlotMap & string> =
  ([ContextualKeysOf<S>] extends [never] ? object : {
    <
      K extends ContextualKeysOf<S>,
      EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    >(
      key: K,
      owner: OwnerOf<K> & KeyPropsOf<K, NoInfer<EntryKey>>,
      opts: RenderOpts<EntryKey> & { hookContext: HookContextOf<K> },
    ): ReactNode
  }) &
  ([OrdinaryKeysOf<S>] extends [never] ? object : {
    <
      K extends OrdinaryKeysOf<S>,
      EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    >(
      key: K,
      owner: OwnerOf<K> & KeyPropsOf<K, NoInfer<EntryKey>>,
      opts?: Omit<RenderOpts<EntryKey>, 'hookContext'>,
    ): ReactNode
  })

/**
 * chain 的 matched 部分：chain slot 组件把选择器的非 null 结果作为框架注入的
 * `matched` 属性接收；其他 kind 不向组合约束增加内容。
 */
export type MatchedShare<E extends SlotEntryDef, M> =
  E['kind'] extends 'chain' ? { matched: M } : object

/**
 * 组件属性约定使用的会话选择器钩子别名。在这个依赖反转层默认保持宽类型；runtime
 * 在导出位置将其收窄为 `UseSession<ConversationSnapshot>`。
 */
export type UseSession<Snap extends object = object> = SnapshotSelectorHook<Snap>

/** 标准工具包 SessionProvider seat 的属性，采用 render prop 形式。 */
export interface SessionAreaProps {
  /** 无会话内容；也覆盖当前 id 无法解析到会话的情况。 */
  empty?: (() => ReactNode) | undefined
  /** 会话内容；框架按会话重新挂载，键为 sessionId。 */
  children: (sessionId: SessionIdOf) => ReactNode
}

/**
 * 由框架接线的会话区域组件。它订阅 runtime 所有的会话选择，并注入声明了会话作用域
 * 子项的配置项；业务代码不直接导入。
 */
export type SessionProviderComponent = (props: SessionAreaProps) => ReactNode

/**
 * 子 slot 渲染部分：`renderSlot` 静态收窄到配置项已声明的 children 键。委托只是
 * 普通属性传递，即向下传递 `props.renderSlot`；授权标识仍属于注册配置项。
 * `__renders` 是永不物化的虚拟型变锚点。泛型方法签名在不同键联合之间比较较宽松，
 * 因而实际由这个逆变标记在 register 调用位置强制“组件键集合 ⊆ children 声明”。
 */
export type PropsRenderSlots<S extends keyof SlotMap & string> = {
  /**
   * 渲染已声明的非 chain 子 slot。chain 键通过 `renderSlotChain` 分发，路由逻辑
   * 位于配置项选择器。
   * @param key - 已声明的子键。
   * @param owner - 该键的所有方属性部分，在渲染位置决定。
   * @param opts - kind 分发选项。
   * @returns 渲染后的一个或多个节点。
   */
  renderSlot: RenderSlotFn<Exclude<S, ChainKeysOf<S>>>
  readonly __renders?: ((key: S) => void) | undefined
} & ([ChainKeysOf<S>] extends [never] ? object : {
  /**
   * 渲染已声明的 chain 子 slot。配置项选择器按 chain 顺序处理 `owner`；首个非 null
   * 匹配项渲染其组件，并把选择器结果注入为 `matched`；全部为 null 时渲染
   * `opts.fallback`。
   * @param key - 已声明的 chain 子键。
   * @param owner - 所有方属性部分，也是选择器的路由输入。
   * @param opts - 全部为 null 时的回退内容。
   * @returns 渲染后的一个或多个节点。
   */
  renderSlotChain: <K extends ChainKeysOf<S>>(key: K, owner: OwnerOf<K>, opts?: ChainRenderOpts) => ReactNode
}) & ('session' extends ScopeOf<S>
  // SessionProvider seat 与 renderSlot 使用同一真源。声明会话作用域子项才会产生会话
  // 区域，因此 seat 从 children 键集合的 scope 推导，值由渲染器注入。
  ? { SessionProvider: SessionProviderComponent }
  : object)

/**
 * 注册位置的组件形式采用裸调用签名，使组合约束通过清晰的参数逆变检查。FC 静态成员
 * 会引入协变噪声并错误拒绝合法收窄。
 */
export type SlotComponent<P> = (props: P) => ReactNode

/**
 * 注册方 hooks 分区：在配置项 inject 接口的保留 `hooks` 键下提供裸可观察数据源，
 * 即 getSnapshot 与 subscribe 对。它们保留原始“数据源到选择器”绑定，不参与单次
 * 渲染上下文。
 */
export type HooksSources = Record<string, HostObservable<unknown>>

/** 绑定 slot 级上下文 Hook 时可见的框架所有属性。 */
export type StandardPropsOf<K extends keyof SlotMap & string> =
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps

/**
 * 一个函数值 slot 级 inject.hooks 成员。工厂必须为纯函数并返回真实自定义 Hook；
 * 绑定过程中不得调用 Hook。
 */
export type SlotHookFactory<
  K extends keyof SlotMap & string,
  Hook extends (...args: never[]) => unknown,
> = (
  standard: StandardPropsOf<K>,
  hookContext: HookContextOf<K>,
) => Hook

/** 由一个 slot 级 inject.hooks 成员生成的组件侧 Hook。 */
type BoundHookOf<Definition> =
  Definition extends HostObservable<infer Snapshot>
    ? SnapshotSelectorHook<Snapshot>
    : Definition extends (...args: never[]) => infer Hook
      ? Hook extends (...args: never[]) => unknown ? Hook : never
      : never

/**
 * 从 hooks 分区合成的选择器钩子部分：每个数据源 `name` 都会成为基于其快照类型的
 * `use<Name>` 选择器钩子。
 */
export type PropsSlotHooks<HS extends object> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]:
  BoundHookOf<HS[N]>
}

/** slot 分发器公共 inject 接口的组件侧视图。 */
export type SlotInjectFace<I extends object> =
  I extends { hooks: infer HS extends object } ? Omit<I, 'hooks'> & PropsSlotHooks<HS> : I

/** 从配置项 inject hooks 分区合成的选择器钩子部分。 */
export type PropsHooks<HS extends HooksSources> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]:
  SnapshotSelectorHook<HS[N] extends HostObservable<infer T> ? T : never>
}

/**
 * inject 接口的组件侧视图：已声明的保留 `hooks` 分区会转换为绑定后的
 * `use<Name>` 选择器钩子；其他成员原样透传。
 */
export type InjectFace<I extends object> =
  I extends { hooks: infer HS extends HooksSources } ? Omit<I, 'hooks'> & PropsHooks<HS> : I

/**
 * 组件属性的组合交叉类型：运行时部分（SlotMap）、子渲染部分（children 声明）、
 * 存储部分（已声明句柄）、注册方注入的业务接口（其 hooks 分区已绑定，见
 * {@link InjectFace}），以及 locale `t` seat（已声明命名空间，见
 * {@link PropsLocale}）。每部分都从自身唯一真源推导；组件引用该组合，不得重新声明。
 */
export type ComposedProps<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  S extends keyof SlotMap & string,
  H,
  I extends object,
  M = never,
  N = undefined,
> = PropsRuntime<K, EntryKey> & PropsRenderSlots<S> & PropsStore<H> & InjectFace<I> & MatchedShare<SlotMap[K], M> & PropsLocale<N>

/**
 * 从注册声明推导的 inject 工厂参数列表：严格会话 slot 接收框架解析出的确定
 * `sessionId`；session-maybe slot 接收当前 id 或 `undefined`；已声明存储会追加
 * 烘焙后的 `actions`，与组件收到的回调相同。业务数据通过 apply 闭包的 ctx 访问，
 * 不存在绑定对象参数。
 */
export type InjectParams<K extends keyof SlotMap & string, H> =
  ScopeOf<K> extends 'session'
    ? ([H] extends [StoreDecl] ? [sessionId: SessionIdOf, actions: BoundActions<HandleOf<H>>] : [sessionId: SessionIdOf])
    : ScopeOf<K> extends 'session-maybe'
      ? ([H] extends [StoreDecl]
        ? [sessionId: SessionIdOf | undefined, actions: BoundActions<HandleOf<H>> | undefined]
        : [sessionId: SessionIdOf | undefined])
      : ([H] extends [StoreDecl] ? [actions: BoundActions<HandleOf<H>>] : [])

/**
 * list 配置项展示标签：普通字符串，或每次读取都重新计算的 thunk。后者让注册时文案
 * （导航行、标签页）无需重新注册即可跟随当前 locale。所有方通过
 * {@link resolveSlotLabel} 解析。
 */
export type SlotLabel = string | (() => string)

/**
 * register 选项携带的 kind 结构字段：keyed 的分发键；list 的 id、order、label；
 * chain 的 select、priority；非 chain 的 priority 表示单元格遮蔽优先级。
 */
export type KindOptions<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  M = never,
> =
  SlotMap[K]['kind'] extends 'keyed' ? {
    key: EntryKey
    /** 单元格遮蔽优先级：升序、默认 0、最小值渲染；相同 key 与优先级会抛错，见 {@link SlotCore.register}。 */
    priority?: number
  }
    : SlotMap[K]['kind'] extends 'list' ? {
      id: string
      order?: number
      label?: SlotLabel
      /** 单元格遮蔽优先级：升序、默认 0、最小值渲染；相同 id 与优先级会抛错，见 {@link SlotCore.register}。 */
      priority?: number
    }
      : SlotMap[K]['kind'] extends 'chain' ? {
        /** 路由选择器，chain 配置项必填；组件 `matched` 属性的类型 `M` 从返回值推导。 */
        select: ChainSelect<SlotMap[K] extends { owner: infer O extends object } ? O : object, M>
        /** 显式链位置：升序，默认 0，较小值先尝试；相同值保持注册顺序，即装配顺序。 */
        priority?: number
      }
        : {
          /**
           * 单元格遮蔽优先级：升序，默认 0，最小值负责渲染；相同优先级的第二次注册
           * 会抛错，见 {@link SlotCore.register}。
           */
          priority?: number
        }

/**
 * 编译期存在性检查：声明 children 的配置项必须消费 `renderSlot`；如果其子项全是
 * chain slot，则消费 `renderSlotChain`。声明即认领，不渲染子项的配置项不应声明
 * 它们。违反时会计算为一个无法满足、并列出已声明键的交叉成员。
 */
type RendersCheck<C, D> =
  [keyof D & keyof SlotMap & string] extends [never] ? unknown
    : C extends (props: infer P) => ReactNode
      ? ('renderSlot' extends keyof P ? unknown
        : 'renderSlotChain' extends keyof P ? unknown
          : { 'children declared but the component consumes no renderSlot': keyof D & keyof SlotMap & string })
      : unknown

/** register 选项的公共部分；语义见 {@link SlotCore.register}。 */
type BaseOptions<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  D extends ChildrenDecl,
  H,
  M = never,
  N = undefined,
> = {
  /** 目标 slot 键；配置项向该 slot 提供内容。 */
  name: K
  /** 在同一张表中保存子 slot 声明、渲染授权和运行时规格。 */
  children?: D
  /** 存储 seat：由 apply 创建的共享句柄，或框架按“配置项 × 作用域”调用的独占工厂。 */
  store?: H
  /**
   * 本配置项文案使用的字典命名空间。声明后，框架会把 `t` seat 放入组件属性，
   * 其类型限制为该命名空间的字典键联合。渲染要求 locale 接口已安装，否则明确失败。
   */
  locale?: N
  /** 用于诊断的注册方标识；运行时 Service 包装层写入调用方 fiber 名称。 */
  registrant?: string
} & KindOptions<K, EntryKey, M>

/**
 * 内核记录、渲染基础设施读取的一项注册。此边界会擦除类型，因为注册约定已经证明
 * 各属性部分与组件匹配。
 */
export interface StoredEntry {
  component: unknown
  options: { key?: string; id?: string; order?: number; label?: SlotLabel; priority?: number }
  /** chain 路由选择器；与 `inject` 一样擦除类型，仅存在于 chain slot 配置项。 */
  select?: ((owner: never) => unknown) | undefined
  /** 注册方业务接口；位置参数由声明推导，例如 sessionId 和 actions。 */
  inject?: ((...args: never[]) => Record<string, unknown>) | undefined
  /** 子 slot 声明表，合并声明、授权和运行时规格。 */
  children?: Readonly<Record<string, SlotSpec<SlotEntryDef>>> | undefined
  /** 已声明的存储 seat；实例解析和生命周期由宿主基础设施负责。 */
  store?: StoreDecl | undefined
  /** 已声明的字典命名空间；渲染基础设施据此合成 `t` seat。 */
  locale?: string | undefined
  /** 标明注册方的诊断标签。 */
  registrant?: string | undefined
}

/**
 * 读取时解析可能是 thunk 的列表标签。thunk 会跟随当前 locale；投影 ledger 行的
 * 所有方应调用本函数，而不是直接读取 `options.label`。
 * @param label - 已存储的标签。
 * @returns 展示字符串；配置项未声明标签时返回 undefined。
 */
export function resolveSlotLabel(label: SlotLabel | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}

/**
 * 实现使用的类型擦除选项视图。可选成员显式带有 `| undefined`；在
 * exactOptionalPropertyTypes 下，公共重载的泛型允许 undefined，缺少显式联合会
 * 使重载与实现不兼容。
 */
interface ErasedOptions {
  name: string
  key?: string | undefined
  id?: string | undefined
  order?: number | undefined
  label?: SlotLabel | undefined
  select?: ((owner: never) => unknown) | undefined
  priority?: number | undefined
  children?: Record<string, SlotSpec<SlotEntryDef>> | undefined
  store?: StoreDecl | undefined
  locale?: string | undefined
  /* oxlint-disable-next-line typescript/no-explicit-any --
   * 仅用于实现签名；两个公共重载都会精确约束 inject。`never[]` 无法与按声明生成的
   * InjectParams 元组保持重载到实现的兼容性。 */
  inject?: ((...args: any) => Record<string, unknown>) | undefined
  registrant?: string | undefined
}

/** 按键保存的注册表记录。首次访问时创建且永不删除，使 version 跨重新声明保持单调。 */
interface SlotRecord {
  spec: SlotSpec<SlotEntryDef> | undefined
  /** 诊断信息：声明本键的 slot 配置项；root 使用 `(built-in)`。 */
  declaredBy: string | undefined
  /** 当前父声明；根 slot 不存在此项。 */
  parent: string | undefined
  /** 单调递增的声明生命周期编号，与普通配置项变更分离。 */
  declarationEpoch: number
  entries: readonly StoredEntry[]
  version: number
  listeners: Set<() => void>
  declarationListeners: Set<() => void>
}

const NO_ENTRIES: readonly StoredEntry[] = Object.freeze([])

/** slot 检查返回的 JSON 安全实时占用项。 */
export interface LiveSlotOccupant {
  /** 注册该配置项的插件或包；未知时省略。 */
  registrant?: string
  /** keyed slot 单元格。 */
  key?: string
  /** list slot 单元格。 */
  id?: string
  /** 列表展示顺序。 */
  order?: number
  /** 遮蔽或 chain 优先级。 */
  priority: number
  /** 渲染器当前是否选择该配置项。 */
  active: boolean
}

/** JSON 安全的实时 slot 声明树。 */
export interface LiveSlotNode {
  /** 精确的 SlotMap 键。 */
  name: string
  /** slot 基数类型。 */
  kind: SlotKind
  /** 运行时数据作用域。 */
  scope: SlotScope
  /** 本声明的诊断所有方。 */
  declaredBy?: string
  /** 按 ledger 顺序排列的当前注册项。 */
  occupants: LiveSlotOccupant[]
  /** 挂载到本 slot 的配置项所声明的 slot。 */
  children: LiveSlotNode[]
}

/**
 * 纯 slot 注册表，不依赖 Cordis；事件发送和渲染器安装约定位于运行时 Service
 * 包装层。
 *
 * `root` slot 是唯一的先验声明，在构造时播种：kind 为 single、scope 为 root，
 * 由框架声明，是渲染树的根位置。
 *
 * 变更传播约定：每次变更同步递增 version 并触发 {@link SlotCore.onMutate}，触发时
 * 注册表状态已经一致；每个声明生命周期边界同步触发
 * {@link SlotCore.subscribeDeclaration}；{@link SlotCore.subscribe} 按微任务批处理，
 * 因此同一 tick 内 N 次变更只会为每个受影响键通知一次。配置项崩溃并退出时，
 * {@link SlotCore.reportEntryError} 走同一变更通道，再同步通知
 * {@link SlotCore.onEntryError}。
 */
export class SlotCore {
  private records = new Map<string, SlotRecord>()
  private mutateListeners = new Set<(key: string) => void>()
  /** 共享句柄作用域 ledger：句柄映射到首次挂载作用域及实时挂载数。 */
  private handleScopes = new Map<object, { scope: SlotScope; count: number }>()
  // 保存脏记录而非键。记录永不删除，持有引用可在 flush 时省去查找及不可达的缺失分支。
  private dirty = new Set<SlotRecord>()
  private flushScheduled = false
  /**
   * 因退出型崩溃报告（{@link SlotCore.reportEntryError}）而退役的配置项。在其剩余
   * 注册生命周期内，{@link SlotCore.entriesOfSlot} 投影会排除它，但注册本身仍留在
   * ledger 上，dispose 权限继续归注册方所有。
   */
  private abdicated = new WeakSet<StoredEntry>()
  private entryErrorListeners
    = new Set<(key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean }) => void>()

  constructor() {
    // 先验 root 位置。构造过程无人可观察，因此不调用 markDirty。
    const root = this.record('root')
    root.spec = { kind: 'single', scope: 'root' }
    root.declaredBy = '(built-in)'
    root.declarationEpoch = 1
  }

  /**
   * 向已声明 slot 提供组件，并可选声明子 slot、存储 seat 和注册方业务接口。
   *
   * 加载时完成全部校验，配置错误明确失败，渲染热路径不再重复检查：向未声明 slot
   * 注册会抛错；声明已有子键会抛错，每个 slot 只能有一个声明方，消息会指出首个
   * 声明方；把同一共享存储句柄挂到不同作用域也会抛错。不同 kind 的要求为：keyed
   * 必须提供 `key`，list 必须提供 `id`，chain 必须提供 `select`；选择器是配置项的
   * 路由 seat，见 {@link ChainSelect}。
   *
   * single、keyed 和 list 支持遮蔽：共享一个单元格的配置项（single 为 slot 本身，
   * keyed 为相同 `key`，list 为相同 `id`）可用不同优先级共存。列表按优先级升序，
   * 相同值保持注册顺序；每个单元格中优先级最低的实时配置项负责渲染，见
   * {@link SlotCore.entriesOfSlot}。如果在已占用单元格以完全相同的优先级（默认 0）
   * 再次注册，则抛错并指出占用方，保证无优先级组合仍遵循“每格一个占用方”的明确失败。
   *
   * disposer 会同时移除贡献并折叠所有已声明子 slot。子配置项会递归清空，其陈旧
   * disposer 变为空操作；整个结构共用一条生命周期轴，不留下悬空状态。
   *
   * @param options - 注册选项，包括目标 `name`、`children` 声明表、`store` seat、
   * `inject` 业务接口工厂，以及各 kind 字段（keyed 的 `key`；list 的
   * `id`、`order`、`label`）。
   * @param component - 遵循四部分组合属性约定（{@link ComposedProps}）的组件；
   * 在本调用位置完成检查。
   * @returns 移除注册及其声明的 disposer；操作幂等，级联后的陈旧 disposer 为空操作。
   */
  /* jscpd:ignore-start -- 两个 register 重载有意保持平行，只在 inject 部分不同；
   * 合并会丢失每个重载对 I 的独立推导。 */
  register<
    K extends keyof SlotMap & string,
    const EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    const D extends ChildrenDecl = Record<never, never>,
    H extends StoreDecl | undefined = undefined,
    M = never,
    N extends (keyof LocaleNamespaceMap & string) | undefined = undefined,
    C extends SlotComponent<never> = SlotComponent<never>,
  >(
    options: BaseOptions<K, EntryKey, D, H, M, N> & { inject?: undefined },
    component: C
      & SlotComponent<ComposedProps<
        K, NoInfer<EntryKey>, keyof NoInfer<D> & keyof SlotMap & string,
        HandleOf<NoInfer<H>>, object, NoInfer<M>, NoInfer<N>
      >>
      & RendersCheck<C, D>,
  ): () => void
  /**
   * 带 inject 的重载：语义与上一个重载相同，并加入注册方业务接口。`I` 从 inject
   * 工厂返回值推导，并参与组件组合属性约束；工厂参数由声明推导，见
   * {@link InjectParams}。
   * @param options - 注册选项及 `inject` 业务接口工厂。
   * @param component - 遵循四部分组合属性约定、且包含 inject 部分 `I` 的组件。
   * @returns 移除注册及其声明的 disposer。
   */
  register<
    K extends keyof SlotMap & string,
    I extends object,
    const EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    const D extends ChildrenDecl = Record<never, never>,
    H extends StoreDecl | undefined = undefined,
    M = never,
    N extends (keyof LocaleNamespaceMap & string) | undefined = undefined,
    C extends SlotComponent<never> = SlotComponent<never>,
  >(
    options: BaseOptions<K, EntryKey, D, H, M, N> & { inject: (...args: InjectParams<K, H>) => I },
    component: C
      & SlotComponent<ComposedProps<
        K, NoInfer<EntryKey>, keyof NoInfer<D> & keyof SlotMap & string,
        HandleOf<NoInfer<H>>, I, NoInfer<M>, NoInfer<N>
      >>
      & RendersCheck<C, D>,
  ): () => void
  /* jscpd:ignore-end */
  register(options: ErasedOptions, component: unknown): () => void {
    const rec = this.records.get(options.name)
    if (!rec?.spec) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
    const spec = rec.spec
    // 动态组合调用方仍需在运行时检查 kind 约束；类型化调用方已静态满足 KindOptions。
    // 单元格占用只在优先级完全相同时冲突，不同优先级会形成遮蔽。
    const priority = options.priority ?? 0
    const occupantHint = (occupant: StoredEntry) =>
      `at priority ${priority}${occupant.registrant !== undefined ? ` (registered by ${occupant.registrant})` : ''} — register at a different priority to shadow it (lowest renders)`
    switch (spec.kind) {
      case 'single': {
        const occupant = rec.entries.find(e => (e.options.priority ?? 0) === priority)
        if (occupant) throw new Error(`single slot "${options.name}" already has a registration ${occupantHint(occupant)}`)
        break
      }
      case 'keyed': {
        if (options.key === undefined) throw new Error(`keyed slot "${options.name}" requires options.key`)
        const occupant = rec.entries.find(e => e.options.key === options.key && (e.options.priority ?? 0) === priority)
        if (occupant) {
          throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}" ${occupantHint(occupant)}`)
        }
        break
      }
      case 'list': {
        if (options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`)
        const occupant = rec.entries.find(e => e.options.id === options.id && (e.options.priority ?? 0) === priority)
        if (occupant) {
          throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}" ${occupantHint(occupant)}`)
        }
        break
      }
      case 'chain':
        if (options.select === undefined) throw new Error(`chain slot "${options.name}" requires options.select`)
        break
    }
    if (options.children) {
      for (const childKey of Object.keys(options.children)) {
        const childRec = this.records.get(childKey)
        if (childRec?.spec) {
          throw new Error(`slot "${childKey}" is already declared (by ${childRec.declaredBy ?? 'an unknown entry'})`)
        }
      }
    }
    // 共享句柄首次挂载时固定作用域。工厂不受此限制，因为框架为每个配置项创建实例，
    // 不存在共享标识。
    if (options.store !== undefined && typeof options.store !== 'function') {
      const pinned = this.handleScopes.get(options.store)
      if (pinned && pinned.scope !== spec.scope) {
        throw new Error(
          `store handle mounted under "${options.name}" (scope "${spec.scope}") is already mounted under scope "${pinned.scope}" — one handle, one scope`)
      }
      if (pinned) pinned.count += 1
      else this.handleScopes.set(options.store, { scope: spec.scope, count: 1 })
    }

    const entry: StoredEntry = {
      component,
      options: {
        ...(options.key !== undefined ? { key: options.key } : {}),
        ...(options.id !== undefined ? { id: options.id } : {}),
        ...(options.order !== undefined ? { order: options.order } : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
      },
      ...(options.select !== undefined ? { select: options.select } : {}),
      ...(options.inject !== undefined ? { inject: options.inject } : {}),
      ...(options.children !== undefined ? { children: options.children } : {}),
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
      ...(options.registrant !== undefined ? { registrant: options.registrant } : {}),
    }
    const next = [...rec.entries, entry]
    // 所有 kind 都进行稳定的优先级升序排序，相同值保持注册顺序。单元格以首次出现者
    // 获胜，chain 先尝试较低优先级。list 再以显式 `order` 细分相同优先级，使原始
    // ledger 在无优先级组合中保持展示顺序。
    next.sort(spec.kind === 'list'
      ? (a, b) => ((a.options.priority ?? 0) - (b.options.priority ?? 0)) || ((a.options.order ?? 0) - (b.options.order ?? 0))
      : (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
    rec.entries = next
    this.markDirty(options.name, rec)
    if (options.children) {
      const declarations: [key: string, record: SlotRecord][] = []
      for (const [childKey, childSpec] of Object.entries(options.children)) {
        const childRec = this.record(childKey)
        childRec.spec = childSpec
        childRec.declaredBy = `an entry in "${options.name}"${options.registrant ? ` (${options.registrant})` : ''}`
        childRec.parent = options.name
        childRec.declarationEpoch += 1
        declarations.push([childKey, childRec])
      }
      // 同步监听器可能向同级注册或尝试重新声明，因此必须等整张 children 表取得所有
      // 声明后再发布。
      for (const [childKey, childRec] of declarations) {
        this.markDirty(childKey, childRec)
      }
      for (const [, childRec] of declarations) {
        this.notifyDeclaration(childRec)
      }
    }
    return () => {
      if (!rec.entries.includes(entry)) return
      rec.entries = rec.entries.filter(e => e !== entry)
      this.markDirty(options.name, rec)
      this.releaseEntry(entry)
    }
  }

  /**
   * 判断先前取得的配置项是否仍已注册。这是渲染基础设施的陈旧授权探针：如果保留的
   * renderSlot 绑定对应配置项已经离开 ledger，就不得继续渲染。
   * @param entry - 先前读取的配置项。
   * @returns 配置项注册被 dispose 后返回 false。
   */
  isLive(entry: StoredEntry): boolean {
    for (const rec of this.records.values()) {
      if (rec.entries.includes(entry)) return true
    }
    return false
  }

  /**
   * 获取某键注册项的快照。返回缓存数组引用，变更之间保持稳定，可安全作为 uSES
   * getSnapshot 数据源。键尚未声明或已撤销声明时返回空数组，使渲染器可以不受插件
   * 加载顺序限制而提前探测。
   * @param key - slot 键；渲染基础设施以字符串动态持有。
   * @returns 按注册顺序排列的配置项；list 按 order 排列。
   */
  entries(key: string): readonly StoredEntry[] {
    return this.records.get(key)?.entries ?? NO_ENTRIES
  }

  /**
   * 把某键的配置项投影为遮蔽胜出项：按优先级取每个单元格第一个实时且未退出的
   * 配置项。single 把整个 slot 视为一个单元格，keyed 每个 `key` 一个，list 每个
   * `id` 一个；胜出项保持 ledger 顺序，list 渲染器仍会用 `order` 细分展示顺序。
   * chain 键原样返回全部配置项，因为选举要消费所有项，不适用遮蔽。原始
   * {@link SlotCore.entries} 仍是检查接口。每次调用都会创建新数组，用于渲染体读取，
   * 不能作为 uSES getSnapshot 数据源。
   * @param key - slot 键；渲染基础设施以字符串动态持有。
   * @returns 每个已占用单元格的胜出配置项；未声明时为空。
   */
  entriesOfSlot(key: string): readonly StoredEntry[] {
    const rec = this.records.get(key)
    if (!rec?.spec) return NO_ENTRIES
    const kind = rec.spec.kind
    if (kind === 'chain') return rec.entries
    const heads: StoredEntry[] = []
    const seenCells = new Set<string | undefined>()
    for (const entry of rec.entries) {
      if (this.abdicated.has(entry)) continue
      // single kind 的所有配置项共享同一个 undefined 单元格。
      const cell = kind === 'keyed' ? entry.options.key : kind === 'list' ? entry.options.id : undefined
      if (seenCells.has(cell)) continue
      seenCells.add(cell)
      heads.push(entry)
    }
    return heads
  }

  /**
   * 查找 slot 的已声明规格，并按 SlotMap 键收窄类型。
   * @param key - SlotMap 键。
   * @returns 规格；尚未声明时返回 undefined。
   */
  spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined {
    return this.records.get(key)?.spec as SlotSpec<SlotMap[K]> | undefined
  }

  /**
   * 规格查找的动态键出口。渲染器在通用分发中只以字符串持有键时使用此宽类型形式；
   * 静态键调用方使用 {@link SlotCore.spec}。
   * @param key - 候选 slot 键。
   * @returns 宽类型规格；尚未声明时返回 undefined。
   */
  specDynamic(key: string): SlotSpec<SlotEntryDef> | undefined {
    return this.records.get(key)?.spec
  }

  /**
   * 导出当前声明拓扑，不包含组件或可执行钩子。
   * @param root - 要选择的精确 slot 键；省略时返回所有实时根。
   * @returns 已选实时 slot 树；`root` 不可用时返回空数组。
   */
  snapshot(root?: string): LiveSlotNode[] {
    const build = (name: string, seen: Set<string>): LiveSlotNode | undefined => {
      const record = this.records.get(name)
      if (record?.spec === undefined || seen.has(name)) return undefined
      const branch = new Set(seen)
      branch.add(name)
      const active = new Set(this.entriesOfSlot(name))
      const children = [...this.records.entries()]
        .filter(([, candidate]) => candidate.spec !== undefined && candidate.parent === name)
        .flatMap(([child]) => {
          const node = build(child, branch)
          return node === undefined ? [] : [node]
        })
      return {
        name,
        kind: record.spec.kind,
        scope: record.spec.scope,
        ...record.declaredBy === undefined ? {} : { declaredBy: record.declaredBy },
        occupants: record.entries.map(entry => ({
          ...entry.registrant === undefined ? {} : { registrant: entry.registrant },
          ...entry.options.key === undefined ? {} : { key: entry.options.key },
          ...entry.options.id === undefined ? {} : { id: entry.options.id },
          ...entry.options.order === undefined ? {} : { order: entry.options.order },
          priority: entry.options.priority ?? 0,
          active: active.has(entry),
        })),
        children,
      }
    }
    if (root !== undefined) {
      const node = build(root, new Set())
      return node === undefined ? [] : [node]
    }
    return [...this.records.entries()]
      .filter(([, record]) => record.spec !== undefined
        && (record.parent === undefined || this.records.get(record.parent)?.spec === undefined))
      .flatMap(([name]) => {
        const node = build(name, new Set())
        return node === undefined ? [] : [node]
      })
  }

  /**
   * 读取某键的声明生命周期。增删配置项不会改变它；创建和折叠声明都会推进它。
   * @param key - slot 键。
   * @returns 单调递增的 epoch；首次声明前为 0。
   */
  declarationEpoch(key: string): number {
    return this.records.get(key)?.declarationEpoch ?? 0
  }

  /**
   * 订阅某键的注册变更，通知按微任务批处理。允许在声明前订阅，声明时会通知。
   * @param key - slot 键。
   * @param fn - 变更回调。
   * @returns 取消订阅函数。
   */
  subscribe(key: string, fn: () => void): () => void {
    const rec = this.record(key)
    rec.listeners.add(fn)
    return () => { rec.listeners.delete(fn) }
  }

  /**
   * 订阅某键的声明生命周期边界。通知同步发送，确保声明拆除在同一 tick 的后续注册
   * 观察到陈旧资源前完成。普通配置项变更不会通知此接口。children 表会先提交所有
   * 同级声明，再发送第一次通知。
   * @param key - slot 键。
   * @param fn - 声明或折叠回调。
   * @returns 取消订阅函数。
   */
  subscribeDeclaration(key: string, fn: () => void): () => void {
    const rec = this.record(key)
    rec.declarationListeners.add(fn)
    return () => { rec.declarationListeners.delete(fn) }
  }

  /**
   * 某键的单调 version。每次变更同步推进，确保批量通知到达时，uSES getSnapshot
   * 读取不会陈旧。
   * @param key - slot 键。
   * @returns 当前 version；从未访问的键为 0。
   */
  getVersion(key: string): number {
    return this.records.get(key)?.version ?? 0
  }

  /**
   * 监听每次变更；运行时 Service 包装层把它桥接到 ctx.emit。每次变更同步触发且不
   * 批处理，因为事件语义要求每项变更各发送一次。
   * @param fn - 以发生变更的键调用。
   * @returns 取消订阅函数。
   */
  onMutate(fn: (key: string) => void): () => void {
    this.mutateListeners.add(fn)
    return () => { this.mutateListeners.delete(fn) }
  }

  /**
   * 接收配置项边界的渲染器崩溃报告，并始终通知 {@link SlotCore.onEntryError}
   * 监听器。对于支持遮蔽的 single、keyed、list，`info.abdicate` 为 true 时会先将
   * 配置项一次性移出单元格：记录的 version 通过普通变更通道推进，使 outlet 重新
   * 投影到下一个存活项；重复退出报告完全为空操作。chain 崩溃使用
   * `abdicate: false`，因为备选项在 select 时解析，配置项保留单元格，只发送通知。
   * 无论哪种情况，注册本身仍留在 ledger 上；原始 {@link SlotCore.entries} 仍列出
   * 配置项，其 disposer 也继续有效。
   * @param key - 配置项所在的 slot 键。
   * @param entry - 崩溃的配置项。
   * @param error - 崩溃原因，原样转发给监听器。
   * @param info - `abdicate` 表示崩溃是否使配置项退出其单元格。
   */
  reportEntryError(key: string, entry: StoredEntry, error: unknown, info: { abdicate: boolean }): void {
    if (info.abdicate) {
      if (this.abdicated.has(entry)) return
      this.abdicated.add(entry)
      const rec = this.records.get(key)
      if (rec !== undefined) this.markDirty(key, rec)
    }
    for (const fn of [...this.entryErrorListeners]) fn(key, entry, error, { abdicated: info.abdicate })
  }

  /**
   * 观察配置项边界捕获的全部渲染期失败，无论是否退出。这是宿主镜像贡献健康状态的
   * 监督 seam。每份报告同步触发；退出型崩溃会先完成注册表变更，监听纪律与
   * {@link SlotCore.onMutate} 相同。
   * @param fn - 以 slot 键、崩溃配置项、崩溃原因和 `abdicated` 调用；后者表示是否
   * 已将配置项移出单元格。
   * @returns 取消订阅函数。
   */
  onEntryError(fn: (key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean }) => void): () => void {
    this.entryErrorListeners.add(fn)
    return () => { this.entryErrorListeners.delete(fn) }
  }

  /**
   * 删除配置项时执行级联：释放其存储挂载，并折叠它声明的所有子 slot。规格被清除、
   * 贡献被置空且陈旧 disposer 变为空操作，随后沿声明树递归处理。ledger 行、slot、
   * 贡献和存储挂载共用一条生命周期轴并一同结束。
   */
  private releaseEntry(entry: StoredEntry): void {
    if (entry.store !== undefined && typeof entry.store !== 'function') {
      const pinned = this.handleScopes.get(entry.store)
      if (pinned && --pinned.count === 0) this.handleScopes.delete(entry.store)
    }
    if (!entry.children) return
    for (const childKey of Object.keys(entry.children)) {
      const childRec = this.records.get(childKey)
      /* v8 ignore next -- 防御分支：声明必然会创建记录 */
      if (!childRec) continue
      const doomed = childRec.entries
      childRec.spec = undefined
      childRec.declaredBy = undefined
      childRec.parent = undefined
      childRec.declarationEpoch += 1
      childRec.entries = NO_ENTRIES
      this.markDirty(childKey, childRec)
      this.notifyDeclaration(childRec)
      for (const dead of doomed) this.releaseEntry(dead)
    }
  }

  private record(key: string): SlotRecord {
    let rec = this.records.get(key)
    if (!rec) {
      rec = {
        spec: undefined,
        declaredBy: undefined,
        parent: undefined,
        declarationEpoch: 0,
        entries: NO_ENTRIES,
        version: 0,
        listeners: new Set(),
        declarationListeners: new Set(),
      }
      this.records.set(key, rec)
    }
    return rec
  }

  private markDirty(key: string, rec: SlotRecord): void {
    rec.version += 1
    for (const fn of [...this.mutateListeners]) fn(key)
    this.dirty.add(rec)
    if (!this.flushScheduled) {
      this.flushScheduled = true
      queueMicrotask(() => { this.flush() })
    }
  }

  private notifyDeclaration(rec: SlotRecord): void {
    for (const fn of [...rec.declarationListeners]) fn()
  }

  private flush(): void {
    // 迭代前先重置，使监听器内部发生的变更可以重新安排 flush。
    this.flushScheduled = false
    const dirty = [...this.dirty]
    this.dirty.clear()
    for (const rec of dirty) {
      for (const fn of [...rec.listeners]) fn()
    }
  }
}
