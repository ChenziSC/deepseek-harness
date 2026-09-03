/**
 * 事件溯源的 Session Service：提供只追加的 Session 日志、内存注册表，以及从日志派生的
 * LLM 消息历史。持久化由插件负责：订阅 `session/event`，并在 `session/flush` 时排空写入。
 * Turn、Step、模型输出和工具结果都先成为事件，因此恢复、Fork、UI 重放和下一次模型请求
 * 共用同一事实来源。
 *
 * @module @deepseek-ai/dsh-session
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId } from './types.ts'
import type { TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import type { CreateSessionOptions, EpochHeader, PrepareSessionOptions, RequestContext, SessionEvent, SessionEventMap, SessionEventType, SessionHeader, SurfaceIntent, SurfaceEventType } from './types.ts'
import { snapshotJsonValue } from './json.ts'
import { deriveEventMessage, SurfaceManager } from './surface.ts'
import type { SessionSurface } from './surface.ts'
import { foldRequestHeader } from './request-header.ts'

export * from './types.ts'
export { SessionPreparation } from './preparation.ts'
export type { SessionPreparationOptions } from './preparation.ts'
export type { AssistantMessage, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
export { isJsonValue, snapshotJsonValue } from './json.ts'
export type { JsonValue } from './json.ts'
export { interruptedTurnClosers, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from './repair.ts'
export { decodeStorageRecord, packChunkRuns } from './chunk-rows.ts'
export type { ChunkRow, StorageRecord } from './chunk-rows.ts'
export type { SessionSurface, SurfaceFoldReplacement, SurfaceFoldResult } from './surface.ts'
export { deriveEventMessage, foldSurface, isAppendSurfaceEvent, isReplacementSurfaceEvent, isSurfaceEvent, isSurfaceEligibleType } from './surface.ts'
export { canonicalHeader, foldRequestHeader, headerEquals } from './request-header.ts'
export { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionStore
  }

  interface Events {
    /**
     * Creation announcement during session publication. A synchronous throw vetoes and rolls
     * back with a paired disposal; detach requested during dispatch is deferred.
     * A returned-promise rejection is logged but cannot retroactively veto this
     * synchronous boundary.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only sessions entered through that agent's context.
     * @param session - the session just entered and announced.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/created'(this: Scoped<Session>, session: Session): void
    /**
     * Emitted once when an announced session leaves the store, including
     * publication rollback, but never for an entry whose creation announcement
     * did not begin. Listener failures are logged and contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`) reuses the owner scope.
     * @param session - the session that is no longer live in the store.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/disposed'(this: Scoped<Session>, session: Session): void
    /**
     * Post-commit, fire-and-forget append feed. The listener snapshot resolves
     * before the log push, but callbacks run after it; observer failures are
     * logged and contained without making the committed append fail.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only events from sessions entered through that agent's context.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
    /**
     * Awaited parallel durability checkpoint: every listener runs and the
     * caller awaits all of them, with no waterfall veto. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`) reuses the session's owner scope.
     * @param session - the session whose buffered events must reach durable storage.
     * @dshScopeScan unsupported
     * @mode parallel
     */
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    session: TypertLookup<Session, SessionId>
  }
}

/** Validate and freeze one detached creation header in place. */
function validateSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session header is not a plain JSON record')
  }
  const record = input as Record<string, unknown>
  if (record.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`session header version must be ${SESSION_FORMAT_VERSION}, got ${String(record.version)}`)
  }
  if (record.id !== id) {
    throw new Error(`session header id "${String(record.id)}" does not match session id "${id}"`)
  }
  if (typeof record.createdAt !== 'number'
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0) {
    throw new Error('session header createdAt must be a non-negative safe integer')
  }
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== 'string') throw new Error('session header cwd must be a string')
    if (!isAbsolute(record.cwd)) {
      throw new Error(`session header cwd must be an absolute path, got "${record.cwd}"`)
    }
  }
  if (record.parentSession !== undefined && typeof record.parentSession !== 'string') {
    throw new Error('session header parentSession must be a string')
  }
  if (record.seedLength !== undefined
    && (typeof record.seedLength !== 'number' || !Number.isSafeInteger(record.seedLength) || record.seedLength < 0)) {
    throw new Error('session header seedLength must be a non-negative safe integer')
  }
  if (record.origin !== undefined && record.origin !== 'subagent') {
    throw new Error('session header origin must be "subagent"')
  }
  if (record.delegationDepth !== undefined
    && (typeof record.delegationDepth !== 'number' || !Number.isSafeInteger(record.delegationDepth) || record.delegationDepth < 0)) {
    throw new Error('session header delegationDepth must be a non-negative safe integer')
  }
  if (record.agentPreset !== undefined && typeof record.agentPreset !== 'string') {
    throw new Error('session header agentPreset must be a string')
  }
  return deepFreeze(record as unknown as SessionHeader)
}

/** Validate and freeze one exclusively owned persistence header in place. */
function validateRestoredSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const prototype = Reflect.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('session header is not a plain JSON record')
    }
  }
  return validateSessionHeader(id, input)
}

/** Detach, validate, and freeze the creation metadata published by a session. */
function snapshotSessionHeader(id: SessionId, source?: SessionHeader): SessionHeader {
  const input: unknown = source === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now() }
    : source
  const snapshot = snapshotJsonValue(input)
  if (snapshot === undefined) throw new Error('session header is not losslessly JSON-serializable')
  return validateSessionHeader(id, snapshot)
}

/**
 * Validate an exclusively owned event and deeply freeze its identified message
 * without copying the event. The caller transfers an object graph that no
 * producer retains and that shares no mutable children with another event.
 * Use {@link snapshotSessionEvent} when exclusive ownership is not guaranteed.
 * @param event - exclusively owned event imported across a trusted boundary.
 * @returns the same event object with a validated, deeply frozen message.
 */
export function adoptSessionEvent<T extends SessionEvent>(event: T): T {
  assertMessageEventShape(
    event,
    `session event at seq ${event.seq}`,
  )
  switch (event.type) {
    case 'user/message':
      deepFreeze(event.data)
      break
    case 'assistant/message':
    case 'tool/result':
      deepFreeze(event.data.message)
      break
    default:
      // SessionEventMap 可通过声明合并扩展；插件自有事件不生成核心消息。
      break
  }
  return event
}

/**
 * Detach one event while preserving deep immutability for its identified message.
 * @param event - event imported across a query or persistence boundary.
 * @returns a detached event snapshot with a validated, deeply frozen message.
 */
export function snapshotSessionEvent<T extends SessionEvent>(event: T): T {
  return adoptSessionEvent(structuredClone(event))
}

/** Deep-freeze one acyclic JSON tree without consuming the JavaScript call stack. */
function freezeRestoredObject<T extends object>(value: T): T {
  const pending: object[] = [value]
  while (pending.length > 0) {
    // 上面的非空检查保证这里仍有一个对象可继续遍历。
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const current = pending.pop()!
    Object.freeze(current)
    for (const key in current) {
      const child = (current as Record<string, unknown>)[key]
      if (child !== null && typeof child === 'object') pending.push(child)
    }
  }
  return value
}

/** Validate the fixed event envelope after one-pass JSON materialization. */
function assertSessionEventEnvelope(value: Record<string, unknown>, index: number): asserts value is SessionEvent {
  const event = value
  if (event['type'] === 'request/header-delta') {
    throw new Error(`seed event at index ${index} uses unsupported legacy request/header-delta format`)
  }
  for (const key in event) {
    switch (key) {
      case 'type':
      case 'seq':
      case 'time':
      case 'data':
      case 'surfaceOp':
      case 'sourceEventSeqs':
      case 'ignorable':
        break
      default:
        throw new Error(`seed event at index ${index} has an invalid event envelope`)
    }
  }
  const type = event['type']
  const seq = event['seq']
  const time = event['time']
  if (typeof type !== 'string'
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0
    || typeof time !== 'number' || !Number.isSafeInteger(time)
    || event['data'] === undefined
    || (event['ignorable'] !== undefined && event['ignorable'] !== true)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  switch (type) {
    case 'request/header':
    case 'user/message':
    case 'assistant/message':
    case 'tool/result':
      assertCurrentLlmShape(event, index)
      break
  }
}

/** Reject obsolete request headers and malformed messages at the seed/load boundary. */
function assertCurrentLlmShape(event: Record<string, unknown>, index: number): void {
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  if (event['type'] === 'request/header') {
    const header = record?.['header']
    const headerRecord = typeof header === 'object' && header !== null && !Array.isArray(header)
      ? header as Record<string, unknown>
      : undefined
    const config = headerRecord?.['config']
    if (!hasProviderModel(config)) throw new Error(`seed request/header at index ${index} lacks provider/model`)
    const configRecord = config as Record<string, unknown>
    const reasoningEffort = configRecord['reasoningEffort']
    if (reasoningEffort !== undefined
      && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
      throw new Error(`seed request/header at index ${index} has an invalid reasoningEffort`)
    }
    assertAdapterDefaults(headerRecord?.['adapterDefaults'], configRecord, index)
  }
  const type = event['type']
  if (type !== 'user/message' && type !== 'assistant/message'
    && type !== 'tool/result') return
  assertMessageEventShape(event, `seed ${type} at index ${index}`)
}

const allowedAdapterKeys = new Set(['reasoningEffort', 'maxTokens'])

/** Validate adapter-default markers imported from a durable request header. */
function assertAdapterDefaults(
  value: unknown,
  config: Record<string, unknown>,
  index: number,
): void {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
  const defaults = value as Record<string, unknown>
  if (Object.keys(defaults).some(key => !allowedAdapterKeys.has(key))
    || Object.values(defaults).some(marker => marker !== true)
    || defaults['reasoningEffort'] === true && config['reasoningEffort'] === undefined
    || defaults['maxTokens'] === true && config['maxTokens'] === undefined) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
}

/** Validate only the event-specific invariants needed to safely replay a message. */
function assertMessageEventShape(event: Record<string, unknown>, subject: string): void {
  const type = event['type']
  if (type !== 'user/message' && type !== 'assistant/message'
    && type !== 'tool/result') return
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  const message = type === 'user/message' ? record : record?.['message']
  if (typeof message !== 'object' || message === null
    || typeof (message as Record<string, unknown>)['id'] !== 'string'
    || (message as Record<string, unknown>)['id'] === '') {
    throw new Error(`${subject} lacks an identified message`)
  }
  const messageRecord = message as Record<string, unknown>
  const expectedRole = type === 'assistant/message' ? 'assistant' : 'user'
  if (messageRecord['role'] !== expectedRole) {
    throw new Error(`${subject} message must have role "${expectedRole}"`)
  }
  const source = messageRecord['source']
  if (typeof source !== 'object' || source === null
    || typeof (source as Record<string, unknown>)['kind'] !== 'string'
    || (source as Record<string, unknown>)['kind'] === '') {
    throw new Error(`${subject} message has invalid source`)
  }
  if (!Array.isArray(messageRecord['content'])) {
    throw new Error(`${subject} message has invalid content`)
  }
  const sourceRecord = source as Record<string, unknown>
  if (type === 'assistant/message') {
    if (sourceRecord['kind'] !== 'model' || !hasProviderModel(sourceRecord)) {
      throw new Error(`${subject} message must have model source`)
    }
    return
  }
  if (type !== 'tool/result') return
  if (sourceRecord['kind'] !== 'tool'
    || typeof sourceRecord['callId'] !== 'string'
    || sourceRecord['callId'] === '') {
    throw new Error(`${subject} message must have tool source`)
  }
  const content = messageRecord['content'] as unknown[]
  const block = content[0]
  if (content.length !== 1 || typeof block !== 'object' || block === null
    || (block as Record<string, unknown>)['type'] !== 'tool-result'
    || !Array.isArray((block as Record<string, unknown>)['content'])) {
    throw new Error(`${subject} message must contain one tool-result block`)
  }
  if ((block as Record<string, unknown>)['toolCallId'] !== sourceRecord['callId']) {
    throw new Error(`${subject} message has mismatched tool call ids`)
  }
}

/** Whether an unknown value carries the current provider/model pair. */
function hasProviderModel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return typeof pair['provider'] === 'string' && pair['provider'].length > 0
    && typeof pair['model'] === 'string' && pair['model'].length > 0
}

/** Reject request-header vocabulary removed with the legacy delta codec. */
function assertSupportedRequestHeader(type: string, data: unknown, location: string): void {
  if (type === 'request/header-delta') {
    throw new Error(`${location} uses unsupported legacy request/header-delta format`)
  }
  if (type === 'request/header'
    && data !== null && typeof data === 'object' && !Array.isArray(data)
    && (data as Record<string, unknown>)['reason'] === 'fallback') {
    throw new Error(`${location} uses unsupported legacy request/header reason "fallback"`)
  }
}

type SessionCallback = (...args: unknown[]) => unknown

/** Resolve one listener snapshot, including Cordis's internal dispatch checks. */
function collectSessionCallbacks(ctx: Context, args: unknown[]): SessionCallback[] {
  return [...ctx.events.dispatch('emit', args)] as SessionCallback[]
}

/** Invoke one resolved observe-only listener snapshot with per-listener containment. */
function invokeContainedSessionObservers(
  ctx: Context,
  name: 'session/event' | 'session/disposed',
  id: SessionId,
  args: unknown[],
  callbacks: SessionCallback[],
): void {
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`session "${id}": ${name} listener rejected: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`session "${id}": ${name} listener threw: ${String(error)}`)
    }
  }
}

/** All mutable lifecycle state for one exact store entry. */
interface SessionEntry {
  readonly id: SessionId
  readonly session: Session
  readonly carrier: Scoped<Session>
  readonly emitCtx: Context
  announced: boolean
  announcing: boolean
  appending: boolean
  detachRequested: boolean
  detach(): void
}

/** Store attachment for the append path; module-private to keep Session store-agnostic publicly. */
const attachments = new WeakMap<Session, SessionEntry>()

/**
 * 事件溯源的 Session：由 {@link SessionEvent} 组成的只追加日志。它是普通类而非 Service；
 * 通过 `ctx.sessions.create()` 创建实时实例，通过 {@link create} 创建未挂载实例。传入已有
 * 事件日志作为 Seed 可以重放或 Fork Session。log 保存全部事实，Surface 只决定哪些事件
 * 以何种顺序进入模型上下文；Compaction 通过 Surface Replace 隐藏旧节点，不修改原日志。
 * @typert object
 */
export class Session {
  private log: SessionEvent[] = []
  /** Single incremental owner of surface acceptance and projection state. */
  private readonly surfaceManager = new SurfaceManager(this.log)

  /** The ordered surface over this session's event log. */
  get surface(): SessionSurface {
    return this.surfaceManager
  }

  /**
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * seed boundary). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is created without a store-owned header, a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  readonly header: SessionHeader

  /** The session identity, derived from its durable header's single copy. */
  get id(): SessionId {
    return this.header.id
  }

  /**
   * The first seq appended IN THIS PROCESS: the length of the constructor
   * seed (0 without one). Events with smaller seq values entered through
   * construction — replay, fork, or resume — and were never published on the
   * `session/event` firehose (constructor seeds do not emit), so consumers
   * that replay the log as a publication substitute (telemetry adoption)
   * start here. Distinct from `header.seedLength`, the DURABLE fork-lineage
   * boundary: a resumed session's constructor seed is its full stored log,
   * while its header keeps the original fork value — this field is the
   * in-process construction fact.
   *
   * Not persisted itself: a seeded session projects it into the log as the
   * `session/end-seed` event, which is what a consumer reading STORED history
   * reads. Locate the LAST such event, not necessarily one at this seq — a
   * seed already ending in one is not re-marked, so reopening an untouched
   * session leaves that event at a smaller seq than `firstLiveSeq`. Prefer
   * this field in-process: it is exact before the marker reaches storage.
   *
   * When this lifecycle appends the marker, it occupies this seq before the
   * store attaches and therefore does not publish either. Otherwise this seq
   * holds an ordinary published write.
   */
  readonly firstLiveSeq: number

  /**
   * Create a detached session by validating and snapshotting borrowed seed
   * events and storage metadata.
   * @param id - session identity.
   * @param seed - optional borrowed replay or fork events.
   * @param header - optional borrowed storage metadata.
   * @returns a detached session.
   */
  static create(id: SessionId, seed?: readonly SessionEvent[], header?: SessionHeader): Session {
    return new Session(id, seed, header)
  }

  /**
   * Restore a detached session by taking ownership of fresh persistence values.
   * The storage format, event envelopes, sequence continuity, surface transitions,
   * and header fields are validated before the restored objects are frozen.
   * @param id - restored session identity.
   * @param seed - fresh detached events whose ownership is transferred.
   * @param header - fresh detached metadata whose ownership is transferred.
   * @returns a restored detached session.
   */
  static fromRestore(id: SessionId, seed: readonly SessionEvent[], header: SessionHeader): Session {
    return new Session(id, seed, header, 'restore')
  }

  private constructor(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    mode: 'snapshot' | 'restore' = 'snapshot',
  ) {
    const restoredHeader = mode === 'restore'
      ? validateRestoredSessionHeader(id, header)
      : undefined
    if (seed !== undefined) {
      // Seed 必须满足与 append 完全相同的不变量，防止 replay/fork 创建出任何持久化后端都
      // 无法保存的运行日志：每个事件的 data 必须可无损 JSON 序列化，seq 必须从 0 连续，
      // 因为整个系统都依赖 seq = log.length。否则错误 Seed 只会在后续写盘时才暴露，甚至
      // 造成内存日志与磁盘静默分叉。
      for (const [index, source] of seed.entries()) {
        // Seed 是持久化与重放入口，因此在一次无损 JSON 遍历中校验并复制完整事件。
        const snapshot = mode === 'restore' ? source : snapshotJsonValue(source)
        if (snapshot === undefined) {
          throw new Error(`seed event at index ${index} is not losslessly JSON-serializable`)
        }
        assertSessionEventEnvelope(snapshot, index)
        assertSupportedRequestHeader(snapshot.type, snapshot.data, `seed event at index ${index}`)
        if (snapshot.seq !== index) {
          throw new Error(`seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`)
        }
        // Seed 按与实时 append 和整段日志折叠相同的状态转换逐个接收。候选事件在进入 log
        // 前完成规划，因此失败不会只修改一半 Surface。
        try {
          this.surfaceManager.validateNext(snapshot)
        } catch (error: unknown) {
          throw new Error(`invalid seed event at index ${index}: ${error instanceof Error ? error.message : 'invalid surface metadata'}`)
        }
        this.log.push(mode === 'restore' ? freezeRestoredObject(snapshot) : deepFreeze(snapshot))
      }
    }
    this.firstLiveSeq = this.log.length
    this.header = restoredHeader ?? snapshotSessionHeader(id, header)
    // 在这里追加标记，使后端捕获创建 Seed 时 events 已包含它，无需加载时补写。冷 Session
    // 会在首次访问时恢复，重复打开不能每次都扩展日志，所以已有标记时跳过。
    if (seed !== undefined && this.log.at(-1)?.type !== 'session/end-seed') {
      this.append('session/end-seed', {})
    }
  }

  /** Cached immutable public snapshot of the private append-only log. */
  private eventsSnapshot: readonly SessionEvent[] | undefined

  /**
   * An immutable snapshot of the append-only event log. The snapshot is reused
   * until the next append; a previously returned array does not grow later.
   * Events and their nested data are deep-frozen at acceptance, so neither a
   * cast nor ordinary JavaScript can rewrite durable history.
   */
  get events(): readonly SessionEvent[] {
    this.eventsSnapshot ??= Object.freeze([...this.log])
    return this.eventsSnapshot
  }

  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): number {
    return this.log.length
  }

  /**
   * 向日志追加一个带类型事件，并通过 Store 私有的发布 Hook 同步通知观察者。热路径不等待
   * I/O，持久化插件异步缓冲。事件进入日志即视为提交；各监听器失败会分别记录并隔离，不会
   * 改变返回值，也不会阻止后续监听器观察同一事件。
   *
   * @param type - 事件类型，即 {@link SessionEventMap} 的键。
   * @param data - 事件数据，必须可无损 JSON 序列化。
   * @param opts - Surface 元数据。`surfaceOp` 决定事件怎样进入有序 Surface；
   * `sourceEventSeqs` 列出该事件派生自哪些更早事件。所有 {@link SurfaceEventType} 都必须
   * 提供，因为每个生成模型消息的事件都要声明怎样加入派生历史；`turn/start`、
   * `assistant/chunk` 等非 Surface 事件由编译器禁止传入该参数。
   * @returns 已记录事件，包含分配后的 `seq`、`time` 以及真正进入日志的 `data` 快照；
   * 后续读取 `event.data` 不会看到调用方继续修改后的输入。
   * @throws `data` 或 Surface 元数据无法无损 JSON 序列化，候选事件违反 Surface 约定，
   * 同步内部分发校验失败，或者在接收与发布尚未结束时重入 append。校验会在一次递归遍历中
   * 完成读取、验证与复制，防止有状态 getter 向校验和存储提供不同值；所有失败都发生在
   * 日志变化之前。
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T> {
    // append 是所有持久事实的统一入口：先做无损 JSON 快照和 Surface 转换校验，再提交到
    // log，最后通知观察者。事件一旦进入 log，监听器失败也不能把已提交事实撤销。
    const surfaceOpts: SurfaceIntent | undefined = opts[0]
    const surfaceMetadata = {
      ...surfaceOpts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },
      ...surfaceOpts?.surfaceOp === undefined ? {} : { surfaceOp: surfaceOpts.surfaceOp },
    }
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`)
    }
    assertSupportedRequestHeader(type, dataSnapshot, `session event "${type}"`)
    const surfaceMetadataSnapshot = snapshotJsonValue(surfaceMetadata)
    if (surfaceMetadataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable surface metadata`)
    }
    const entry = attachments.get(this)
    if (entry?.appending) {
      throw new Error('session append cannot reenter while another append is being published')
    }
    const event = deepFreeze({
      type,
      seq: this.log.length,
      time: Date.now(),
      data: dataSnapshot,
      ...(surfaceMetadataSnapshot as { surfaceOp?: unknown; sourceEventSeqs?: unknown }),
    } as unknown as SessionEvent<T>)
    this.surfaceManager.validateNext(event as SessionEvent)

    if (entry !== undefined) entry.appending = true
    try {
      let callbacks: SessionCallback[] | undefined
      const callbackArgs: unknown[] = [this, event]
      if (entry !== undefined) {
        callbacks = collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', ...callbackArgs])
      }
      this.log.push(event as SessionEvent)
      this.eventsSnapshot = undefined
      if (callbacks !== undefined && entry !== undefined) {
        invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
      }
      return event
    } finally {
      if (entry !== undefined) {
        entry.appending = false
        if (entry.detachRequested && !entry.announcing) entry.detach()
      }
    }
  }

  /** Cached fold of the request-header events — see {@link requestHeader}. */
  private headerFold: EpochHeader | undefined
  /** Log position (events consumed) the header fold has reached. */
  private headerFoldSeq = 0

  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.events)`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  requestHeader(): EpochHeader | undefined {
    if (this.headerFoldSeq < this.log.length) {
      // 每次更新后立即冻结：折叠结果是按引用暴露的 Session 状态。若消费者原地修改它，
      // 后续与日志的比较都会失去同步，因此这里让修改直接抛错，而不是接受可变别名。
      this.headerFold = deepFreeze(foldRequestHeader(this.log.slice(this.headerFoldSeq), this.headerFold))
      this.headerFoldSeq = this.log.length
    }
    return this.headerFold
  }

  /** Cached fold of `request/context` events. */
  private contextFold: RequestContext | undefined
  private contextFoldSeq = 0

  /**
   * Return the latest resolved route metadata, or `undefined` before the first
   * `request/context` event. Each event is folded once.
   * @returns the latest immutable route metadata.
   */
  requestContext(): RequestContext | undefined {
    if (this.contextFoldSeq < this.log.length) {
      for (const event of this.log.slice(this.contextFoldSeq)) {
        if (event.type === 'request/context') this.contextFold = deepFreeze({ ...event.data })
      }
      this.contextFoldSeq = this.log.length
    }
    return this.contextFold
  }

  /** The derived-message cache: frozen projections, extended per unseen node. */
  private derived: Message[] = []
  /** Surface position (nodes projected) the cache has reached. */
  private derivedNodes = 0
  /** {@link SurfaceManager.replaceGeneration} the cache was built under. */
  private derivedGeneration = 0

  /**
   * 遍历由 `surfaceOp` 标记维护的有序消息事件，派生 LLM 消息历史。Surface 是派生历史的
   * 唯一来源：每个生成消息的 append 都记录 `surfaceOp`，未标记的原始 Chunk 或 Turn 边界
   * 不会进入历史，Compaction 的 `replace` 会从派生结果中移除被覆盖节点。每个节点按
   * {@link deriveEventMessage} 规则投影。
   *
   * 结果按 Surface 节点缓存：每个节点首次出现时只投影一次，调用成本为 O(新增节点数)；
   * Surface Replace（{@link SessionSurface.replaceGeneration}）会重建缓存。每次返回新的数组
   * 快照，因此后续 append 不会扩展调用方已经持有的数组；其中的 Message 对象共享且深度
   * 冻结，并复用已经冻结的持久事件数据，不需要再次深克隆，消费者也无法修改日志。
   * @returns 由共享、冻结消息组成的新数组快照。
   */
  deriveMessages(): Message[] {
    // 模型历史不是第二份状态；这里只投影 Surface 上可生成消息的事件。Turn/Step 边界与
    // 原始 chunk 留在日志中用于恢复和展示，但不会作为重复内容再次发送给模型。
    const surface = this.surface
    const nodes = surface.nodes
    const generation = surface.replaceGeneration
    if (generation !== this.derivedGeneration) {
      this.derived = []
      this.derivedNodes = 0
      this.derivedGeneration = generation
    }
    for (const seq of nodes.slice(this.derivedNodes)) {
      // Surface 序号直接由 this.log 构造，因此 seq 必然是有效索引；非空断言表达的就是
      // 这条由构造过程保证的不变量。
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const msg = this.deriveEventMessage(this.log[seq]!)
      // Surface 节点属于能够生成消息的五种事件之一，但只有 usage、内容为空的
      // assistant/message（例如达到 max-tokens 的 Step）会投影为 null，不能进入对话历史。
      if (msg) this.derived.push(msg)
    }
    this.derivedNodes = nodes.length
    return [...this.derived]
  }

  /**
   * Instance face of the pure per-node `deriveEventMessage` export from
   * `surface.ts`.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    return deriveEventMessage(event)
  }
}

/** A fork source: either the live session object or its live store id. */
export type SessionForkSource = Session | SessionId

/**
 * Rejection codes for session forking: the fork source id is unknown to the
 * live store (`SESSION_NOT_FOUND`) or names a session object that is not the
 * store's live instance (`SESSION_NOT_LIVE`); the requested child id is
 * already taken (`SESSION_ALREADY_EXISTS`); the boundary is not a contiguous
 * existing seq (`INVALID_BOUNDARY`); or the selected prefix ends inside an
 * open turn (`OPEN_TURN`).
 */
export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_LIVE'
  | 'SESSION_ALREADY_EXISTS'
  | 'INVALID_BOUNDARY'
  | 'OPEN_TURN'

/** Typed error for session fork rejections. */
export class SessionForkError extends Error {
  constructor(message: string, public readonly code: SessionForkErrorCode) {
    super(message)
    this.name = 'SessionForkError'
  }
}

/**
 * 内存 Session Store（`ctx.sessions`），管理当前进程中正在运行的 Session。这里刻意不实现
 * 持久化；持久化插件订阅 `session/event`，并在 `session/flush` 或释放时写盘。内存生命周期
 * 与 JSONL、SQLite 等存储实现因此可以独立替换。
 */
export class SessionStore extends Service {
  private store = new Map<SessionId, SessionEntry>()
  private counter = 0

  constructor(ctx: Context) {
    super(ctx, 'sessions')
    ctx.inject(['typert'], (typeCtx) => {
      typeCtx.typert.lookups.register('session', {
        parameter: 'session',
        wire: 'sessionId',
        hostTypeSymbol: '@deepseek-ai/dsh-session#Session',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId),
      })
    })
  }

  /**
   * Create a session owned by the calling fiber: disposing that fiber stops
   * event notification and removes the session from the store. `options.seed`
   * populates the session with a copy of those events (replay/fork);
   * `options.meta` attaches creation metadata (validated absolute `cwd`, seed
   * and parent lineage, and delegation depth) as the immutable
   * {@link SessionHeader} (the store fills `version`/`id`/`createdAt`).
   *
   * For an agent whose session must be torn down IN ORDER with its loop (so the
   * loop's final events are published before the store attachment ends), do NOT use this
   * — fold the session lifecycle into the agent's own effect via
   * {@link prepare} + {@link enter} + {@link announce} (see
   * `dsh-agent-loop`'s creation transaction).
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the live session, already entered and announced.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path (storage backends key directories off it).
   */
  create(id?: SessionId, options?: CreateSessionOptions): Session {
    const session = this.prepare(id, options)
    // 创建一个归调用方 Fiber 所有的 Effect。先 yield detach 再 announce，这样
    // session/created 监听器抛错时，生成器 Effect 会调用已经 yield 的 disposer 回滚挂载，
    // 不会泄漏 Store 条目和发布监听器。
    this.ctx.effect(function* (this: SessionStore) {
      yield this.enter(session)
      this.announce(session)
    }.bind(this), 'sessions.create()')
    return session
  }

  /**
   * Build a session WITHOUT entering it into the store — validate the id/cwd and
   * construct the {@link Session} (with its immutable {@link SessionHeader}).
   * Pairs with {@link enter} + {@link announce}: a caller that owns a composite
   * `ctx.effect` (the agent factory) folds the session lifecycle into that ONE
   * effect so a fiber unload tears the session + agent down as a single ORDERED
   * chain rather than as racing sibling effects — which would remove the publication hooks
   * before the driver's closing events commit, dropping them.
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header. With
   *   `seedSource: 'persistence'`, metadata and events must be fresh detached
   *   graphs whose ownership transfers to this call: they are validated and
   *   frozen in place through {@link Session.fromRestore}, so the caller must
   *   retain no mutable aliases.
   * @returns the constructed session, NOT yet in the store.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path.
   */
  prepare(id?: SessionId, options?: PrepareSessionOptions): Session {
    let sessionId: SessionId
    if (id === undefined) {
      do sessionId = SessionId(`session-${++this.counter}`)
      while (this.store.has(sessionId))
    } else {
      sessionId = SessionId(id)
    }
    if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`)
    if (options?.seedSource === 'persistence') {
      return Session.fromRestore(sessionId, options.seed, options.meta)
    }
    const seed = options?.seed
    const meta = options?.meta
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: meta?.createdAt ?? Date.now(),
      ...meta?.cwd === undefined ? {} : { cwd: meta.cwd },
      ...meta?.parentSession === undefined ? {} : { parentSession: meta.parentSession },
      ...meta?.seedLength === undefined ? {} : { seedLength: meta.seedLength },
      ...meta?.origin === undefined ? {} : { origin: meta.origin },
      ...meta?.delegationDepth === undefined ? {} : { delegationDepth: meta.delegationDepth },
      ...meta?.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
    }
    return Session.create(sessionId, seed, header)
  }

  /**
   * Enter a {@link prepare}d session into the store: install the module-private
   * append publication hooks and add it to the store. Returns the DETACH
   * disposer (hooks + store removal). Does NOT emit `session/created` —
   * the caller yields this disposer inside its effect and THEN calls
   * {@link announce}, so a throwing `session/created` listener rolls the attach
   * back instead of leaking it.
   *
   * Re-checks the id for a duplicate: `prepare` and `enter` are public
   * cross-package primitives and a caller may interleave arbitrary work (or
   * another create) between them, so a stale prepared session must NOT overwrite
   * a live store entry of the same id — its detach disposer would later delete
   * the REAL session. The {@link create} convenience and the agent factory call
   * the two back-to-back so they never trip this, but the public API cannot
   * assume that.
   *
   * @param session - a {@link prepare}d session not yet in the store.
   * @returns the detach disposer (publication hooks + store removal). When called from
   *   a synchronous `session/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   * @throws if a session with this id is already in the store.
   */
  enter(session: Session): () => void {
    const id = session.id
    const carrier = scopeTarget(session, scopeOf(this.ctx))
    // 任意未发布准备完成后，这里是唯一权威冲突检查点；同一 id 只能有一个事务成功发布。
    if (this.store.has(id)) throw new Error(`session "${id}" already exists`)
    if (attachments.has(session)) throw new Error(`session "${id}" is already attached to a store`)
    const entry: SessionEntry = {
      id,
      session,
      carrier,
      emitCtx: this.ctx,
      announced: false,
      announcing: false,
      appending: false,
      detachRequested: false,
      detach: () => { this.detachEntered(entry) },
    }
    this.store.set(id, entry)
    attachments.set(session, entry)
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      // 生命周期监听器可能持有高级 detach 能力。同步创建或 append 发布完全返回前，条目和
      // 发布 Hook 必须保持存活；之后再发出配对的销毁通知。
      if (entry.announcing || entry.appending) {
        entry.detachRequested = true
        return
      }
      entry.detach()
    }
    return detach
  }

  /** Remove one exact entered session and emit its paired disposal when announced. */
  private detachEntered(entry: SessionEntry): void {
    entry.detachRequested = false
    // 过期能力不能移除属于后来同 id 生命周期的观察器或存储状态。
    /* v8 ignore next -- enter() rejects replacement while this single-shot detach capability is live. */
    if (this.store.get(entry.id) !== entry) return
    this.store.delete(entry.id)
    attachments.delete(entry.session)
    if (entry.announced) this.emitDisposed(entry)
  }

  /** Emit `session/created` exactly once for an {@link enter}ed session (with
   * the carrier {@link enter} captured). Separate from {@link enter} so the
   * caller can yield the detach disposer first (rollback safety — see
   * {@link enter}).
   * @param session - the entered session to announce to listeners.
   * @throws if the session is not live or its announcement already began,
   *   including a reentrant call from a creation listener. */
  announce(session: Session): void {
    const entry = this.liveEntryFor(session)
    if (entry.announced || entry.announcing) {
      throw new Error(`session "${entry.id}" was already announced`)
    }
    // emit 前先标记：Cordis 可能通知前面的监听器后再抛错。回滚仍需为这次部分送达的创建
    // 配对销毁通知，同时阻止监听器递归创建第二条生命周期边。
    entry.announced = true
    const callbackArgs: unknown[] = [session]
    entry.announcing = true
    try {
      const callbacks = collectSessionCallbacks(this.ctx, [entry.carrier, 'session/created', session])
      for (const callback of callbacks) {
        // 同步异常会故意向上传播并否决发布，之前 yield 的 detach 随后发出配对销毁通知。
        // 异步函数仍可赋给 void 监听器，所以还要观察其返回 Promise；异步 rejection 已来不及
        // 回滚，只能记录，不能让它变成未处理异常。
        const returned: unknown = callback(...callbackArgs)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`session "${entry.id}": session/created listener rejected: ${String(error)}`)
        })
      }
    } finally {
      entry.announcing = false
      if (entry.detachRequested && !entry.appending) entry.detach()
    }
  }

  /** Emit the paired teardown notification with per-listener containment. */
  private emitDisposed(entry: SessionEntry): void {
    const callbackArgs: unknown[] = [entry.session]
    try {
      const callbacks = collectSessionCallbacks(this.ctx, [entry.carrier, 'session/disposed', entry.session])
      invokeContainedSessionObservers(this.ctx, 'session/disposed', entry.id, callbackArgs, callbacks)
    } catch (error: unknown) {
      this.ctx.logger.warn(`session "${entry.id}": session/disposed dispatch threw: ${String(error)}`)
    }
  }

  /**
   * Dispatch the awaited `session/flush` durability checkpoint for `session`,
   * with the carrier captured at {@link enter}. THE flush entry point: the
   * store owns the carrier, so callers (the checkpoint policy's per-request
   * barrier, goal-round-driver's idle checkpoint, teardown drains, and consumers
   * that flush themselves before reading storage) must come through here
   * rather than dispatch a raw `ctx.parallel('session/flush', …)` — one owner,
   * one spelling, and the scoped-dispatch invariant can pin it.
   * @param session - the session whose buffered events must reach durable storage.
   * @returns whether at least one durability listener participated, after every
   *   listener has settled successfully.
   * @throws the first registered listener failure after every listener settles.
   */
  async flush(session: Session): Promise<boolean> {
    const { carrier } = this.liveEntryFor(session)
    const callbackArgs: unknown[] = [session]
    const callbacks = collectSessionCallbacks(this.ctx, [carrier, 'session/flush', session])
    const results = await Promise.allSettled(callbacks.map((callback) => {
      try {
        return callback(...callbackArgs)
      } catch (error: unknown) {
        // 保留监听器原始 rejection 值；flush 是由调用方处理的失败边界，而 Cordis 监听器
        // 可以抛出任意值。
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        return Promise.reject(error)
      }
    }))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure !== undefined) throw failure.reason
    return callbacks.length > 0
  }

  /** Return the exact live entry; detached/prepared objects reject. */
  private liveEntryFor(session: Session): SessionEntry {
    const entry = attachments.get(session)
    if (entry === undefined || this.store.get(entry.id) !== entry) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    return entry
  }

  /**
   * Look up a live session.
   * @param id - the session id to look up.
   * @returns the session, or undefined when no live session has that id.
   */
  get(id: SessionId): Session | undefined {
    return this.store.get(id)?.session
  }

  /**
   * All live sessions, in creation order.
   * @returns a fresh array; mutating it does not affect the store.
   */
  list(): Session[] {
    return [...this.store.values()].map(entry => entry.session)
  }

  /**
   * Create a live child session from a stable prefix of a live source.
   * `boundary` is an inclusive source event seq; omitted means the source's
   * current last event. The selected slice may end with a between-turn event
   * but must not end inside an open turn.
   *
   * @param source - Live source session object or id.
   * @param boundary - Inclusive source event seq to fork through; omitted means
   *   the source's current last event, and omitted on an empty source forks an
   *   empty child.
   * @param childSessionId - Optional child session id; omitted delegates to
   *   `SessionStore`'s id policy.
   * @returns The created live child session.
   */
  fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session {
    if (childSessionId !== undefined && this.get(childSessionId) !== undefined) {
      throw new SessionForkError(`session "${childSessionId}" already exists`, 'SESSION_ALREADY_EXISTS')
    }
    const liveSource = this._resolveForkSource(source)
    const seed = this._forkSeed(liveSource, boundary)
    return this.create(childSessionId, {
      seed,
      meta: {
        ...liveSource.header.cwd !== undefined ? { cwd: liveSource.header.cwd } : {},
        parentSession: liveSource.id,
        seedLength: seed.length,
      },
    })
  }

  private _forkSeed(session: Session, requestedBoundary: number | undefined): SessionEvent[] {
    const events = session.events
    const lastEvent = events.at(-1)
    let boundary: number
    if (requestedBoundary !== undefined) {
      boundary = requestedBoundary
    } else {
      if (lastEvent === undefined) return []
      boundary = lastEvent.seq
    }
    if (!Number.isSafeInteger(boundary) || boundary < 0) {
      throw new SessionForkError(
        `fork boundary for session "${session.id}" must be a non-negative safe integer, got ${String(boundary)}`,
        'INVALID_BOUNDARY',
      )
    }
    if (boundary >= events.length) {
      const lastSeq = events.at(-1)?.seq
      throw new SessionForkError(
        `fork boundary ${boundary} does not exist in session "${session.id}" (last seq: ${lastSeq ?? 'none'})`,
        'INVALID_BOUNDARY',
      )
    }

    const boundaryEvent = events[boundary]
    if (boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
      throw new SessionForkError(
        `fork boundary ${boundary} does not match a contiguous event seq in session "${session.id}"`,
        'INVALID_BOUNDARY',
      )
    }
    const lastTurnBoundary = events.slice(0, boundary + 1)
      .findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (lastTurnBoundary?.type === 'turn/start') {
      throw new SessionForkError(
        `fork boundary ${boundary} in session "${session.id}" ends inside open turn ${lastTurnBoundary.data.turn}`,
        'OPEN_TURN',
      )
    }

    return events.slice(0, boundary + 1)
  }

  private _resolveForkSource(source: SessionForkSource): Session {
    if (typeof source === 'string') {
      const session = this.get(source)
      if (session === undefined) throw new SessionForkError(`session "${source}" not found`, 'SESSION_NOT_FOUND')
      return session
    }

    const live = this.get(source.id)
    if (live === undefined) {
      throw new SessionForkError(`session "${source.id}" not found`, 'SESSION_NOT_FOUND')
    }
    if (live !== source) throw new SessionForkError(`session "${source.id}" is not the live store instance`, 'SESSION_NOT_LIVE')
    return source
  }

}

export default SessionStore
