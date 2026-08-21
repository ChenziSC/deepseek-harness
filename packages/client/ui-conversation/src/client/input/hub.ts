/**
 * InputHub：SessionInputResolver 的实现（`ctx.conversation.input`）。每个会话拥有
 * 一个 SessionInputShell，在 sessions provide 实体化期间创建；标准 kit 的 'input'
 * 条目本身就是创建触发器。外壳由作用域 disposer 销毁，实例与作用域共享生命周期。
 * hub 在每个会话 actx 上注册限定作用域的输入变更监听器，是 ui-input-trigger bail
 * 事件唯一的消费侧，并拥有默认出口编排。每个会话都是真实 Host 实体，因此默认
 * 出口只有一条无条件 prompt 路径。
 */
import type { ClientContext, ISessions, SessionBinding, SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerController, SubmitImageAttachment, SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { queueReadFaceOf } from '../queue/store.ts'
import type { ComposerKeyboard, DraftAttachmentId, SessionInputResolver, SessionInput } from './contract.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import type { PopupDismissFace } from './facade.ts'
import { SessionInputShell } from './facade.ts'

/** 用于解析每会话弹窗的结构化命令接口。 */
interface CommandFace {
  popupFor(actx: ClientContext): PopupDismissFace
}

/** 延迟解析的附件发送接口，使 hub/服务构造保持无环。 */
interface ConversationAttachmentFace {
  sendSession(
    session: SessionFace,
    text: string,
    imageIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome>
  serializeDraftImages(imageIds: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]>
  releaseDraftImage(id: DraftAttachmentId): void
}

/** 按会话寻址的输入门面注册表：SessionInputResolver 接口加编辑器层附加能力。 */
export class InputHub implements SessionInputResolver {
  private readonly shells = new Map<SessionId, SessionInputShell>()

  /**
   * @param ctx - 客户端根上下文；服务在每次调用时延迟解析，启动顺序保持自由。
   * @param t - conversation 命名空间翻译 thunk，在调用时读取当前语言。
   */
  constructor(
    private readonly rootCtx: ClientContext,
    private readonly t: TranslateNS<'conversation'>,
  ) {}

  /**
   * 为一个会话作用域 ctx 解析门面，即 SessionInputResolver 接口。
   * @param actx - 会话作用域上下文。
   * @returns 常驻的每会话门面。
   */
  for(actx: ClientContext): SessionInput {
    const sessions = this.sessions()
    const id = sessions.scopeOf(actx)
    if (id === undefined) throw new Error('conversation.input.for requires a session scope')
    return this.shell(id)
  }

  /**
   * 一个会话绑定的常驻外壳，也是 provide 通道入口。它在作用域实体化期间、作用域
   * 记录可查询之前调用，因此由 binding 提供数据，slash/popup 依赖也必须使用 thunk。
   * 它把限定作用域的事件监听器和销毁逻辑接入会话作用域。
   * @param binding - 会话装配句柄。
   * @returns 外壳。
   */
  shellFor(binding: SessionBinding): SessionInputShell {
    const existing = this.shells.get(binding.sessionId)
    if (existing !== undefined) return existing
    const { sessionId: id, session, ctx: actx } = binding
    const shell = new SessionInputShell({
      actx,
      inputTriggers: () => this.controller(actx),
      popup: () => this.popup(actx),
      queue: queueReadFaceOf(session),
      defaultSink: (text, imageIds, mode, signal) => this.sink(session, text, imageIds, mode, signal),
      steerQueue: () => { void this.steerQueue(session, shell) },
      commandImages: {
        serialize: ids => this.conversation().serializeDraftImages(ids),
        // 有意与 serialize 不对称：release 在提交 RPC 之后完成，此时会话销毁可能
        // 已卸载 conversation 服务，与上方作用域 disposer 采用相同容忍策略；
        // 即使预览 URL 泄漏，也会随 document 销毁。
        release: (ids) => {
          const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
          for (const imageId of ids) conversation?.releaseDraftImage(imageId)
        },
        unsupportedNotice: token => this.t('command.imagesUnsupported', {
          command: token.trim().replace(/^\//u, ''),
        }),
      },
    })
    this.shells.set(id, shell)
    // 唯一销毁轴：监听器、外壳和 Map 条目都随作用域 fiber 生命周期，没有任何内容
    // 比作用域活得更久。
    actx.effect(() => {
      const offs = [
        actx.on('slash/input-begin-command', req =>
          shell.beginCommand(req.claim, req.span) ? true : undefined),
        actx.on('slash/input-insert-reference', req =>
          shell.insertReference(req.reference, req.span) ? true : undefined),
        actx.on('slash/input-consume-token', req =>
          shell.consumeToken(req.guard) ? true : undefined),
        actx.on('slash/input-insert-text', req =>
          shell.insertText(req.text, req.span, req.continue === true) ? true : undefined),
      ]
      return () => {
        for (const off of offs) off()
        const drafts = shell.snapshot.imageIds
        shell.dispose()
        this.shells.delete(id)
        const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
        for (const imageId of drafts) conversation?.releaseDraftImage(imageId)
      }
    }, 'conversation.input: session shell')
    return shell
  }

  /**
   * 按会话 ID 获取常驻外壳，这是服务接口路径。provide 通常已经创建外壳，此路径
   * 覆盖直接按 ID 寻址的访问。
   * @param id - 会话 ID。
   * @returns 外壳。
   */
  shell(id: SessionId): SessionInputShell {
    const existing = this.shells.get(id)
    if (existing !== undefined) return existing
    const binding = this.sessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.input: session "${id}" resolved no binding`)
    return this.shellFor(binding)
  }

  /**
   * InputBar 专用键盘命令接口：外壳以结构类型满足它；仅供包内使用，通过
   * composer-bar 条目的 inject 传入，绝不跨插件边界。
   * @param id - 会话 ID。
   * @returns 作为键盘接口的外壳。
   */
  keyboard(id: SessionId): ComposerKeyboard {
    return this.shell(id)
  }

  /**
   * 为编辑器外观解析可选 Slash 控制器，使其无需输入触发字符即可打开共享候选菜单。
   * @param id - 会话 ID。
   * @returns 常驻控制器；缺少 ui-input-trigger 时为 undefined。
   */
  inputTriggers(id: SessionId): InputTriggerController | undefined {
    const actx = this.sessions().scope(id)
    return actx === undefined ? undefined : this.controller(actx)
  }

  /**
   * 默认出口：乐观清除后发送 prompt。会话始终是真实 Host 实体，在选择工作区时
   * 已实体化，因此只有一条路径；首次 prompt 失败也是普通 prompt 失败，通过
   * promptError 显示横幅，且只有草稿未被触碰时才恢复。
   */
  private sink(
    session: SessionFace,
    text: string,
    imageIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
  ): Promise<SubmitOutcome> {
    if (text === '' && imageIds.length === 0) return Promise.resolve({ kind: 'success' })
    return this.conversation().sendSession(session, text, imageIds, mode, signal)
  }

  /**
   * 按 FIFO 顺序把所有仍待处理的排队消息引导进运行中的轮次，与队列停靠栏逐行
   * 按钮执行相同 strict-steer 操作。轮次中途关闭（`steer-unavailable`）或条目已被
   * Agent 认领（`queue-item-not-found`）时静默收敛；真正失败才显示一条编辑器提示。
   * 重复触发（如快速按两次空草稿快捷键）依赖 `queue-item-not-found` 收敛：快照可能
   * 仍列出 Host 已 steer 的条目，重复 strict steer 应为静默无操作。
   * @param session - 被寻址的 Host 会话。
   * @param shell - 常驻外壳，也是提示出口。
   */
  private async steerQueue(session: SessionFace, shell: SessionInputShell): Promise<void> {
    const queued = session.getSnapshot().queue.filter(item => item.placement === 'queued')
    if (queued.length === 0) return
    for (const item of queued) {
      const result = await session.updateQueue(item.id, { kind: 'steer' })
      if (result.ok) continue
      if (result.error.code === 'steer-unavailable' || result.error.code === 'queue-item-not-found') return
      shell.notify('error', this.t('queue.steerFailed'))
      return
    }
  }

  private controller(actx: ClientContext): InputTriggerController | undefined {
    const inputTriggers = this.rootCtx.get('inputTriggers')
    return inputTriggers?.sessionOf(actx)
  }

  private popup(actx: ClientContext): PopupDismissFace | undefined {
    const command = this.rootCtx.get('commandUi') as CommandFace | undefined
    return command?.popupFor(actx)
  }

  private sessions(): ISessions {
    const sessions = this.rootCtx.get('sessions')
    if (sessions === undefined) throw new Error('conversation.input: sessions service unavailable')
    return sessions
  }

  private conversation(): ConversationAttachmentFace {
    const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
    if (conversation === undefined) throw new Error('conversation.input: conversation service unavailable')
    return conversation
  }
}
