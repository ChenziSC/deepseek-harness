/**
 * Session 标准 props provide 通道：管理 provider 清单、bundle 实例化（存在未声明、
 * 缺失或重复成员时明确失败）、静态无 session 投影，以及当前 session 的原子投影
 * observable。这里只有一套实现：SessionRuntime 以传输事实驱动，测试 runtime 的
 * sessions 替身以 fixture 驱动，因此生产环境和测试台之间的实例化规则、投影语义
 * 不会漂移。
 */
import type { HostObservable, SessionMaybeProvideInfo, SessionProvideInfo } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionBinding, SessionProvideDescriptor } from './service.ts'

/** 所有者侧钩子：通道据此访问所有者的实时 bundles 和当前选择。 */
export interface SessionProvideChannelHost {
  /**
   * 按新清单重新实例化所有已有 bundle，对每个活跃 binding 调用
   * {@link SessionProvideChannel.materializeInfo}。延迟实例化的 sessions 会在首次解析时
   * 使用新清单。
   */
  rebuildBundles(): void
  /** 解析当前选择的 bundle，即所有者的 maybe-provide 查询。 */
  resolveCurrent(): SessionMaybeProvideInfo
}

/**
 * Provider 清单、实例化和当前投影。通道拥有 provider 贡献项必须满足的全部规则；
 * 所有者只保留每 session bundle 存储以及“当前项”的定义。
 */
export class SessionProvideChannel {
  private readonly providers: SessionProvideDescriptor[] = []
  private maybeInfoCache: SessionMaybeProvideInfo
  /** 最近发布的当前 bundle；通过身份比较去除重复发布。 */
  private currentSnapshot: SessionMaybeProvideInfo
  /** 投影订阅者。这里使用普通 cell，因为 bundles 持有活跃 session 源，不能被 store 冻结。 */
  private readonly listeners = new Set<() => void>()

  /**
   * 当前 session 的原子 provide 投影：选择变化和 provider 清单变化都通过同一来源发布，
   * 因此当前 ID 不变时的清单变化也会重新发布 bundle，不会让已挂载条目停留在旧状态。
   */
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>

  /**
   * @param host - 所有者侧 bundle 存储和当前选择解析器。
   */
  constructor(private readonly host: SessionProvideChannelHost) {
    // Runtime 自身贡献项最先加入：useSession 与所有插件共用同一 provide 通道，渲染器
    // 没有特殊路径。
    this.providers.push({
      hooks: ['session'],
      resolve: binding => ({ hooks: { session: binding.session } }),
    })
    this.maybeInfoCache = this.materializeMaybeInfo()
    this.currentSnapshot = this.maybeInfoCache
    this.currentProvideInfo = {
      getSnapshot: () => this.currentSnapshot,
      subscribe: (fn) => {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
    }
  }

  /** 当前清单下的静态无 session 投影：已声明名称存在，但值为 undefined。 */
  get maybeInfo(): SessionMaybeProvideInfo {
    return this.maybeInfoCache
  }

  /**
   * 注册每 session 的标准 props provider，产品约定见 SessionRuntime.provide。实时
   * bundles 会立即重建；声明错误的 provider 在注册边界明确失败并回滚，因此通道不会
   * 停留在无法实例化的清单上。
   * @param descriptor - 静态成员清单和每 session resolver。
   * @returns 移除 provider 的 disposer。
   */
  provide(descriptor: SessionProvideDescriptor): () => void {
    this.providers.push(descriptor)
    try {
      this.applyRosterChange()
    } catch (error) {
      this.providers.splice(this.providers.indexOf(descriptor), 1)
      // 恢复上一份有效清单的 bundles；该清单此前已经成功实例化，恢复过程不应再抛错。
      this.applyRosterChange()
      throw error
    }
    return () => {
      const at = this.providers.indexOf(descriptor)
      if (at >= 0) this.providers.splice(at, 1)
      this.applyRosterChange()
    }
  }

  /**
   * 重新推导当前选择的 bundle，并在变化时发布。每次 (scope, roster) 实例化得到的
   * bundle 身份稳定，因此身份比较足够准确。这里同步通知；调用处（所有者列表订阅、
   * provide()）本身已经位于各自批处理或注册边界之后。
   */
  publishCurrent(): void {
    const next = this.host.resolveCurrent()
    if (next === this.currentSnapshot) return
    this.currentSnapshot = next
    for (const fn of [...this.listeners]) {
      try {
        fn()
      } catch (error) {
        // 隔离订阅者失败：本通知在列表通知内部运行，若渲染侧订阅者抛错，会使后续
        // 监听器收不到通知，并中止安排本次通知的投影过程。
        console.error('sessions.currentProvideInfo subscriber failed:', error)
      }
    }
  }

  /**
   * 为一个 session 实例化标准 props bundle；成员名未声明、缺失或重复时明确失败。
   * @param binding - 传给每个 resolver 的 session 组装 handle。
   * @returns 已实例化 bundle；下次实例化前身份稳定。
   */
  materializeInfo(binding: SessionBinding): SessionProvideInfo {
    const hooks: Record<string, HostObservable<unknown>> = {}
    const props: Record<string, unknown> = {}
    for (const descriptor of this.providers) {
      const contribution = descriptor.resolve(binding)
      const contributedHooks = contribution.hooks ?? {}
      const contributedProps = contribution.props ?? {}
      for (const name of Object.keys(contributedHooks)) {
        if (!(descriptor.hooks ?? []).includes(name)) {
          throw new Error(`sessions.provide: undeclared hook "${name}"`)
        }
      }
      for (const name of Object.keys(contributedProps)) {
        if (!(descriptor.props ?? []).includes(name)) {
          throw new Error(`sessions.provide: undeclared prop "${name}"`)
        }
      }
      for (const name of descriptor.hooks ?? []) {
        const source = contributedHooks[name]
        if (source === undefined) throw new Error(`sessions.provide: missing hook "${name}"`)
        if (Object.hasOwn(hooks, name)) throw new Error(`sessions.provide: duplicate hook "${name}"`)
        hooks[name] = source
      }
      for (const name of descriptor.props ?? []) {
        if (!Object.hasOwn(contributedProps, name)) throw new Error(`sessions.provide: missing prop "${name}"`)
        if (Object.hasOwn(props, name)) throw new Error(`sessions.provide: duplicate prop "${name}"`)
        props[name] = contributedProps[name]
      }
    }
    return {
      sessionId: binding.sessionId,
      hooks,
      props,
      // useProjection 席位：从 session 投影 store 按键取得裸值接口。键空间开放，因此
      // 它绝不会是静态清单成员。
      projections: { faceOf: key => binding.session.projections.faceOf(key) },
    }
  }

  /** 重建静态投影和所有者的实时 bundles，再重新发布当前项。 */
  private applyRosterChange(): void {
    this.maybeInfoCache = this.materializeMaybeInfo()
    this.host.rebuildBundles()
    this.publishCurrent()
  }

  /** 构建静态无 session 工具组，并拒绝重复声明名称。 */
  private materializeMaybeInfo(): SessionMaybeProvideInfo {
    const hooks: Record<string, undefined> = {}
    const props: Record<string, undefined> = {}
    for (const descriptor of this.providers) {
      for (const name of descriptor.hooks ?? []) {
        if (Object.hasOwn(hooks, name)) throw new Error(`sessions.provide: duplicate hook "${name}"`)
        hooks[name] = undefined
      }
      for (const name of descriptor.props ?? []) {
        if (Object.hasOwn(props, name)) throw new Error(`sessions.provide: duplicate prop "${name}"`)
        props[name] = undefined
      }
    }
    return { sessionId: undefined, hooks, props } // 无 projections 接口：没有 session 时所有键都读取为不存在。
  }
}
