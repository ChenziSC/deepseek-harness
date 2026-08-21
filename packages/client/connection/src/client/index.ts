/**
 * 浏览器 wire client。插件选择 fixture 或 HTTP transport，提供共享 API client，并由运行时
 * 对象层使用自身 sink 启动 stream controller。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc, type RpcFetch } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

// ---- 约定重导出（browser-safe ApiProxy channel 与核心类型）----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop 类型通过 ConnectionHandle.start 公开，Controller 保留在包内。
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'
export type { RpcFetch } from './rpc.ts'

/** 每次连接握手完成后发布的可观察 Host 描述。 */
export interface HostDescriptionSource {
  /** 最近一个已连接代次的描述；连接前和重连期间不存在。 */
  getSnapshot(): HostDescription | undefined
  /** 订阅描述替换与连接丢失。 */
  subscribe(listener: () => void): () => void
}

/** 必需服务：无；这里是 wire root。 */
export const inject: string[] = []

/**
 * 插件启动前安装到页面全局对象的 Carrier 覆盖。由 Server 提供的 Web App 不设置它，使用
 * HTTP + WebSocket；拥有不同物理 Transport 的 Shell（例如 Worker Preview 的 postMessage
 * Tunnel）在此提供两部分实现，无需 fork 本插件。
 */
export interface ClientTransportHooks {
  /** 构建 API Carrier：unary 调用加两条下行事件流。 */
  createApiClient(): IApiClient
  /** 通用 unary RPC channel（Typert Gateway）的 Transport。 */
  fetch: RpcFetch
  /**
   * 模块系统的 Bundle Transport。Carrier 同时拥有 Bundle 字节时存在，例如 Worker Tunnel；
   * 由 Server 提供的 Web App 不设置，因为其 Bundle 经 HTTP 加载。
   */
  loadBundle?(url: string): Promise<void>
}

/** 携带 {@link ClientTransportHooks} 的页面全局对象；由 Server 提供的 Web App 中不存在。 */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
}

/**
 * ctx.connection 服务 API：API client 加 one-shot Controller 启动器。运行时插件在对象层
 * 就绪时提供 sink，使 Connection 不感知具体 Consumer。
 */
export interface ConnectionHandle {
  /** 共享 API client；启动时根据页面 URL 选择 fixture 或真实实现。 */
  readonly api: IApiClient
  /** 当前页面 authority 是否为 loopback；非浏览器 Context 默认为 true。 */
  readonly isLoopback: boolean
  /** 连接代次范围的 Host 事实，包括账户 Home 与原生路径打开能力。 */
  readonly hostDescription: HostDescriptionSource
  /** 同一个 Connection Transport 上的通用逻辑 RPC channel。 */
  readonly rpc: ClientConnectionRpc
  /**
   * 使用 Consumer 的 Frame sink 启动连接、抽取和重连循环。Stream 只允许一个 Consumer
   *（运行时对象层）拥有，第二次调用会抛错。
   * @param sinks - Frame/状态回调。
   * @param config - 重连/backoff 可调参数。
   * @returns 循环的停止 handle。
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * 客户端插件主体：按页面模式选择 API，并提供 ctx.connection。
 * @param ctx - 客户端 Cordis Context。
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__
  const api: IApiClient = fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc(transport?.fetch)
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
