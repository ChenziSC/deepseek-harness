/**
 * 声明式 slot 的 React 渲染器。每配置项绑定负责执行子项授权，配置项边界负责隔离
 * 注册方失败。
 */
import { Component, useMemo, useState, useSyncExternalStore, type FC, type ReactNode } from 'react'
import {
  SlotOwnershipError, StaleAuthorizationError,
  type ChainRenderOpts, type HostObservable, type LocaleFace, type RenderOpts,
  type SessionMaybeProvideInfo, type SessionProvideInfo, type SlotRenderer, type SlotRendererHost,
  type SlotScope, type StoredEntry, type Translate,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  HostContext, SessionMaybeProvider, SessionProvider, SlotAssemblyError, maybeObservableHook,
  observableHook, projectionHook, useHost, useSessionMaybeProvideInfo,
} from './session-provider.tsx'

type InjectedProps = Record<string, unknown>

type SlotHookFactory = (standard: InjectedProps, hookContext: unknown) => unknown
type SlotHookFactories = Readonly<Record<string, SlotHookFactory>>

interface BoundSlotInject {
  readonly props: InjectedProps
  readonly slotHookFactories?: SlotHookFactories | undefined
}

type RenderSlotBinding = (key: string, owner: object, opts?: RenderOpts) => ReactNode

type RenderSlotChainBinding = (key: string, owner: object, opts?: ChainRenderOpts) => ReactNode

/**
 * 每配置项 renderSlot 绑定。每个配置项的绑定标识稳定，避免记忆化组件因无关重渲染
 * 重新订阅；绑定与配置项一同结束。配置项 dispose 后若保留闭包仍被调用，会命中
 * ledger 存在性检查并抛错。
 */
const renderSlotCache = new WeakMap<StoredEntry, RenderSlotBinding>()

function boundRenderSlot(host: SlotRendererHost, entry: StoredEntry): RenderSlotBinding {
  let binding = renderSlotCache.get(entry)
  if (!binding) {
    binding = (key, owner, opts) => {
      if (!host.isLive(entry)) {
        throw new StaleAuthorizationError(`renderSlot('${key}') from a disposed registration`)
      }
      // 普通 JavaScript 的后备保护；类型化调用方已经收窄到已声明键。
      const declared = entry.children?.[key]
      if (declared === undefined) {
        throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`)
      }
      if (declared.kind === 'chain') {
        throw new SlotOwnershipError(`slot '${key}' is declared 'chain' — use renderSlotChain`)
      }
      return <SlotOutlet slotKey={key} ownerProps={owner} opts={opts} />
    }
    renderSlotCache.set(entry, binding)
  }
  return binding
}

/**
 * 每配置项 renderSlotChain 绑定：标识在配置项内稳定，与 renderSlot 使用相同缓存轴，
 * 每帧分发不得重建绑定，并随配置项结束。chain kind 检查是声明检查对应的普通
 * JavaScript 后备保护；类型化调用方已经收窄到 chain 键。
 */
const renderSlotChainCache = new WeakMap<StoredEntry, RenderSlotChainBinding>()

function boundRenderSlotChain(host: SlotRendererHost, entry: StoredEntry): RenderSlotChainBinding {
  let binding = renderSlotChainCache.get(entry)
  if (!binding) {
    binding = (key, owner, opts) => {
      if (!host.isLive(entry)) {
        throw new StaleAuthorizationError(`renderSlotChain('${key}') from a disposed registration`)
      }
      const declared = entry.children?.[key]
      if (declared === undefined) {
        throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`)
      }
      if (declared.kind !== 'chain') {
        throw new SlotOwnershipError(`slot '${key}' is declared '${declared.kind}', not 'chain' — use renderSlot`)
      }
      return <SlotOutlet slotKey={key} ownerProps={owner} opts={opts} />
    }
    renderSlotChainCache.set(entry, binding)
  }
  return binding
}

/**
 * inject 结果缓存：根配置项按配置项缓存，会话配置项按“配置项 × provide bundle”缓存。
 * WeakMap 键是 entry/info 对象，分别在注册和会话作用域内标识稳定，因此缓存生命周期
 * 与其记忆化值使用相同轴。
 */
const rootInjectCache = new WeakMap<StoredEntry, InjectedProps>()
const sessionInjectCache = new WeakMap<StoredEntry, WeakMap<SessionProvideInfo, InjectedProps>>()
const sessionMaybeInjectCache = new WeakMap<StoredEntry, WeakMap<SessionMaybeProvideInfo, InjectedProps>>()

const EMPTY_INJECTED_PROPS: InjectedProps = {}

function runInject(entry: StoredEntry, info: SessionMaybeProvideInfo | undefined, actions: object | undefined): InjectedProps {
  const inject = entry.inject
  if (!inject) return EMPTY_INJECTED_PROPS
  // 从声明推导位置参数：会话作用域使用 sessionId，声明存储时加入烘焙后的 actions。
  const args: unknown[] = []
  if (info !== undefined) args.push(info.sessionId)
  if (actions !== undefined) args.push(actions)
  return bindInjectHooks((inject as (...args: unknown[]) => InjectedProps)(...args))
}

/**
 * 在现有缓存轴上规范化一个配置项所有的 inject 接口。其 hooks 分区继续遵循原始的
 * 仅 Observable 约定。
 */
function bindInjectHooks(face: InjectedProps): InjectedProps {
  const sources = face['hooks']
  if (sources === undefined) return face
  const { hooks: _hooks, ...rest } = face
  const bound: InjectedProps = rest
  for (const [name, source] of Object.entries(sources as Record<string, HostObservable<unknown>>)) {
    const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
    bound[hookName] = observableHook(source)
  }
  return bound
}

const slotInjectCache = new WeakMap<object, BoundSlotInject>()
const EMPTY_SLOT_INJECT: BoundSlotInject = { props: EMPTY_INJECTED_PROPS }

/** 按稳定对象标识规范化一个分发器所有的 inject 接口。 */
function cachedSlotInject(face: object | undefined): BoundSlotInject {
  if (face === undefined) return EMPTY_SLOT_INJECT
  let bound = slotInjectCache.get(face)
  if (bound !== undefined) return bound
  const definitions = (face as InjectedProps)['hooks']
  if (definitions === undefined) {
    bound = { props: face as InjectedProps }
    slotInjectCache.set(face, bound)
    return bound
  }
  const { hooks: _hooks, ...rest } = face as InjectedProps
  const props: InjectedProps = rest
  let factories: Record<string, SlotHookFactory> | undefined
  for (const [name, definition] of Object.entries(definitions as Record<string, unknown>)) {
    const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
    if (typeof definition === 'function') {
      factories ??= {}
      factories[name] = definition as SlotHookFactory
    } else {
      props[hookName] = observableHook(definition as HostObservable<unknown>)
    }
  }
  bound = factories === undefined
    ? { props }
    : { props, slotHookFactories: factories }
  slotInjectCache.set(face, bound)
  return bound
}

/** 为一次稳定 renderSlot 调用绑定延迟执行的 slot 级工厂。 */
function bindSlotHookFactories(
  factories: SlotHookFactories,
  standard: InjectedProps,
  hookContext: unknown,
): InjectedProps {
  const hooks: InjectedProps = {}
  for (const [name, factory] of Object.entries(factories)) {
    const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
    hooks[hookName] = factory(standard, hookContext)
  }
  return hooks
}

function cachedRootInject(entry: StoredEntry, actions: object | undefined): InjectedProps {
  let props = rootInjectCache.get(entry)
  if (!props) {
    props = runInject(entry, undefined, actions)
    rootInjectCache.set(entry, props)
  }
  return props
}

function cachedSessionInject(entry: StoredEntry, info: SessionProvideInfo, actions: object | undefined): InjectedProps {
  let perInfo = sessionInjectCache.get(entry)
  if (!perInfo) {
    perInfo = new WeakMap()
    sessionInjectCache.set(entry, perInfo)
  }
  let props = perInfo.get(info)
  if (!props) {
    props = runInject(entry, info, actions)
    perInfo.set(info, props)
  }
  return props
}

function cachedSessionMaybeInject(
  entry: StoredEntry,
  info: SessionMaybeProvideInfo,
  actions: object | undefined,
): InjectedProps {
  let perInfo = sessionMaybeInjectCache.get(entry)
  if (!perInfo) {
    perInfo = new WeakMap()
    sessionMaybeInjectCache.set(entry, perInfo)
  }
  let props = perInfo.get(info)
  if (!props) {
    props = runInject(entry, info, actions)
    perInfo.set(info, props)
  }
  return props
}

/**
 * locale `t` seat 绑定，按“接口、命名空间、revision”缓存。revision 有意成为缓存键
 * 的一部分：切换 locale 会为每个命名空间创建新函数引用，使接收 `t` 的
 * `React.memo` 组件通过普通浅比较重渲染。新鲜度由标识承载，不需要额外失效通道。
 * 同一 revision 内引用保持稳定，记忆化子项不会因无关重渲染抖动。
 */
const localeSeatCache = new WeakMap<LocaleFace, Map<string, { revision: number; t: Translate }>>()

function localeSeat(face: LocaleFace, ns: string): Translate {
  let perNs = localeSeatCache.get(face)
  if (!perNs) {
    perNs = new Map()
    localeSeatCache.set(face, perNs)
  }
  const revision = face.getSnapshot().revision
  const cached = perNs.get(ns)
  if (cached && cached.revision === revision) return cached.t
  const bound = face.bind(ns)
  // 每个 revision 创建新包装函数，因为 bind() 本身可能返回稳定引用。
  const t: Translate = (key, params) => bound(key, params)
  perNs.set(ns, { revision, t })
  return t
}

const noopSubscribe = (): (() => void) => () => {}
const zeroRevision = (): number => 0

/**
 * 每接口 subscribe/getSnapshot 闭包对，按接口标识缓存。接口是所有 outlet 共享的
 * 全局数据源；subscribe 引用变化时 uSES 会重新订阅。如果每次渲染创建新闭包，
 * 每个 outlet 每次渲染都会产生一次取消订阅与重新订阅。
 */
const localeSubscriptionCache = new WeakMap<LocaleFace, {
  subscribe: (fn: () => void) => () => void
  getRevision: () => number
}>()

function localeSubscription(face: LocaleFace): { subscribe: (fn: () => void) => () => void; getRevision: () => number } {
  let cached = localeSubscriptionCache.get(face)
  if (!cached) {
    cached = {
      subscribe: fn => face.subscribe(fn),
      getRevision: () => face.getSnapshot().revision,
    }
    localeSubscriptionCache.set(face, cached)
  }
  return cached
}

/**
 * 让 outlet 订阅已安装 locale 接口的 revision。未安装时使用 0；两种情况都恰好进行
 * 一次 uSES 调用，以保持钩子顺序稳定。切换 locale 时每个 outlet 都会重渲染，
 * 配置项主体再按新 revision 重新推导 `t` seat。接口必须在首次需要它的渲染前安装，
 * 后出现的接口没有通道通知已经挂载的 outlet。
 */
function useLocaleRevision(face: LocaleFace | undefined): number {
  const subscription = face !== undefined ? localeSubscription(face) : undefined
  return useSyncExternalStore(
    subscription?.subscribe ?? noopSubscribe,
    subscription?.getRevision ?? zeroRevision,
  )
}

/**
 * 配置项边界使用的、按配置项标识生成的 React key。outlet 通过错误边界为每个位置
 * 渲染一个胜出项，包括 single/keyed/list 单元格头和 chain 选举。如果没有 key，
 * 在配置项 A 上失败的边界会跨胜出项变化继续存在，例如重新选举、退出后的遮蔽回退、
 * HMR 重新注册，进而继续遮蔽健康的配置项 B。按配置项标识设置 key，可在胜出项变化
 * 时重新挂载全新边界；配置项在一次注册内标识稳定，因此同一胜出项期间 key 稳定。
 */
let nextEntryKey = 0
const entryKeys = new WeakMap<StoredEntry, number>()

function entryKeyOf(entry: StoredEntry): number {
  let key = entryKeys.get(entry)
  if (key === undefined) {
    key = nextEntryKey++
    entryKeys.set(entry, key)
  }
  return key
}

/**
 * 按配置项隔离：一个注册方在组件渲染或 inject 工厂中崩溃，不得拖垮同级项。装配
 * 错误（例如提供方缺失）会重新抛出；接线错误的 shell 必须明确失败，不能降级为回退。
 * 每次捕获都通过 ledger 的监督 seam `onEntryError` 报告。对支持遮蔽的 kind，报告
 * 会使配置项退出，outlet 重新渲染该单元格的下一个存活项；边界崩溃界面只显示到
 * 重渲染落地。单元格耗尽时则永久显示，此后崩溃界面归 outlet 所有。
 */
class SlotErrorBoundary extends Component<
  { slotKey: string; onEntryError: (error: unknown) => void; children: ReactNode }, { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError(error: unknown): { failed: boolean } {
    if (error instanceof SlotAssemblyError) throw error
    return { failed: true }
  }
  override componentDidCatch(error: unknown): void {
    console.error(`slot entry crashed in '${this.props.slotKey}':`, error)
    this.props.onEntryError(error)
  }
  override render(): ReactNode {
    if (this.state.failed) return <div data-slot-error={this.props.slotKey} />
    return this.props.children
  }
}

interface StandardPropsCache {
  readonly root: InjectedProps
  readonly session: WeakMap<SessionMaybeProvideInfo, InjectedProps>
  readonly sessionMaybe: WeakMap<SessionMaybeProvideInfo, InjectedProps>
}

const standardPropsCache = new WeakMap<SlotRendererHost, StandardPropsCache>()

/** 上下文 Hook 工厂使用的稳定官方属性对象。 */
function standardProps(
  host: SlotRendererHost,
  scope: SlotScope,
  info: SessionMaybeProvideInfo | undefined,
): InjectedProps {
  let cache = standardPropsCache.get(host)
  if (cache === undefined) {
    cache = {
      root: {
        useSessions: observableHook(host.sessions.list),
        useWorkspaces: observableHook(host.workspaces.list),
      },
      session: new WeakMap(),
      sessionMaybe: new WeakMap(),
    }
    standardPropsCache.set(host, cache)
  }
  if (scope === 'root') return cache.root
  if (info === undefined) throw new SlotAssemblyError(`scope '${scope}' rendered without session provide info`)
  const byInfo = scope === 'session' ? cache.session : cache.sessionMaybe
  let standard = byInfo.get(info)
  if (standard !== undefined) return standard
  standard = { ...cache.root }
  for (const [name, source] of Object.entries(info.hooks)) {
    const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
    if (scope === 'session-maybe') {
      standard[hookName] = maybeObservableHook(source)
    } else {
      if (source === undefined) throw new SlotAssemblyError(`strict session hook '${name}' has no source`)
      standard[hookName] = observableHook(source)
    }
  }
  Object.assign(standard, info.props)
  standard['sessionId'] = info.sessionId
  standard['useProjection'] = projectionHook(info)
  byInfo.set(info, standard)
  return standard
}

/**
 * 两种 scope 分支共用的标准工具包合成：全局 useSessions/useWorkspaces 钩子；
 * 每会话 provide bundle，其中每个 `hooks` 数据源转换为 `use<Name>` 选择器钩子，
 * useSession 只是 runtime 自身的 `session` 贡献，无需特例，`props` 则原样展开；
 * 已声明时加入存储对；声明 children 时加入 renderSlot 绑定；children 声明会话作用域
 * slot 时加入 SessionProvider seat。宿主只交付裸可观察数据源，钩子不会跨越宿主约定；
 * 所有钩子都在这里绑定并由 observableHook 按数据源缓存，因此每次渲染展开新的工具包
 * 对象不会使子项订阅抖动。
 */
function standardKit(
  host: SlotRendererHost,
  entry: StoredEntry,
  scope: SlotScope,
  info: SessionMaybeProvideInfo | undefined,
): {
  kit: InjectedProps
  standard: InjectedProps
  actions: object | undefined
} {
  const standard = standardProps(host, scope, info)
  const kit: InjectedProps = { ...standard }
  if (entry.locale !== undefined) {
    const face = host.locale
    // 明确的装配失败：locale 属于 immediately 层基础设施，声明命名空间但没有安装接口
    // 表示组合接线错误。
    if (face === undefined) {
      throw new SlotAssemblyError(
        `entry declares locale namespace '${entry.locale}' but no locale face is installed (locale plugin missing from the composition?)`)
    }
    kit['t'] = localeSeat(face, entry.locale)
  }
  const store = scope === 'session-maybe' && info?.sessionId === undefined
    ? undefined
    : host.storeOf(entry, info?.sessionId)
  if (store !== undefined) {
    // 实例本身就是遵循 getSnapshot/subscribe 约定的可观察快照数据源；useStore 钩子
    // 在这里绑定并按实例缓存。
    kit['useStore'] = observableHook(store)
    kit['actions'] = store.actions
  }
  if (entry.children !== undefined) {
    kit['renderSlot'] = boundRenderSlot(host, entry)
    // renderSlotChain 使用相同声明真源；只有 children 包含 chain kind slot 的配置项
    // 才会收到 chain 分发 seat。
    if (Object.values(entry.children).some(spec => spec.kind === 'chain')) {
      kit['renderSlotChain'] = boundRenderSlotChain(host, entry)
    }
    // SessionProvider 标准 seat：声明会话作用域子项的配置项负责渲染会话区域，因此
    // 框架向其提供已自行接线的 provider。模块级组件可保持稳定引用，且不需要值导入。
    if (Object.values(entry.children).some(spec => spec.scope === 'session')) {
      kit['SessionProvider'] = SessionProvider
    }
  }
  return { kit, standard, actions: store?.actions }
}

/**
 * 一个已渲染配置项由标准工具包、缓存的配置项 inject、公共 slot inject 和所有方属性
 * 组成，冲突时所有方属性优先。各部分在渲染边界擦除类型；注册与 renderSlot seam
 * 已经证明其约定。
 */
function ContextualEntry({
  slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext,
}: {
  slotKey: string
  Comp: FC<InjectedProps>
  kit: InjectedProps
  standard: InjectedProps
  injected: InjectedProps
  slotInjected: BoundSlotInject & { readonly slotHookFactories: SlotHookFactories }
  ownerProps: object
  hookContext: unknown
  hasHookContext: boolean
}) {
  const contextual = useMemo(
    () => {
      if (!hasHookContext) {
        throw new SlotAssemblyError(`slot '${slotKey}' has contextual injected Hooks but no hookContext`)
      }
      return bindSlotHookFactories(slotInjected.slotHookFactories, standard, hookContext)
    },
    [hasHookContext, hookContext, slotInjected.slotHookFactories, slotKey, standard],
  )
  return <Comp {...kit} {...injected} {...slotInjected.props} {...contextual} {...ownerProps} />
}

function renderEntry(
  slotKey: string,
  Comp: FC<InjectedProps>,
  kit: InjectedProps,
  standard: InjectedProps,
  injected: InjectedProps,
  slotInjected: BoundSlotInject,
  ownerProps: object,
  hookContext: unknown,
  hasHookContext: boolean,
): ReactNode {
  if (slotInjected.slotHookFactories === undefined) {
    return <Comp {...kit} {...injected} {...slotInjected.props} {...ownerProps} />
  }
  return (
    <ContextualEntry
      slotKey={slotKey}
      Comp={Comp}
      kit={kit}
      standard={standard}
      injected={injected}
      slotInjected={slotInjected as BoundSlotInject & { readonly slotHookFactories: SlotHookFactories }}
      ownerProps={ownerProps}
      hookContext={hookContext}
      hasHookContext={hasHookContext}
    />
  )
}

function SessionEntry({ entry, ownerProps, info, slotKey, slotInjected, hookContext, hasHookContext }: {
  entry: StoredEntry
  ownerProps: object
  info: SessionProvideInfo
  slotKey: string
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
}) {
  const host = useHost()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, standard, actions } = standardKit(host, entry, 'session', info)
  const injected = cachedSessionInject(entry, info, actions)
  return renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext)
}

function SessionMaybeEntryBody({ entry, ownerProps, info, slotKey, slotInjected, hookContext, hasHookContext }: {
  entry: StoredEntry
  ownerProps: object
  info: SessionMaybeProvideInfo
  slotKey: string
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
}) {
  const host = useHost()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, standard, actions } = standardKit(host, entry, 'session-maybe', info)
  const injected = cachedSessionMaybeInject(entry, info, actions)
  return renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext)
}

/**
 * session-maybe 标识只支持接管，不存在永久保持标识模式。从无会话状态创建的
 * incarnation 会接管首个到达的会话：在 undefined → 首个 id 这次转换中标识保持
 * 不变，使空白 shell 的 DOM 在会话出现时继续存在。此后配置项与严格会话配置项行为
 * 完全相同：切换到不同会话会重新挂载，防止组件局部状态跨会话泄漏；退回无会话也会
 * 重新挂载为新的空白 incarnation，之后可以再次接管。
 *
 * 因此每会话组件局部状态会由结构保证清理。需要跨切换保留的状态必须位于会话绑定
 * 数据源，例如 machine、store 或 hooks；既有分层规则在此承担实际正确性责任。
 */
function SessionMaybeEntry({ entry, ownerProps, slotKey, slotInjected, hookContext, hasHookContext }: {
  entry: StoredEntry
  ownerProps: object
  slotKey: string
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
}) {
  const info = useSessionMaybeProvideInfo()
  // 子项 key 是 incarnation 计数器，不是会话 id；接管必须在 undefined → 首个 id
  // 期间保持 key 不变。记录位于这个稳定且无 key 的包装层，并使用渲染阶段 setState
  // 形式。这是 React 允许的派生状态模式：同一组件渲染期间 setState 会在子项挂载前
  // 额外渲染一次，保护条件保证过程收敛并兼容 StrictMode。
  const [state, setState] = useState<MaybeIncarnation>(FIRST_INCARNATION)
  let { adopted, epoch } = state
  if (info.sessionId !== undefined && adopted === undefined) {
    // 接管：epoch 不变，不重新挂载。
    adopted = info.sessionId
    setState({ adopted, epoch })
  } else if (adopted !== undefined && info.sessionId !== undefined && info.sessionId !== adopted) {
    // 接管后的会话切换：进入下一个 incarnation，创建时已完成接管。
    adopted = info.sessionId
    epoch += 1
    setState({ adopted, epoch })
  } else if (adopted !== undefined && info.sessionId === undefined) {
    // 回到无会话：进入下一个空白 incarnation，之后可重新接管。
    adopted = undefined
    epoch += 1
    setState({ adopted, epoch })
  }
  return (
    <SessionMaybeEntryBody
      key={epoch}
      entry={entry}
      ownerProps={ownerProps}
      info={info}
      slotKey={slotKey}
      slotInjected={slotInjected}
      hookContext={hookContext}
      hasHookContext={hasHookContext}
    />
  )
}

/** 一个 session-maybe outlet 的接管记录，见 SessionMaybeEntry。 */
interface MaybeIncarnation {
  /** 本 incarnation 接管的会话；处于初始空白且尚未接管时为 undefined。 */
  readonly adopted: string | undefined
  /** incarnation 计数器，也是子项 key；仅在一个 incarnation 结束时递增。 */
  readonly epoch: number
}

const FIRST_INCARNATION: MaybeIncarnation = { adopted: undefined, epoch: 0 }

function RootEntry({ entry, ownerProps, slotKey, slotInjected, hookContext, hasHookContext }: {
  entry: StoredEntry
  ownerProps: object
  slotKey: string
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
}) {
  const host = useHost()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, standard, actions } = standardKit(host, entry, 'root', undefined)
  const injected = cachedRootInject(entry, actions)
  return renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext)
}

function StrictSessionEntry({ slotKey, entry, ownerProps, slotInjected, hookContext, hasHookContext, onEntryError }: {
  slotKey: string
  entry: StoredEntry
  ownerProps: object
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
  onEntryError: (error: unknown) => void
}) {
  const info = useSessionMaybeProvideInfo()
  if (info.sessionId === undefined) return null
  // 每会话重新挂载使用此 key；每配置项重新挂载使用外层元素的配置项标识 key，
  // 即 outlet 的 guarded() 调用。
  return (
    <SlotErrorBoundary slotKey={slotKey} key={info.sessionId} onEntryError={onEntryError}>
      <SessionEntry
        entry={entry}
        ownerProps={ownerProps}
        info={info as SessionProvideInfo}
        slotKey={slotKey}
        slotInjected={slotInjected}
        hookContext={hookContext}
        hasHookContext={hasHookContext}
      />
    </SlotErrorBoundary>
  )
}

/**
 * 所有 outlet 包装层共享的锚点样式。`display:contents` 让包装层不参与布局，使
 * grid/flex 父级直接看到 slot 子项，因此锚点只提供可寻址接口。模块级常量保持稳定
 * 引用，使包装层无需比较 style 属性变化。
 */
const ANCHOR_STYLE = { display: 'contents' } as const

function SlotOutlet({ slotKey, ownerProps, opts }: {
  slotKey: string
  ownerProps: object
  opts?: (RenderOpts & ChainRenderOpts) | undefined
}) {
  const host = useHost()
  // version 推进驱动重新读取 entries()；宿主按微任务批处理。
  useSyncExternalStore(
    fn => host.subscribe(slotKey, fn),
    () => host.getVersion(slotKey),
  )
  // locale revision 推进：切换 locale 会重渲染每个 outlet，配置项主体再按新 revision
  // 重新推导具有新标识的 `t` seat。
  useLocaleRevision(host.locale)
  const sessionInfo = useSessionMaybeProvideInfo()
  // 锚点约定：每个 slot 渲染位置都公开稳定的 `[data-slot="<key>"]` 包装层，作为
  // 动态样式可寻址 seam 的目标；`display:contents` 使其不影响布局。包装层属于 outlet
  // 而非分发结果，回退、崩溃界面和未声明空状态都在其中渲染，因此锚点不会随注册变动
  // 忽隐忽现。
  return (
    <div data-slot={slotKey} style={ANCHOR_STYLE}>
      {renderOutletContent(host, slotKey, ownerProps, opts, sessionInfo)}
    </div>
  )
}

/** outlet 锚点内部的 kind 分发，包括 single、keyed、list、chain、回退和崩溃界面。 */
function renderOutletContent(
  host: SlotRendererHost,
  slotKey: string,
  ownerProps: object,
  opts: (RenderOpts & ChainRenderOpts) | undefined,
  sessionInfo: SessionMaybeProvideInfo,
): ReactNode {
  const spec = host.specOf(slotKey)
  // 未声明或已撤销声明的键渲染为空。声明配置项卸载时，slot 会回到未声明状态，但保留
  // 元素可能仍已挂载；这是自然空状态，不是所有权失败。
  if (!spec) return null
  const strictSessionAbsent = spec.scope === 'session' && sessionInfo.sessionId === undefined
  if (strictSessionAbsent && (spec.kind !== 'chain' || !opts?.overlay)) {
    return <>{opts?.fallback ?? null}</>
  }
  // 缺少严格会话的 overlay chain 走普通空选举路径，使 Fragment/回退包装层结构在
  // 会话到达前后保持一致。
  const entries = strictSessionAbsent ? [] : host.entriesOf(slotKey)
  const slotInjected = cachedSlotInject(spec.inject)

  // 边界必须包装配置项元素，不能位于其内部。inject 工厂和工具包合成都在配置项主体
  // 运行，失败必须落入每配置项回退，不能逃逸到上层树。
  const guarded = (entry: StoredEntry, key?: string | number, owner: object = ownerProps) => {
    const hasHookContext = opts !== undefined && Object.hasOwn(opts, 'hookContext')
    const hookContext = opts?.hookContext
    // 支持遮蔽的 kind 崩溃后退出，单元格回退到下一个存活项。chain 只报告而不退出，
    // 因为选举备选项在 select 时解析；让已选中但崩溃的项退役会改变静态崩溃界面。
    const onEntryError = (error: unknown) => {
      host.reportEntryError(slotKey, entry, error, { abdicate: spec.kind !== 'chain' })
    }
    return spec.scope === 'session'
      ? (
        <StrictSessionEntry
          slotKey={slotKey}
          entry={entry}
          ownerProps={owner}
          slotInjected={slotInjected}
          hookContext={hookContext}
          hasHookContext={hasHookContext}
          onEntryError={onEntryError}
          key={key}
        />
      )
      : (
        <SlotErrorBoundary slotKey={slotKey} key={key} onEntryError={onEntryError}>
          {spec.scope === 'session-maybe'
            ? (
              <SessionMaybeEntry
                entry={entry}
                ownerProps={owner}
                slotKey={slotKey}
                slotInjected={slotInjected}
                hookContext={hookContext}
                hasHookContext={hasHookContext}
              />
            )
            : (
              <RootEntry
                entry={entry}
                ownerProps={owner}
                slotKey={slotKey}
                slotInjected={slotInjected}
                hookContext={hookContext}
                hasHookContext={hasHookContext}
              />
            )}
        </SlotErrorBoundary>
      )
  }
  // 所有注册项都退出的单元格继续显示崩溃界面。遮蔽回退已耗尽存活项，这属于失败状态，
  // 不是所有方的自然空回退。
  const deadCell = () => <div data-slot-error={slotKey} />

  if (spec.kind === 'single') {
    const entry = host.entriesOfSlot(slotKey)[0]
    if (!entry) return entries.length > 0 ? deadCell() : <>{opts?.fallback ?? null}</>
    return guarded(entry, entryKeyOf(entry))
  }
  if (spec.kind === 'keyed') {
    const entry = host.entriesOfSlot(slotKey).find(e => e.options.key === opts?.entryKey)
    if (!entry) {
      const occupied = entries.some(e => e.options.key === opts?.entryKey)
      return occupied ? deadCell() : <>{opts?.fallback ?? null}</>
    }
    return guarded(entry, entryKeyOf(entry))
  }
  if (spec.kind === 'chain') {
    // 配置项从 ledger 到达时已按优先级排序；核心在 register 时排序，相同值保持注册
    // 顺序。选择器是只依赖所有方属性的纯函数，属于 register 接口约定，因此每次渲染
    // 都能执行无挂载副作用的路由：首个非 null 选举项负责渲染，拒绝项从不挂载。
    let elected: ReactNode = null
    for (const entry of entries) {
      let matched: unknown
      try {
        // SlotCore register 已校验 chain 配置项始终携带 select。
        matched = (entry.select as (owner: object) => unknown)(ownerProps)
      } catch (error) {
        // 选择器抛错表示注册方违反约定，因为 select 必须为纯函数且对所有输入有定义。
        // 但它运行时配置项的 SlotErrorBoundary 尚不存在；若不隔离会使整个所有方区域
        // 黑屏。因此将其降级为拒绝：chain 和回退保持可用，并像配置项崩溃一样报告违约。
        console.error(
          `chain selector crashed in '${slotKey}' (${entry.registrant ?? 'unknown registrant'}), treating as declined:`,
          error)
        continue
      }
      if (matched !== null) {
        elected = guarded(entry, entryKeyOf(entry), { ...ownerProps, matched })
        break
      }
    }
    if (opts?.overlay) {
      // overlay chain（ChainRenderOpts.overlay）在选举期间继续挂载回退内容。隐藏时
      // 使用内联 display:none，优先于作者 CSS；显示时使用 display:contents，使包装层
      // 永不影响所有方布局。包装层树位置恒定，因此 React 会进行协调而非重新挂载，
      // 回退状态可跨接管保留。
      return (
        <>
          <div
            data-chain-overlay-fallback={slotKey}
            style={{ display: elected === null ? 'contents' : 'none' }}
          >
            {opts.fallback ?? null}
          </div>
          {elected}
        </>
      )
    }
    return elected ?? <>{opts?.fallback ?? null}</>
  }
  // list 中每个 id 单元格对应一行：显示单元格的遮蔽胜出项；所有项都退出后显示崩溃
  // 界面，耗尽单元格不得静默丢行。行顺序以注册顺序为基础，再按显式 order 细分，
  // 并可选按 id 筛选，与引入遮蔽前一致。
  const winners = host.entriesOfSlot(slotKey)
  const rows: { entry: StoredEntry | undefined; id: string | undefined; order: number }[] = winners.map(entry => ({
    entry,
    id: entry.options.id,
    order: entry.options.order ?? 0,
  }))
  const rowIds = new Set(rows.map(row => row.id))
  for (const entry of entries) {
    if (rowIds.has(entry.options.id)) continue
    rowIds.add(entry.options.id)
    // 耗尽单元格按单元格头声明的 order 固定其行位置。
    rows.push({ entry: undefined, id: entry.options.id, order: entry.options.order ?? 0 })
  }
  let list = [...rows].sort((a, b) => a.order - b.order)
  if (opts?.only !== undefined) list = list.filter(item => item.id === opts.only)
  if (list.length === 0) return <>{opts?.fallback ?? null}</>
  // 胜出行按配置项标识设置 key，见 entryKeyOf；耗尽单元格行按 id 设置 key。互斥前缀
  // 防止两个命名空间冲突。
  return (
    <>
      {list.map((item, i) => item.entry !== undefined
        ? guarded(item.entry, `e${entryKeyOf(item.entry)}`)
        : <div data-slot-error={slotKey} key={`x${item.id ?? i}`} />)}
    </>
  )
}

/** 根 outlet：shell 唯一的 ctx 级渲染入口。未注册的 `root` 表示启动顺序失败，绝不静默留白。 */
function RootOutlet({ ownerProps }: { ownerProps: object }) {
  const host = useHost()
  useSyncExternalStore(
    fn => host.subscribe('root', fn),
    () => host.getVersion('root'),
  )
  useLocaleRevision(host.locale)
  const entry = host.entriesOfSlot('root')[0]
  if (!entry) {
    // 注册项存在但全部退出，说明遮蔽回退已经耗尽，因此用崩溃界面替换树。“已注册但
    // 损坏”属于崩溃，不是下方的启动顺序装配失败。
    if (host.entriesOf('root').length > 0) return <div data-slot-error="root" />
    throw new SlotAssemblyError("renderSlot('root') before any 'root' registration (boot order)")
  }
  // 与 SlotOutlet 使用相同锚点约定：`root` 与其他 slot 相同，display:contents 使
  // 包装层不参与 shell 布局。
  return (
    <div data-slot="root" style={ANCHOR_STYLE}>
      <SlotErrorBoundary
        slotKey="root"
        key={entryKeyOf(entry)}
        onEntryError={(error) => { host.reportEntryError('root', entry, error, { abdicate: true }) }}
      >
        <RootEntry
          entry={entry}
          ownerProps={ownerProps}
          slotKey="root"
          slotInjected={EMPTY_SLOT_INJECT}
          hookContext={undefined}
          hasHookContext={false}
        />
      </SlotErrorBoundary>
    </div>
  )
}

/**
 * 创建由 shell 安装到 runtime SlotRegistry 的渲染器。启动时调用
 * ctx.slots.install(createSlotRenderer())；服务所有 install/renderSlot 约定，
 * 并负责重复安装或尚未安装时抛错。
 * @returns 渲染器。
 */
export function createSlotRenderer(): SlotRenderer {
  return {
    renderRoot(host, ownerProps) {
      return (
        <HostContext.Provider value={host}>
          <SessionMaybeProvider>
            <RootOutlet ownerProps={ownerProps} />
          </SessionMaybeProvider>
        </HostContext.Provider>
      )
    },
  }
}
