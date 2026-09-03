/**
 * LLM Service：提供 Adapter 注册表和可由 Waterfall 拦截的流式调用 API。导出默认的
 * `LlmRuntime`、供 Provider 后端实现的抽象 `LlmAdapter`，以及组装 Chunk 的
 * `BlockAssembler`。DeepSeek、pi-ai 或 Replay 插件把 Adapter 注册到 Provider 名称；
 * AgentLoop 只提交统一请求，不依赖具体 SDK 或 HTTP 协议。
 *
 * @module @deepseek-ai/dsh-llm
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  GenerateOptions,
  LlmConfigurableProvider,
  LlmDiscoveredModel,
  LlmFailure,
  LlmModelContext,
  LlmModelDiscoveryRequest,
  LlmModelInfo,
  LlmResolvedModelInfo,
  LlmProviderInfo,
  ModelModality,
  StreamChunk,
} from './types.ts'
import { freezeMessage, type Message } from './message.ts'
import { resolveRetryPolicy } from './retry-policy.ts'
import type { ResolvedRetryPolicy } from './retry-policy.ts'
import type { ProviderRequestId } from './brand.ts'
import { callConfigEquals, deepFreeze } from './call-config.ts'
import type { LlmCallConfig, LlmCallConfigAdapterDefaults } from './call-config.ts'
import { HarnessError, INVALID_CREDENTIAL_CODE } from './error.ts'
import { normalizeLlmFailure } from './adapter-failure.ts'
import { normalizeApiKey } from './api-key.ts'
import { contentHasImage, projectImagesForTextModel } from './content.ts'

export * from './attribution.ts'
export * from './brand.ts'
export * from './never.ts'
export * from './error.ts'
export * from './api-key.ts'
export * from './types.ts'
export * from './content.ts'
export * from './message.ts'
export * from './retry-policy.ts'
export { BlockAssembler } from './assembler.ts'
export { callConfigEquals, deepFreeze, isAgentLoopRequest, markAgentLoopRequest } from './call-config.ts'
export type { LlmCallConfig, LlmCallConfigAdapterDefaults } from './call-config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmRuntime
  }

  interface Events {
    /**
     * Waterfall around every streaming model call (retry, replay, routing).
     * Bound to the {@link LlmRuntime}; call `next()` to reach the resolved
     * adapter's stream, or yield your own chunks to short-circuit.
     * @param options - the full request. A LOOP-built request carries the
     *   process-local {@link markAgentLoopRequest} identity and arrives deep-frozen
     *   (mutation throws): its content is a pure function of the session log (the
     *   reconstructability Agent Note), so listeners read it, never rewrite it.
     *   Hand-built calls do not carry that marker; their messages already obey
     *   the immutable creation contract.
     * @mode waterfall
     */
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>

  }
}

/** Structured provider facts and cause accepted by {@link LlmError}. */
export interface LlmErrorOptions extends ErrorOptions {
  /** Valid HTTP status observed at the provider boundary. */
  status?: number
  /** Positive finite provider-requested delay in milliseconds. */
  providerRetryAfterMs?: number
  /** Non-empty opaque provider request id. */
  requestId?: ProviderRequestId
}

/**
 * Typed error for LLM-related failures. Extends {@link HarnessError}, so the
 * `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
 */
export class LlmError extends HarnessError {
  /** Serializable facts retained beside this live Error. */
  readonly failure: LlmFailure

  /**
   * @param message - non-empty human-readable failure summary.
   * @param code - non-empty stable provider-neutral machine code.
   * @param options - optional cause and validated serializable provider facts.
   */
  constructor(message: string, code: string, options?: LlmErrorOptions) {
    if (typeof message !== 'string' || message.length === 0) throw new Error('LlmError message must be a non-empty string')
    if (typeof code !== 'string' || code.length === 0) throw new Error('LlmError code must be a non-empty string')
    if (options?.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) {
      throw new Error('LlmError status must be an integer from 100 through 599')
    }
    if (options?.providerRetryAfterMs !== undefined
      && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) {
      throw new Error('LlmError providerRetryAfterMs must be a positive finite number')
    }
    if (options?.requestId !== undefined
      && (typeof options.requestId !== 'string' || options.requestId.length === 0)) {
      throw new Error('LlmError requestId must be a non-empty string')
    }
    super(message, code, options)
    this.name = 'LlmError'
    this.failure = Object.freeze({
      message,
      code,
      ...options?.status === undefined ? {} : { status: options.status },
      ...options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
      ...options?.requestId === undefined ? {} : { requestId: options.requestId },
    })
  }
}

/**
 * Accept one supplied credential, or refuse it as unusable.
 *
 * A stored key arrives from the credentials seam, a `.env` line, or a shell
 * export, all of which pick up surrounding whitespace, so trimming is silent.
 * Anything else fails here rather than inside `fetch`, whose ByteString
 * refusal names a UTF-16 code point instead of the setting to change. The key
 * never enters the message: `ref` names where to fix it, and echoing any part
 * of a secret into a log or a UI is the failure this diagnosis avoids.
 *
 * Lives beside {@link LlmError} rather than in `./api-key.ts` so the predicate
 * module stays dependency-free; both adapters share this one diagnosis instead
 * of keeping near-identical local copies.
 * @param raw - the credential exactly as supplied.
 * @param pkg - the refusing package name, prefixed to the diagnostic.
 * @param ref - the credential reference the value resolved through.
 * @returns the trimmed, usable key.
 */
export function assertUsableApiKey(raw: string, pkg: string, ref: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  // Models 页面只是最常见的写入方，不是唯一来源；同一值也可能来自手工编辑的 .env 或
  // Shell export。某些组合根本未挂载 Credentials 服务，此时把用户引向不存在的页面没有意义。
  throw new LlmError(
    checked.reason === 'empty'
      ? `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
        + ' (the web Models page writes it) or export it in the launching environment'
      : `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry;`
        + ` set ${ref} to the raw key alone (the web Models page writes it)`,
    INVALID_CREDENTIAL_CODE,
  )
}

/** One model call whose config and adapter registration were resolved together. */
export interface PreparedLlmCall {
  /** Detached, deep-frozen config with any adapter-owned default materialized. */
  readonly config: LlmCallConfig
  /** Immutable retry policy captured with the adapter registration. */
  readonly retryPolicy: ResolvedRetryPolicy
  /** Detached context metadata resolved with the registration-bound call. */
  readonly context?: LlmModelContext
  /** Exact model modalities captured with the adapter dispatch generation. */
  readonly inputModalities?: readonly ModelModality[]
  /** Config fields materialized by the captured adapter rather than proposed by the caller. */
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  /**
   * Dispatch this call once through the registration captured during
   * preparation. The request's call-config fields must match {@link config};
   * reuse or mismatch fails with `INVALID_PREPARED_CALL`.
   * @param options - fully assembled request carrying the prepared config.
   * @returns the chunk stream, including the `llm/stream` waterfall.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** One adapter-owned model-resolution generation bound to its eventual stream call. */
export interface PreparedAdapterCall {
  /** Exact model metadata from the same adapter generation as {@link stream}. */
  readonly model: LlmResolvedModelInfo
  /** Dispatch through that generation without re-reading dynamic connection facts. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove the headers are added in the wire request or library header hook. The direct-fetch
 * DeepSeek and library-backed pi-ai adapters meet this contract through different internals.
 */
export abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * Return the provider-owned retry policy captured with this route.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @returns a resolved policy, or `undefined` to use the normal defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * Resolve all metadata available for one exact model. This query is
   * independent of the advisory catalog and does not validate request routing.
   * @param provider - one provider route owned by this adapter.
   * @param model - exact model id passed to {@link GenerateOptions.model}.
   * @param _signal - cancellation for this exact-model lookup; asynchronous
   *   implementations must settle promptly after it aborts.
   * @returns provider/model identity plus any context, call-default, and reasoning metadata.
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * Bind exact model metadata and the eventual request dispatch to one adapter generation.
   * Dynamic adapters override this so settings changes between preparation and
   * dispatch cannot combine one generation's capabilities with another's endpoint.
   * @param provider - registered provider route.
   * @param model - exact model id.
   * @param signal - cancellation for model resolution.
   * @returns model metadata and a one-generation stream entry point.
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * What {@link LlmRuntime.registerAdapter} returns: the disposer, plus an
 * atomic route replacement for the same adapter instance.
 */
export interface AdapterRegistrationHandle {
  /** Release every route this registration currently holds. */
  (): void
  /**
   * Replace this registration's routes with `providers`, keeping the same
   * adapter instance. The candidate set is validated in full first — a
   * conflict with another adapter, an invalid name, or bad provider metadata
   * throws and leaves the current routes untouched — and the swap itself is
   * one synchronous section, so no request can observe a gap. An empty array
   * is legal here (a settings section that emptied holds zero routes while
   * staying registered), unlike an empty initial registration.
   *
   * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
   * has been released: its routes are gone and its disposer has already run,
   * so anything registered afterwards would have no owner left to release it.
   * @param providers - the complete next route set for this registration.
   */
  replace(providers: string[]): void
}

/**
 * A live configurable-provider registration, disposable and atomically
 * replaceable — the directory counterpart of {@link AdapterRegistrationHandle}.
 */
export interface DirectoryRegistrationHandle {
  /** Withdraw every entry this registration currently holds. */
  (): void
  /**
   * Replace this registration's entries with `entries`. The candidate set is
   * validated in full first — an entry another registration already declares,
   * a duplicate within the set, or invalid metadata throws and leaves the
   * current entries untouched — and the swap is one synchronous section, so no
   * reader observes a gap. An empty array is legal here, unlike an empty
   * initial registration.
   *
   * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
   * has been disposed.
   */
  replace(entries: readonly LlmConfigurableProvider[]): void
}

/**
 * 抽象 `llm` Service：由 Adapter 注册表和流式模型调用 API 组成，可通过 `llm/stream`
 * Waterfall 拦截。Provider 是配置与请求使用的稳定名称，Adapter 是可热替换的实现实例；
 * 注册、模型能力解析和流式发送都由此 Service 统一处理。
 */
export class LlmRuntime extends Service {
  private adapters = new Map<string, AdapterRegistration>()
  private directory = new Map<string, LlmConfigurableProvider>()
  private discoveries = new Map<
    string,
    (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>
  >()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /** Notify topology observers without letting one broken listener veto the commit. */
  private emitAdaptersUpdated(): void {
    // Cordis emit 使用 Array.map，某个监听器同步抛错会阻止后续监听器运行。注册表通知不能
    // 被单个监听器否决，因此分别隔离每个回调；标记为 INVARIANT 的失败仍需向外抛出。
    let invariantFailure: unknown
    for (const listener of this.ctx.events.dispatch('emit', ['llm/adapters-updated']) as Array<() => unknown>) {
      try {
        const returned = listener()
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          // emit 监听器仍可能是异步函数，其 rejection 无法进入下方同步的 INVARIANT 重抛，
          // 因此在此捕获，避免成为未处理 rejection。
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnAdaptersListenerFailure(error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnAdaptersListenerFailure(error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnAdaptersListenerFailure(error: unknown): void {
    this.ctx.logger.warn('llm: an llm/adapters-updated listener failed')
    this.ctx.logger.warn(error)
  }

  /**
   * 为指定 Provider 路由注册 Adapter。任一 Provider 已有 Adapter 时，以
   * `DUPLICATE_ADAPTER` 抛出 `LlmError`，整次注册不产生部分结果。注册随 Fiber 释放。
   * @param providers - 当前 Adapter 服务的全部 Provider 路由。
   * @param adapter - 为这些 Provider 执行流式调用的 Adapter。
   * @returns 注册 disposer，并带有 {@link AdapterRegistrationHandle.replace}。
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle {
    // 一次注册可以拥有多条 Provider 路由，并返回可释放、可原子替换的句柄。先完整校验
    // 再提交，观察者不会看到只注册了一半或替换过程中的空档。
    // owned 保存本次注册当前占用的路由；replace 会重写它，disposer 则在释放时删除其中
    // 当时仍然持有的全部路由。
    const owned = new Set<string>()
    // released 单独记录 disposer 是否运行过；不能用 owned 为空判断，因为 replace([])
    // 合法地表示一个仍存活、但暂时没有路由的注册。
    let released = false
    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      if (providers.length === 0) throw new LlmError('an adapter must register at least one provider', 'INVALID_ADAPTER')
      this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned))
      yield () => {
        released = true
        for (const provider of owned) this.adapters.delete(provider)
        owned.clear()
        this.emitAdaptersUpdated()
      }
    }.bind(this), 'llm.registerAdapter()')
    // ctx.effect 的 disposer 返回 Promise<void>；这里对外提供同步的即发即弃接口，因此
    // 丢弃这个总会正常完成的 Promise。
    const handle = (() => void dispose()) as AdapterRegistrationHandle
    handle.replace = (next: string[]): void => {
      // disposer 运行后再注册会造成泄漏：原 Effect 已经结束，没有任何清理动作会移除本次
      // 调用重新放入 Map 的路由。
      if (released) {
        throw new LlmError('a disposed adapter registration cannot replace its routes', 'REGISTRATION_DISPOSED')
      }
      this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned))
    }
    return handle
  }

  /**
   * Validate one candidate route set for `adapter`, treating routes this
   * registration already holds as available. Nothing is mutated: a rejected
   * candidate leaves the registry exactly as it was.
   */
  private prepareRoutes(providers: string[], adapter: LlmAdapter, owned: ReadonlySet<string>): AdapterRegistration[] {
    const unique = new Set<string>()
    const registrations: AdapterRegistration[] = []
    for (const provider of providers) {
      if (provider.length === 0) throw new LlmError('adapter provider names must be non-empty', 'INVALID_ADAPTER')
      if (unique.has(provider) || (this.adapters.has(provider) && !owned.has(provider))) {
        throw new LlmError(`an adapter for provider "${provider}" is already registered`, 'DUPLICATE_ADAPTER')
      }
      const info = adapter.providerInfo(provider)
      if (typeof info.id !== 'string' || info.id !== provider || typeof info.name !== 'string' || info.name.length === 0) {
        throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, 'INVALID_ADAPTER')
      }
      unique.add(provider)
      const retryPolicy = adapter.providerRetryPolicy(provider)
        ?? resolveRetryPolicy(undefined, `llm: provider "${provider}" retryPolicy`)
      registrations.push({
        adapter,
        provider: { id: info.id, name: info.name },
        retryPolicy,
      })
    }
    return registrations
  }

  /**
   * Swap this registration's routes for the prepared ones in one synchronous
   * section, so no observer can see the registry between the release and the
   * re-registration. The route set's one mutation point is also where
   * `llm/adapters-updated` is published, so a `replace` announces itself
   * exactly like a first registration.
   */
  private commitRoutes(owned: Set<string>, registrations: readonly AdapterRegistration[]): void {
    for (const provider of owned) this.adapters.delete(provider)
    owned.clear()
    for (const registration of registrations) {
      this.adapters.set(registration.provider.id, registration)
      owned.add(registration.provider.id)
    }
    this.emitAdaptersUpdated()
  }

  /**
   * Describe provider routes with a registered adapter.
   * @returns detached provider metadata in registration order.
   */
  listProviders(): LlmProviderInfo[] {
    return [...this.adapters.values()].map(({ provider }) => ({ ...provider }))
  }

  /**
   * Declare provider routes an adapter plugin can activate through
   * configuration. Registration is all-or-nothing: an empty list, invalid
   * entry, or a provider already declared by any registration throws
   * `LlmError` without registering the rest. Disposed with the fiber.
   * @param entries - every configurable provider this plugin owns.
   * @returns a handle that withdraws all of them, and can atomically replace them.
   */
  registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle {
    let held: LlmConfigurableProvider[] = []
    let disposed = false
    /**
     * Validate a candidate set in full against everything this registration
     * does not already hold, then publish it. Nothing is written until the
     * whole set passes, so a refused candidate leaves the current entries in
     * place — the property that makes `replace` a swap rather than a
     * delete-then-add that can strand the directory empty.
     */
    const commit = (candidates: readonly LlmConfigurableProvider[]): void => {
      const detached: LlmConfigurableProvider[] = []
      const own = new Set(held.map(entry => entry.provider))
      for (const entry of candidates) {
        if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) {
          throw new LlmError('configurable providers need a non-empty provider, displayName, and settingsNs', 'INVALID_DIRECTORY')
        }
        if (entry.settingsPath.some(segment => segment.length === 0)) {
          throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, 'INVALID_DIRECTORY')
        }
        if ((this.directory.has(entry.provider) && !own.has(entry.provider))
          || detached.some(seen => seen.provider === entry.provider)) {
          throw new LlmError(`configurable provider "${entry.provider}" is already declared`, 'DUPLICATE_DIRECTORY')
        }
        detached.push({ ...entry, settingsPath: [...entry.settingsPath] })
      }
      for (const entry of held) this.directory.delete(entry.provider)
      for (const entry of detached) this.directory.set(entry.provider, entry)
      held = detached
      this.emitAdaptersUpdated()
    }

    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      if (entries.length === 0) {
        throw new LlmError('a configurable-provider registration must declare at least one provider', 'INVALID_DIRECTORY')
      }
      commit(entries)
      yield () => {
        disposed = true
        for (const entry of held) this.directory.delete(entry.provider)
        held = []
        this.emitAdaptersUpdated()
      }
    }.bind(this), 'llm.registerConfigurableProviders()')

    const handle = ((): void => void dispose()) as DirectoryRegistrationHandle
    handle.replace = (next: readonly LlmConfigurableProvider[]): void => {
      if (disposed) {
        throw new LlmError('this configurable-provider registration was disposed', 'REGISTRATION_DISPOSED')
      }
      commit(next)
    }
    return handle
  }

  /**
   * List every declared configurable provider, registered or dormant.
   * @returns detached directory entries in declaration order.
   */
  listConfigurableProviders(): LlmConfigurableProvider[] {
    return [...this.directory.values()].map(entry => ({ ...entry, settingsPath: [...entry.settingsPath] }))
  }

  /**
   * Offer to interrogate provider endpoints on behalf of the settings
   * namespace this plugin owns. The namespace is the key because that is what
   * a configuration surface already holds from the configurable-provider
   * directory, and because a provider being *added* has no route to name yet.
   * Disposed with the fiber.
   * @param settingsNs - the namespace whose profiles this discovery serves.
   * @param discover - interrogates one endpoint; must honor `request.signal`.
   * @returns the disposer that withdraws the offer.
   */
  registerModelDiscovery(
    settingsNs: string,
    discover: (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>,
  ): () => void {
    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      if (settingsNs.length === 0) {
        throw new LlmError('model discovery needs a non-empty settings namespace', 'INVALID_DISCOVERY')
      }
      if (this.discoveries.has(settingsNs)) {
        throw new LlmError(`model discovery for "${settingsNs}" is already registered`, 'DUPLICATE_DISCOVERY')
      }
      this.discoveries.set(settingsNs, discover)
      yield () => {
        this.discoveries.delete(settingsNs)
      }
    }.bind(this), 'llm.registerModelDiscovery()')
    return () => void dispose()
  }

  /**
   * Interrogate one provider endpoint for the models it advertises. The
   * request describes a draft, not a stored route, so nothing here reads or
   * writes settings or credentials — the caller owns both, and the reply is
   * candidate metadata a surface may offer for adoption.
   * @param settingsNs - namespace whose registered discovery serves this draft.
   * @param request - the endpoint, protocol, and one-shot credential to use.
   * @returns the advertised models, deduplicated in endpoint order.
   */
  async discoverModels(
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
  ): Promise<LlmDiscoveredModel[]> {
    const discover = this.discoveries.get(settingsNs)
    if (discover === undefined) {
      throw new LlmError(`no model discovery is registered for "${settingsNs}"`, 'NO_DISCOVERY')
    }
    // 两者至少有一个用于确定查询目标：Adapter 已知的路由，或可请求的端点；都缺失时没有
    // 可供描述的模型来源。
    if ((request.provider ?? '').length === 0 && (request.baseURL ?? '').length === 0) {
      throw new LlmError('model discovery needs a provider route or a baseURL', 'INVALID_DISCOVERY')
    }
    const discovered = await discover(request)
    const seen = new Set<string>()
    const models: LlmDiscoveredModel[] = []
    for (const model of discovered) {
      if (typeof model.id !== 'string' || model.id.length === 0 || seen.has(model.id)) continue
      seen.add(model.id)
      models.push({
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      })
    }
    return models
  }

  /**
   * Resolve the retry policy captured when one provider route was registered.
   * @param provider - registered provider route to inspect.
   * @returns the provider-owned policy, with normal defaults already resolved.
   */
  providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.registration(provider).retryPolicy
  }

  /** Detach typed adapter-owned modality metadata. */
  private detachedModalities(modalities: readonly ModelModality[] | undefined): ModelModality[] | undefined {
    return modalities === undefined ? undefined : [...modalities]
  }

  /**
   * Discover models advertised by one registered provider. Catalog membership
   * is advisory and never changes routing or request validation.
   * @param provider - registered provider route to inspect.
   * @returns detached model metadata in adapter-preferred order.
   */
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const adapter = this.registration(provider).adapter
    const models = await adapter.listModels(provider)
    const seen = new Set<string>()
    return models.map((model) => {
      if (
        typeof model.provider !== 'string'
        || model.provider !== provider
        || typeof model.id !== 'string'
        || model.id.length === 0
        || typeof model.name !== 'string'
        || model.name.length === 0
        || (model.description !== undefined && typeof model.description !== 'string')
        || seen.has(model.id)
      ) {
        throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, 'INVALID_CATALOG')
      }
      seen.add(model.id)
      const inputModalities = this.detachedModalities(model.inputModalities)
      return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...inputModalities === undefined ? {} : { inputModalities },
      }
    })
  }

  /**
   * Resolve and validate all metadata from the adapter that owns one exact
   * route. The result is detached from adapter-owned objects; catalog
   * membership remains advisory and does not control request routing.
   * @param provider - registered provider route to inspect.
   * @param model - exact model id passed to the adapter.
   * @param signal - optional cancellation for adapter-owned asynchronous lookup.
   * @returns exact model identity plus available context and reasoning metadata.
   */
  async resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.resolveModelInfoFor(this.registration(provider), model, signal)
  }

  private async resolveModelInfoFor(
    registration: AdapterRegistration,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal)
    return this.normalizeModelInfo(registration, model, resolved)
  }

  /** 验证并脱离一个 Adapter 返回的精确模型结果。 */
  private normalizeModelInfo(
    registration: AdapterRegistration,
    model: string,
    resolved: LlmResolvedModelInfo,
  ): LlmResolvedModelInfo {
    const provider = registration.provider.id
    if (
      typeof resolved.provider !== 'string'
      || resolved.provider !== provider
      || typeof resolved.id !== 'string'
      || resolved.id !== model
      || typeof resolved.name !== 'string'
      || resolved.name.length === 0
      || (resolved.description !== undefined && typeof resolved.description !== 'string')
    ) {
      throw new LlmError(
        `adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_INFO',
      )
    }
    const context = resolved.context
    if (context !== undefined && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) {
      throw new LlmError(
        `adapter returned invalid context metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_CONTEXT',
      )
    }
    // 能力元数据原样向下游传递：显式缺少图片模态是准入预检会执行的负能力。
    const inputModalities = this.detachedModalities(resolved.inputModalities)
    const defaultMaxTokens = resolved.defaultMaxTokens
    if (defaultMaxTokens !== undefined
      && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)) {
      throw new LlmError(
        `adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_MAX_TOKENS',
      )
    }
    const info: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: resolved.name,
      ...resolved.description === undefined ? {} : { description: resolved.description },
      ...inputModalities === undefined ? {} : { inputModalities },
      ...context === undefined ? {} : { context: { contextWindow: context.contextWindow } },
      ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
    }
    const reasoning = resolved.reasoning
    if (reasoning === undefined) return info
    if (reasoning.efforts.length === 0) {
      throw new LlmError(
        `adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
      )
    }
    const seen = new Set<string>()
    const efforts = reasoning.efforts.map((effort) => {
      if (
        typeof effort.id !== 'string'
        || effort.id.length === 0
        || typeof effort.name !== 'string'
        || effort.name.length === 0
        || (effort.description !== undefined && typeof effort.description !== 'string')
        || seen.has(effort.id)
      ) {
        throw new LlmError(
          `adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`,
          'INVALID_MODEL_REASONING',
        )
      }
      seen.add(effort.id)
      return {
        id: effort.id,
        name: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      }
    })
    if (reasoning.defaultEffort !== undefined && !seen.has(reasoning.defaultEffort)) {
      throw new LlmError(
        `adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
      )
    }
    return {
      ...info,
      reasoning: {
        efforts,
        ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
      },
    }
  }

  /**
   * Validate a conversation call config against its exact model capability and
   * materialize adapter-configured defaults. Unsupported explicit efforts
   * reject before provider I/O; no clamping or aliasing is performed. This
   * standalone query does not bind a later dispatch; use {@link prepareCall}
   * when logging and streaming must share one adapter registration.
   * @param config - provider/model route and optional request controls.
   * @param signal - optional cancellation for adapter-owned capability lookup.
   * @returns a detached config only when a default must be materialized.
   */
  async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig> {
    return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config
  }

  private async resolveCallFor(
    registration: AdapterRegistration,
    config: LlmCallConfig,
    signal?: AbortSignal,
  ): Promise<{ config: LlmCallConfig; context?: LlmModelContext; modelInfo: LlmResolvedModelInfo }> {
    const info = await this.resolveModelInfoFor(registration, config.model, signal)
    return this.resolveCallWithInfo(config, info)
  }

  /** 根据已绑定的精确模型结果验证请求控制项。 */
  private resolveCallWithInfo(
    config: LlmCallConfig,
    info: LlmResolvedModelInfo,
  ): { config: LlmCallConfig; context?: LlmModelContext; modelInfo: LlmResolvedModelInfo } {
    const defaulted = config.maxTokens === undefined && info.defaultMaxTokens !== undefined
      ? { ...config, maxTokens: info.defaultMaxTokens }
      : config
    const reasoning = info.reasoning
    const requested = defaulted.reasoningEffort
    let resolvedConfig = defaulted
    if (reasoning === undefined) {
      if (requested !== undefined) {
        throw new LlmError(
          `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
    } else {
      const effective = requested ?? reasoning.defaultEffort
      if (effective !== undefined) {
        if (!reasoning.efforts.some(effort => effort.id === effective)) {
          throw new LlmError(
            `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`,
            'UNSUPPORTED_REASONING_EFFORT',
          )
        }
        if (requested !== effective) resolvedConfig = { ...defaulted, reasoningEffort: effective }
      }
    }
    return {
      config: resolvedConfig,
      ...info.context === undefined ? {} : { context: info.context },
      modelInfo: info,
    }
  }

  /**
   * 使用当前 Adapter 注册解析一次调用。返回的单次句柄会从 Header 记录一直绑定到 Dispatch，
   * 防止 HMR 把一个 Adapter 的能力解析结果与另一个 Adapter 的发送实现组合起来。
   * @param config - Provider/Model 路由与可选请求控制项。
   * @param signal - 用于 Adapter 能力查询的可选取消信号。
   * @returns 准备后的配置，以及绑定到当前注册代的流式入口。
   */
  async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall> {
    // prepareCall 把“解析模型能力”和“最终发送”绑定到同一个 Adapter generation，并把
    // Adapter 提供的默认值物化为冻结配置，供 AgentLoop 先记录 request/header。
    const registration = this.registration(config.provider)
    const adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal)
    const modelInfo = this.normalizeModelInfo(registration, config.model, adapterCall.model)
    const resolved = this.resolveCallWithInfo(config, modelInfo)
    const resolvedConfig = deepFreeze(structuredClone(resolved.config))
    const context = resolved.context === undefined
      ? undefined
      : deepFreeze(structuredClone(resolved.context))
    const adapterDefaults = deepFreeze<LlmCallConfigAdapterDefaults>({
      ...config.reasoningEffort === undefined && resolvedConfig.reasoningEffort !== undefined
        ? { reasoningEffort: true }
        : {},
      ...config.maxTokens === undefined && resolvedConfig.maxTokens !== undefined
        ? { maxTokens: true }
        : {},
    })
    let dispatched = false
    return Object.freeze({
      config: resolvedConfig,
      retryPolicy: registration.retryPolicy,
      adapterDefaults,
      ...context === undefined ? {} : { context },
      ...modelInfo.inputModalities === undefined
        ? {}
        : { inputModalities: Object.freeze([...modelInfo.inputModalities]) },
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        if (dispatched) {
          throw new LlmError('a prepared LLM call can only be dispatched once', 'INVALID_PREPARED_CALL')
        }
        if (!callConfigEquals(options, resolvedConfig)) {
          throw new LlmError(
            'prepared LLM call config changed before adapter dispatch',
            'INVALID_PREPARED_CALL',
          )
        }
        dispatched = true
        return this.streamWithRegistration(options, {
          registration,
          config: resolvedConfig,
          modelInfo,
          dispatch: options => adapterCall.stream(options),
        })
      },
    })
  }

  private registration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER')
    return registration
  }

  /** Remove replay state whose historical route is owned by another adapter. */
  private forAdapter(options: GenerateOptions, adapter: LlmAdapter): GenerateOptions {
    const messages: Message[] = options.messages.map((message) => {
      const source = message.source
      if (message.role !== 'assistant' || source.kind !== 'model' || source.replayState === undefined) return message
      if (this.adapters.get(source.provider)?.adapter === adapter) return message
      return freezeMessage({
        ...message,
        source: { kind: 'model', provider: source.provider, model: source.model },
      })
    })
    if (messages.every((message, index) => message === options.messages[index])) return options
    const filtered = { ...options, messages }
    return Object.isFrozen(options) ? deepFreeze(filtered) : filtered
  }

  /**
   * Final adapter boundary. Adapter selection, dispatch, iterator construction,
   * and iteration failures become one terminal failure chunk. Middleware and
   * downstream consumer failures remain thrown plugin or consumer errors.
   */
  private async * adapterStream(
    options: GenerateOptions,
    prepared?: PreparedDispatch,
  ): AsyncGenerator<StreamChunk> {
    let iterator: AsyncIterator<StreamChunk>
    try {
      const registration = prepared?.registration ?? this.registration(options.provider)
      const adapter = registration.adapter
      let modelInfo: LlmResolvedModelInfo
      let resolvedConfig: LlmCallConfig
      let dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>
      if (prepared === undefined) {
        const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal)
        modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model)
        resolvedConfig = this.resolveCallWithInfo(options, modelInfo).config
        dispatch = options => adapterCall.stream(options)
      } else {
        modelInfo = prepared.modelInfo
        resolvedConfig = prepared.config
        dispatch = prepared.dispatch
      }
      if (prepared !== undefined && !callConfigEquals(options, resolvedConfig)) {
        throw new LlmError(
          'prepared LLM call config changed before adapter dispatch',
          'INVALID_PREPARED_CALL',
        )
      }
      const resolvedOptions = callConfigEquals(options, resolvedConfig)
        ? options
        : Object.isFrozen(options)
          ? deepFreeze({ ...options, ...resolvedConfig })
          : { ...options, ...resolvedConfig }
      const projectedOptions = modelInfo.inputModalities !== undefined
        && !modelInfo.inputModalities.includes('image')
        && resolvedOptions.messages.some(message => contentHasImage(message.content))
        ? Object.isFrozen(resolvedOptions)
          ? deepFreeze({ ...resolvedOptions, messages: projectImagesForTextModel(resolvedOptions.messages) as Message[] })
          : { ...resolvedOptions, messages: projectImagesForTextModel(resolvedOptions.messages) as Message[] }
        : resolvedOptions
      const stream = dispatch(this.forAdapter(projectedOptions, adapter))
      iterator = stream[Symbol.asyncIterator]()
    } catch (error: unknown) {
      yield adapterFailureChunk(error, options.signal)
      return
    }

    let completed = false
    try {
      while (true) {
        let item: { done: true } | { done: false; value: StreamChunk }
        try {
          const next = await iterator.next()
          item = next.done
            ? { done: true }
            : { done: false, value: next.value }
        } catch (error: unknown) {
          completed = true
          yield adapterFailureChunk(error, options.signal)
          return
        }
        if (item.done) {
          completed = true
          return
        }
        // 在 yield 前结束 Adapter 所有的 try；消费者或中间件恢复生成器时抛入的错误必须
        // 继续向外抛出，不能被误当成 Adapter 失败转换。
        yield item.value
      }
    } finally {
      if (!completed) {
        const close = iterator.return?.bind(iterator)
        if (close) await close()
      }
    }
  }

  /**
   * 把一次模型调用流式输出为原始 Chunk（Token 级增量）。只有同一个 Adapter 实例同时拥有
   * 历史 Provider 和目标 Provider 时才保留 Replay 状态。异步解析精确模型和 Dispatch
   * 期间，最终 Adapter 选择保持固定。Adapter 选择、Dispatch 与迭代失败会转换为终止的
   * `error` 或 `aborted` Finish Chunk；中间件、嵌套调用、清理和消费者失败继续向外抛出。
   * @param options - 完整请求；`options.provider` 用于选择 Adapter。
   * @returns Chunk 流，可能被 `llm/stream` 监听器包装。
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // llm/stream 是模型调用的统一拦截点；监听器可调用 next() 包装当前 Adapter，也可返回
    // 自己的流接管请求。最终 Adapter 选择仍由 Provider 路由决定。
    return this.streamWithRegistration(options)
  }

  private streamWithRegistration(
    options: GenerateOptions,
    prepared?: PreparedDispatch,
  ): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(
      this,
      'llm/stream',
      options,
      () => this.adapterStream(options, prepared),
    )
  }
}

/** Convert one adapter throw into the stream protocol's terminal outcome. */
function adapterFailureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeLlmFailure(error)
  return {
    type: 'finish',
    reason: signal?.aborted || failure.code === 'ABORTED'
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure },
  }
}

interface AdapterRegistration {
  readonly adapter: LlmAdapter
  readonly provider: LlmProviderInfo
  readonly retryPolicy: ResolvedRetryPolicy
}

interface PreparedDispatch {
  readonly registration: AdapterRegistration
  readonly config: LlmCallConfig
  readonly modelInfo: LlmResolvedModelInfo
  readonly dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}

export default LlmRuntime
