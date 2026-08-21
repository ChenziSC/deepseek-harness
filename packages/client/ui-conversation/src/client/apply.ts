/** 注册 Conversation 组件、共享 store 与服务回调。 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveSlotLabel, type BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import {
  resolveWorkspacePath, type ISessions, type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
// 仅导入类型：带入 ctx.settingsScope 的 Context 合并。跨插件协作只经由服务，绝不导入值
//（客户端 Bundle 纯度门禁）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// 仅导入类型：带入 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ViewTab } from './contract/views.ts'
import type {
  ApprovalWait, ChatNodeTurnDataInjected, ChatScrollPosition, ChatViewInjected, ComposerBarInjected,
  ComposerChainProps, ConversationInjected, ConversationSessionHeaderInjected, ConversationSessionInjected,
  DetailsInjected,
} from './contract/slots.ts'
import type { InputNotice } from './input/contract.ts'
import { createChatStore } from './stores.ts'
import { ConversationController, UnsupportedImageMediaTypeError } from './service.ts'
import type { IConversation } from './service.ts'
import { ComposerBlockRegistry } from './input/blocks.ts'
import type { ComposerBlock } from './input/blocks.ts'
import { InputHub } from './input/hub.ts'
import { ComposerSubmissionPolicy } from './input/submission-policy.ts'
import { InputBar } from './skeleton/InputBar.tsx'
import { EnterBehaviorRow } from './settings/EnterBehaviorRow.tsx'
import type { EnterBehaviorRowInjected } from './settings/EnterBehaviorRow.tsx'
import { ChatView } from './chat/ChatView.tsx'
import { StatsLine } from './chat/StatsLine.tsx'
import { ApprovalPanel } from './skeleton/ApprovalPanel.tsx'
import { todoDockEntry } from './skeleton/TodoPanel.tsx'
import { queueDockEntry } from './queue/QueueDock.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { ConversationSession, ConversationSessionHeader } from './skeleton/ConversationSession.tsx'
import { DetailsPanel } from './skeleton/DetailsPanel.tsx'
import { en, NS, zh, type ConversationKey } from './locales.ts'
import { registerConversationNodes } from './conversation-nodes/register.ts'
import { registerChatNodeRenderers } from './chat/register-node-renderers.ts'
import { CONVERSATION_SETTINGS_NAMESPACE, type ConversationSettings } from '../submission-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Conversation 骨架、Chat 流、命令、详情与 dock 的文案。 */
    conversation: ConversationKey
  }
}

/** Conversation 插件依赖的服务。 */
export const inject = [
  'slots', 'layout', 'sessions', 'workspaces', 'locale', 'connection', 'remote', 'settingsScope',
  'conversationEvents', 'conversationViews',
]

// Composer bar hooks 隔间在无 Session 时使用的静态数据源。使用模块常量，可让渲染侧的
// 逐数据源 hook 缓存（observableHook）在每次无 Session 渲染中保持同一 identity。
const ABSENT_NOTICES = {
  getSnapshot: (): InputNotice | null => null,
  subscribe: () => () => {},
}
/** 没有 Session，也就没有需要阻止的提交；遵循上方相同的单一 identity 规则。 */
const ABSENT_BLOCK = {
  getSnapshot: (): ComposerBlock | undefined => undefined,
  subscribe: () => () => {},
}
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()
const ABSENT_LEXICON = {
  getSnapshot: () => EMPTY_LEXICON,
  subscribe: () => () => {},
}
const ABSENT_MENU_LAUNCHER = {
  getSnapshot: (): string | null => null,
  subscribe: () => () => {},
}

const CHAT_NODE_INJECT: ChatNodeTurnDataInjected = {
  hooks: {
    turnData: ({ useSession }, nodeKey) => function useTurnData(key) {
      return useSession((snapshot) => {
        const location = snapshot.chat.nodes.get(nodeKey)?.location
        return location?.kind === 'turn' || location?.kind === 'step'
          ? location.turn.data.get(key)
          : undefined
      })
    },
  },
}

/** 解析 Session-scoped Conversation 接口（按 scope 寻址的发送/取消）；失败时明确报错。 */
function scopedConversation(sessions: ISessions, id: SessionId): IConversation {
  const scoped = sessions.scope(id)
  if (scoped === undefined) throw new Error(`ui-conversation: session "${id}" resolved no scope`)
  const conversation = scoped.get('conversation')
  if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable through the session scope')
  return conversation
}

/** 从公开服务注册解析包内附件操作。 */
function concreteConversation(ctx: Context): ConversationController {
  const conversation = ctx.get('conversation') as ConversationController | undefined
  if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable')
  return conversation
}

/** Chain 路由：存在待处理 Approval 时接管 Composer；此选择器是纯函数，只读取 owner props。 */
function selectApproval({ interactions }: ComposerChainProps): ApprovalWait | null {
  return interactions.find((i): i is ApprovalWait => i.kind === 'approval') ?? null
}

/** 挂载 Conversation 插件。
 * @param ctx - 客户端根 Context。
 */
export function apply(ctx: Context): void {
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces
  const layout = ctx.layout
  const slots = ctx.slots

  registerConversationNodes(ctx)
  registerChatNodeRenderers(ctx)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-conversation: dictionaries')

  // 注册时文案（View tab 标签）以 thunk 形式通过已绑定 translate 读取，因此切换活动 locale
  // 时无需重新注册；组件则改为读取标准 `t` seat。
  const t = ctx.locale.bind(NS)

  // 在 apply 阶段构造，使 store identity 始终绑定到当前 fiber。
  const chatStore = createChatStore()
  const submissionPolicy = new ComposerSubmissionPolicy(
    ctx.settingsScope.bind<ConversationSettings>({ namespace: CONVERSATION_SETTINGS_NAMESPACE }),
  )

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'composer-enter',
    order: 20,
    locale: NS,
    inject: (): EnterBehaviorRowInjected => ({
      hooks: { busyEnter: submissionPolicy.busyEnter },
      setBusyEnter: (behavior) => { submissionPolicy.setBusyEnter(behavior) },
    }),
  }, EnterBehaviorRow))

  // Chat 语义读取位置按 Session 保存，因此 tab ring 重新挂载 View 时，可跨 View 切换与宽度
  // reflow 保留。这里有意不持久化：重新加载页面仍采用打开后跳到底部的默认行为。
  const chatScrollPositions = new Map<SessionId, ChatScrollPosition>()

  const viewTabs = (): ViewTab[] => {
    const tabs: ViewTab[] = []
    for (const entry of slots.entries('conversation.view')) {
      /* v8 ignore next -- unreachable: list registration validates id at load. */
      if (entry.options.id === undefined) continue
      tabs.push({ id: entry.options.id, label: resolveSlotLabel(entry.options.label) ?? entry.options.id })
    }
    return tabs
  }
  const views = {
    list: viewTabs,
    subscribe: (fn: () => void) => slots.subscribe('conversation.view', fn),
    version: () => slots.getVersion('conversation.view'),
  }

  // 逐 Session 输入状态机注册表（SessionInputResolver 接口）；下方服务共享同一实例，并以
  // ctx.conversation.input 发布。
  const inputHub = new InputHub(ctx, t)

  // Composer block 注册表：知道某 Session 无法发送的插件会在此建立 block，例如没有
  // Adapter 服务该 Session 路由时的 ui-model-selection；Bar 只读取自身 Session 的 store。
  // 依赖不能反向流动：本包不得导入那些掌握阻止原因的插件。
  const composerBlocks = new ComposerBlockRegistry()

  // 输入状态机通过标准 provide 通道向每个 session-scope Slot 组件提供 `input` hook 和两个
  // 公开 action。组件实例化会触发 Shell 创建：逐 Session 延迟创建，并由 scope disposer 拆除。
  ctx.effect(() => sessions.provide({
    hooks: ['input'],
    props: ['inputActions'],
    resolve: (binding) => {
      const shell = inputHub.shellFor(binding)
      return {
        hooks: { input: shell.state },
        props: { inputActions: shell.actions },
      }
    },
  }), 'ui-conversation: input standard-kit provider')

  // 常驻且允许当前 Session 缺省的 Shell。它拥有稳定的 Hero/Composer 框架，严格 Session
  // Slot 只填充各自绑定到 Session 的区域。
  slots.register({
    name: 'conversation',
    locale: NS,
    children: {
      'conversation.session': { kind: 'single', scope: 'session' },
      'conversation.session.header': { kind: 'single', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
      'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
    },
    inject: (sessionId: SessionId | undefined): ConversationInjected => ({
      hooks: { composerBlock: sessionId === undefined ? ABSENT_BLOCK : composerBlocks.storeFor(sessionId) },
      selectWorkspace: async (workspaceId) => {
        const nextId = await workspaces.connectWorkspace(workspaceId)
        if (sessionId !== undefined && nextId !== sessionId) {
          const from = inputHub.shell(sessionId)
          const draft = from.snapshot.draft
          const imageIds = from.snapshot.imageIds
          const next = inputHub.shell(nextId)
          if (imageIds.length === 0 || next.addImages(imageIds)) {
            if (draft !== '') {
              next.setDraft(draft)
              from.setDraft('')
            }
            if (imageIds.length > 0) {
              for (const id of imageIds) from.removeImage(id)
            }
          }
        }
        sessions.open(nextId)
      },
    }),
  }, ConversationRoot)

  // 严格 Session body 填充常驻 scrollport，但不拥有它。因此选择 Workspace 后首个空白
  // Session 出现时，Hero/Composer 路径仍保持固定。
  slots.register({
    name: 'conversation.session',
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
    },
    store: chatStore,
    inject: (sessionId: SessionId, _actions: BoundActions<typeof chatStore>): ConversationSessionInjected => {
      const conversation = concreteConversation(ctx)
      return {
        views,
        releaseSessionImages: (id) => { conversation.releaseSessionImages(id) },
        bindDraftMirror: write => inputHub.shell(sessionId).bindMirror(write),
      }
    },
  }, ConversationSession)

  // Header chrome 位于常驻 scrollport 上方，但与 body 和 View 条目共享同一个逐 Session
  // Chat store（包括活动 View）。
  slots.register({
    name: 'conversation.session.header',
    locale: NS,
    children: {
      'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
    store: chatStore,
    inject: (): ConversationSessionHeaderInjected => ({
      views,
      open: (id) => { sessions.open(id) },
    }),
  }, ConversationSessionHeader)

  // 默认 Composer body：位于 Composer chain fallback 内的独立 single Slot。公开状态机接口
  // 经由上方 provide 通道到达；键盘命令接口与 stop/retry 动作通过本 inject 传入（仅包内，
  // Hub 与 Bar 属于同一插件）。session-maybe 表示没有当前 Session 时不提供状态机接口，
  // hooks 隔间改为绑定静态空数据源；它们是模块常量，因此 observableHook 缓存与 hook 顺序
  // 在状态切换前后保持稳定。
  slots.register({
    name: 'conversation.composer.bar',
    locale: NS,
    // Bar 工具行中的两个命名控制 seat：Plan 位于访问控制旁，Model 位于右侧。在各自所有者
    // 插件注册前保持为空。
    children: {
      'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.plan': { kind: 'single', scope: 'session' },
      'conversation.input.model': { kind: 'single', scope: 'session' },
    },
    inject: (sessionId: SessionId | undefined): ComposerBarInjected => {
      if (sessionId === undefined) {
        return {
          keyboard: undefined,
          addImages: undefined,
          removeImage: undefined,
          draftImages: undefined,
          resolveSubmitMode: (running, gesture, steeringAvailable) =>
            submissionPolicy.resolve(running, gesture, steeringAvailable),
          toggleCommandMenu: undefined,
          stop: undefined,
          command: undefined,
          hooks: { notices: ABSENT_NOTICES, lexicon: ABSENT_LEXICON, menuLauncher: ABSENT_MENU_LAUNCHER },
        }
      }
      const conversation = concreteConversation(ctx)
      const shell = inputHub.shell(sessionId)
      const inputTriggers = inputHub.inputTriggers(sessionId)
      return {
        keyboard: shell,
        addImages: (files) => {
          try {
            const images = conversation.createDraftImages(files)
            if (!shell.addImages(images.map(image => image.id))) {
              conversation.releaseDraftImages(images)
            }
            return null
          } catch (error: unknown) {
            if (error instanceof UnsupportedImageMediaTypeError) {
              // 使用正向文案：支持列表固定在 imageMediaType 中，列出支持类型比回显被拒绝的
              // MIME type 更清晰。
              return t('image.unsupportedType')
            }
            return error instanceof Error ? error.message : String(error)
          }
        },
        removeImage: (id) => {
          conversation.releaseDraftImage(id)
          shell.removeImage(id)
        },
        draftImages: ids => conversation.draftImages(ids),
        resolveSubmitMode: (running, gesture, steeringAvailable) =>
          submissionPolicy.resolve(running, gesture, steeringAvailable),
        toggleCommandMenu: inputTriggers === undefined
          ? undefined
          : (selection) => {
            shell.dismissPopup()
            const snapshot = shell.snapshot
            inputTriggers.toggleSource('command', {
              trigger: '/',
              query: '',
              quoted: false,
              position: snapshot.draft.slice(0, selection.start).trim() === '' ? 'leading' : 'inline',
              span: { ...selection, draftRev: snapshot.draftRev },
            })
          },
        stop: () => {
          scopedConversation(sessions, sessionId).cancel().catch(() => {
            // Stop 失败通过 snapshot.promptError 展示，无需恢复其他状态。
          })
        },
        command: async (line) => {
          const session = sessions.binding(sessionId)?.session
          if (session === undefined) return false
          const result = await session.command(line)
          return result.ok && result.value.matched
        },
        hooks: {
          notices: shell.notices,
          lexicon: shell.lexicon,
          menuLauncher: inputTriggers?.launcher ?? ABSENT_MENU_LAUNCHER,
        },
      }
    },
  }, InputBar)

  // Approval 接管：本包刚声明的 chain 中由 selector 路由的条目，采用 ui-user-questions 的
  // 注册模式。条目放在这里，是因为回答 Approval 属于 Conversation 核心 UX，而非可选 Tool。
  // 不需要业务接口，数据与动作都由匹配 carrier 携带。priority 为 1：Question 接管默认是 0，
  // 两类交互同时待处理时由 Question 获胜，因为 Question 是模型正在等待的对话，而 Approval
  // 只阻塞一次 Tool 调用。先回答 Question 不会遗留 Approval；Question 解决后会立即重新选举。
  slots.register({ name: 'conversation.composer', select: selectApproval, priority: 1, locale: NS }, ApprovalPanel)

  // Chat View：本包刚声明的 View ring 中第一个条目。ChatView 只拥有稳定有序的 Node 列表；
  // 业务 Renderer 在唯一 Node seat 后方按 key 独立注册。
  slots.register({
    name: 'conversation.view',
    id: 'chat',
    order: 0,
    label: () => t('view.chat'),
    locale: NS,
    children: {
      'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
      'conversation.message.images': { kind: 'single', scope: 'session' },
    },
    store: chatStore,
    inject: (sessionId: SessionId, actions: BoundActions<typeof chatStore>): ChatViewInjected => {
      const conversation = concreteConversation(ctx)
      const scoped = scopedConversation(sessions, sessionId)
      return {
        openDetails: (target) => {
          actions.select(target)
          layout.openDetails()
        },
        fileMentions: owner => ctx.get('chatFileMentions')?.forClosing(owner),
        openFile: (path) => {
          const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
          return workspaces.openPath(resolveWorkspacePath(cwd, path))
        },
        loadOlder: () => { void scoped.loadOlder() },
        loadImage: attachment => conversation.resolveImage(sessionId, attachment),
        // 未注册的 `trajectory` id 也是安全的：tab ring 会回退到第一个 View，未消费的
        // inspect target 则保持静默。
        inspectCall: (callId) => {
          actions.setInspect({ callId })
          actions.setView('trajectory')
        },
        chatScroll: {
          save: (position) => {
            if (position === null) chatScrollPositions.delete(sessionId)
            else chatScrollPositions.set(sessionId, position)
          },
          read: () => chatScrollPositions.get(sessionId) ?? null,
        },
        forkAt: (seq) => {
          sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
            .then((childId) => { sessions.open(childId) })
            .catch(() => {
              // Fork 或子 Session 重命名失败时，源 View 保持不变。
            })
        },
      }
    },
  }, ChatView)

  // Session 统计信息跟随 Composer（composer.dock 属于 stats-line family）。
  slots.register({ name: 'conversation.composer.dock', id: 'stats', order: 0, locale: NS }, StatsLine)

  // Class 插件挂载（packages/AGENTS.md 的服务形式）：服务以 `conversation` 注册自身，并位于
  // 独立子 fiber。展示注册方直接依赖各自 Slot 声明；只有需要 Conversation action 的位置
  // 才保留对本服务的依赖。
  ctx.plugin(ConversationController, { input: inputHub, blocks: composerBlocks })

  // Plan 条带挂载在 Queue 行上方的 Input dock 中，二者采用相同布局方式。
  ctx.plugin(todoDockEntry)

  // 只读 Queue dock 条目通过相同注册路径进入上方声明的 Input dock。
  ctx.plugin(queueDockEntry)

  slots.register({
    name: 'details',
    locale: NS,
    children: {
      'conversation.details.tool': { kind: 'single', scope: 'session' },
    },
    store: chatStore,
    inject: (): DetailsInjected => ({
      closeDetails: () => { layout.closeDetails() },
    }),
  }, DetailsPanel)

}
