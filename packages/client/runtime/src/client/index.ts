/** 面向浏览器的运行时服务：槽位、会话、工作区和连接流分发。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// 仅用于带入 ctx.remote 的类型合并。这里有意使用 gateway 的 Client 端，而不是
// api-remotes 的接口；后者会导入 Host tsdown 生成的产物，而本项目位于 Host 构建图中。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertContext } from '@deepseek-ai/dsh-typert-protocol'
import type { MaybeSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from './slots.ts'
import { SessionRuntime } from './sessions/service.ts'
import type { SessionListState } from './sessions/service.ts'
import { WorkspaceRuntime } from './workspaces/service.ts'
import type { ConversationSnapshot } from './sessions/conversation.ts'
import type { UseProjection } from './sessions/projection-store.ts'
import { ConversationEventRegistry } from './conversation/event-registry.ts'
import { ConversationViewRegistry } from './conversation/view-registry.ts'

export { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'

export { SlotRegistry } from './slots.ts'
export { ConversationEventRegistry } from './conversation/event-registry.ts'
export { ConversationViewRegistry } from './conversation/view-registry.ts'
export { ConversationNodeAssembler } from './sessions/conversation-assembler.ts'
export { ConversationLocationIndex } from './sessions/conversation-location-index.ts'
export { conversationContextKey } from './contract/conversation.ts'
export type {
  ChatConversationViewNode, ConversationContextReader, ConversationEventInput,
  ConversationLocationData, ConversationLocationDataScope, ConversationLocationDataStore,
  ConversationStepDataMap,
  ConversationLocation, ConversationMatch, ConversationMatchResult,
  ConversationNodeContext, ConversationNodeDefinition, ConversationPreviousContext,
  ConversationPublication, ConversationTimelineSnapshot, ConversationTurnDataMap, ConversationViewBuilder,
  ConversationViewDefinition, ConversationViewNode, ConversationViewSnapshotMap,
  ConversationViewSnapshotStore, StepLocation, TurnLocation,
} from './contract/conversation.ts'
export type { ConversationRuntime } from './sessions/conversation-assembler.ts'
export type { RootOwnerProps } from './slots.ts'
export { SessionCreateError, SessionRuntime, scopeOf, workspaceTitleOf } from './sessions/service.ts'
export { indexSubagentDescendants } from './sessions/subagent-lineage.ts'
export type { SubagentDescendantSummary } from './sessions/subagent-lineage.ts'
// provide 通道与客户端测试 runtime 共享，实例化/投影只有一套实现，不维护可能漂移的
// 测试侧镜像。
export { SessionProvideChannel } from './sessions/provide.ts'
export type { SessionProvideChannelHost } from './sessions/provide.ts'
export { createScope } from './agents/scope.ts'
export type { AgentScopeHandle } from './agents/scope.ts'
export { DirectoryBrowseError, WorkspaceCreateError, WorkspaceRuntime } from './workspaces/service.ts'
export { resolveWorkspacePath } from './workspaces/path.ts'
// 此处仅导出接口；scope 实现及其 Host 传输属于 dsh-client-ui-settings，参见该包的
// settings-scope.ts。
export type {
  SettingsScope, SettingsScopeSnapshot, SettingsScopeSpec,
} from './contract/settings-scope.ts'
export type { Session } from './sessions/session.ts'
export type { ISession, ProjectionsFace, SessionFace } from './contract/session.ts'
export type { AgentContext, ISessions } from './contract/sessions.ts'
export type { IWorkspaces } from './contract/workspaces.ts'
export type {
  SessionBinding, SessionListState, SessionProvideContribution, SessionProvideDescriptor, SessionSummary,
} from './sessions/service.ts'
export type { SessionListPhase, SessionSearchResultItem, SubagentCatalogSnapshot } from './sessions/manager.ts'
export type { SubagentAddress, JobView } from '@deepseek-ai/dsh-client-connection/client'
export type { WorkspaceListPhase } from './workspaces/manager.ts'
export type { WorkspaceListState } from './workspaces/service.ts'
export type {
  DirectoryEntry, DirectoryListing, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-connection/client'
// Runtime 拥有快照 store；web-react 只负责绑定到 React。
export { createSnapshotStore, defineStore, shallowEqual } from './contract/store.ts'
export type {
  EngineStoreHandle, EngineStoreInstance, ObservableSnapshot, SnapshotStore,
} from './contract/store.ts'
export type {
  AssistantBlock, AssistantMessageNode, AssistantProvenanceView, AssistantRequestConfig,
  AssistantTiming, ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot,
  CommandNode, CompactionSummaryNode, ComposerPhase,
  ContextMessageNode, ConversationNode, ConversationSnapshot, ModelRetryNode, QueuedMessage,
  LegacyConversationSlice, PartialAssistant, RunningToolCall,
  SteeringMessageNode, TodoItem, ToolCallBlock, ToolResultNode, TurnErrorNode, TurnMaxTokensNode,
  UnknownSurfaceNode, UserMessageNode,
} from './sessions/conversation.ts'
export {
  EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, toAssistantBlock, toAssistantBlocks,
} from './sessions/conversation.ts'
export { emptyAssistantBlock } from './sessions/partial.ts'
export { isTokenDelta } from './sessions/assistant-timing.ts'
export { contextForm, contextProvenance } from './sessions/context-provenance.ts'
export { displayFailureMessage } from './sessions/failure-display.ts'
export type {
  ConversationContext, ConversationContextOriginKind,
} from './sessions/conversation-context.ts'
export type {
  ContextProvenanceView, ContextRole, KnownContextForm,
} from './sessions/context-provenance.ts'
export type {
  ConversationPromptSnapshot, RequestInspectionSnapshot, RequestPromptChange, RequestView,
} from './sessions/request-inspection.ts'
export { PendingWait } from './sessions/pending.ts'
export type {
  PendingInteraction, PendingInteractionStatus, PendingKind, PendingPayloads,
} from './sessions/pending.ts'
// 投影值 store 采用推送模型，详见 docs/subsystems/session-projection.md。Host 按键计算
// 完整值，使业务域无需附带客户端代码即可提供投影能力。
export type {
  ProjectionsBaseline, ProjectionValueStore, SessionProjectionMap, UseProjection,
} from './sessions/projection-store.ts'
export type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** 完成声明合并后的客户端 Cordis 上下文。 */
export type ClientContext = Context

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertContextMap {
    /** 客户端 Agent scope 身份；Agent 与 session 共用一个传输 ID。 */
    agent: TypertContext<SessionId>
  }
}

/** 提供给 session scope UI 条目的对话快照 selector hook。 */
export type UseConversationSession = SnapshotSelectorHook<ConversationSnapshot>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /**
   * Session 标准工具组的实际成员。ui-slots 声明空席位，拥有数据主体的 runtime 合并
   * 具体类型；每个 session scope 槽位组件都会从框架获得这些成员。
   */
  interface SessionStandardProps {
    useSession: SnapshotSelectorHook<ConversationSnapshot>
    /** 框架解析出的 session ID，所有者无需传入。 */
    sessionId: SessionId
    /** 框架第五个 hook 席位：按键读取投影；undefined 表示能力不存在。 */
    useProjection: UseProjection
  }
  /** 当前 session 变化时仍保持挂载的槽位所用标准工具组。 */
  interface SessionMaybeStandardProps {
    useSession: MaybeSnapshotSelectorHook<ConversationSnapshot>
    /** 当前 session ID；无 session 状态下不存在。 */
    sessionId: SessionId | undefined
    /** 按键读取投影；没有当前 session 时，所有键都读取为不存在。 */
    useProjection: UseProjection
  }
  /** 注入每个全局槽位组件的 props。 */
  interface GlobalStandardProps {
    useSessions: SnapshotSelectorHook<SessionListState>
    /** 读取真实 Workspace 及其独立基线生命周期的 selector hook。 */
    useWorkspaces: SnapshotSelectorHook<import('./workspaces/service.ts').WorkspaceListState>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 某个槽位的定义或注册集合发生变化。
     * @mode emit
     * @param key - 发生变化的 SlotMap 键。
     */
    'slots/changed'(key: string): void
    /**
     * 一个连接代次已建立或重新建立。由传输数据派生的缓存必须把现有状态视为过期并
     * 重新拉取；命令目录采用此方式，队列镜像则通过 session 重同步路径自行重置。
     * @mode emit
     */
    'connection/reset'(): void
  }
  interface Context {
    slots: import('./slots.ts').SlotRegistry
    /** 从事件到业务 Context 的 Definition 注册表。 */
    conversationEvents: import('./conversation/event-registry.ts').ConversationEventRegistry
    /** 按 target 保存的 Conversation 快照构建器注册表。 */
    conversationViews: import('./conversation/view-registry.ts').ConversationViewRegistry
    /** 仅暴露对外接口；具体服务保留在 runtime 内部。 */
    sessions: import('./contract/sessions.ts').ISessions
    /** 仅暴露对外接口；具体服务保留在 runtime 内部。 */
    workspaces: import('./contract/workspaces.ts').IWorkspaces
  }
}

/** 必需服务：传输 handle 和客户端 Typert 注册表。 */
export const inject = ['connection', 'typert', 'remote', 'remote.commands']

/** 挂载浏览器 runtime 服务和连接流。
 * @param ctx - 客户端 Cordis 上下文。
 */
export function apply(ctx: Context): void {
  ctx.plugin(SlotRegistry)
  const conversation = {
    events: new ConversationEventRegistry(ctx),
    views: new ConversationViewRegistry(ctx),
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const sessions = new SessionRuntime(ctx, connection.api, ctx.remote, conversation)
  ctx.typert.contexts.registerClient('agent', {
    identity: candidate => sessions.scopeOf(candidate),
  })
  const workspaces = new WorkspaceRuntime(ctx, connection.api, sessions)
  ctx.effect(
    () => workspaces.startInitialSelection(),
    'runtime: initial Workspace selection',
  )
  const loop = connection.start({
    onMuxEnvelope: (envelope) => {
      sessions.handleMuxEnvelope(envelope)
    },
    onHostEnvelope: (envelope) => {
      sessions.handleHostEnvelope(envelope)
      workspaces.handleHostEnvelope(envelope)
      // 转发事件桥：session 层会忽略没有 session 路由的注册表帧。本插件拥有帧接收点，
      // 因此把已解码帧直接交给 Remote 服务，再由其分发给 `ctx.remote.$on` 订阅者；
      // 没有消费者直接读取帧。
      const frame = envelope.payload
      if (frame.type === 'host/remote-event') ctx.remote.$dispatch(frame.event, frame.args)
    },
    onConnected: () => {
      sessions.handleConnected()
      workspaces.handleConnected()
      ctx.emit('connection/reset')
    },
    onStateChange: (state) => {
      // 连接代次终止会在下一代任何帧到达前触发；重连从打开流开始重放，早于
      // onConnected。这是丢弃代次范围交互状态的唯一安全时机。
      if (state === 'reconnecting') {
        sessions.handleDisconnected()
      }
    },
  })
  ctx.effect(() => () => { loop.stop() }, 'runtime: connection stream loop')
}
