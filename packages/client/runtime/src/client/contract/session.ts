/**
 * Session 的对外接口。功能包不会接触具体 Session 类：组件通过 `useSession`（即
 * ObservableSnapshot 部分）读取对话状态，编排代码只能调用下列行为方法。扩展本接口
 * 就是在明确扩大功能可对 session 执行的操作，也会扩大所有测试 fixture 必须 stub 的
 * 范围。历史暂存、传输帧分发等 runtime 内部入口仍留在类上，不在这里暴露。
 */
import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  MessageId, PromptContentPart, QueueAction, RpcResult, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ConversationSnapshot } from '../sessions/conversation.ts'
import type { ObservableSnapshot } from './store.ts'

/** 按键读取投影的接口，即 useProjection 解析路径；参见 ProjectionValueStore。 */
export interface ProjectionsFace {
  /**
   * 某个投影键对应的身份稳定裸 observable；值缺失表现为 `undefined` 快照，而不是
   * 接口本身缺失。
   * @param key - 投影键。
   * @returns 该键的值接口。
   */
  faceOf(key: string): ObservableSnapshot<unknown>
}

/** 身份以及功能可对 session 调用的行为方法。 */
export interface ISession {
  /** Session 的宿主身份；与 Agent ID 位于同一轴。 */
  readonly sessionId: SessionId
  /** Host 按键计算的投影值，即 useProjection 席位。 */
  readonly projections: ProjectionsFace
  /**
   * 向 session 发送 Prompt。
   * @param content - 文本及浏览器持有的临时图片上传。
   * @param mode - 'queue' 追加 turn；'steer' 中断正在运行的 turn。
   * @returns 接受结果或业务错误；错误也会镜像到 snapshot.promptError。
   */
  prompt(content: PromptContentPart[], mode: 'queue' | 'steer'): Promise<RpcResult<{ accepted: true }>>
  /**
   * 解析本 session 引用的一张持久图片。
   * @param attachmentId - 从折叠后的 session 日志中取得的不透明 ID。
   * @returns 已认证的引用和解码后字节。
   */
  readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RpcResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>>
  /**
   * 对仍在等待的队列项执行编辑、删除或严格 steer 操作。
   * @param itemId - Agent 所有的 inbox occurrence 身份。
   * @param action - 请求的队列操作。
   * @returns 接受结果，或业务/传输错误。
   */
  updateQueue(itemId: MessageId, action: QueueAction): Promise<RpcResult<{ accepted: true }>>
  /**
   * 取消正在运行的 turn。等待中的队列工作会保留，并在 Host 达到取消静止状态后按
   * FIFO 顺序继续。
   * @returns 接受结果或业务错误。
   */
  cancel(): Promise<RpcResult<{ accepted: true }>>
  /**
   * 重命名本 session。用户显式设置的标题会固定，不再自动重新生成。
   * @param title - 原始标题文本，由 Host 规范化后接受。
   * @returns 规范化后的标题及其事件 seq，或业务错误。
   */
  rename(title: string): Promise<RpcResult<{ title: string; seq: number }>>
  /**
   * 向过去扩展历史窗口，即分页加载更早消息。
   * @returns 完成信号；失败会写入 snapshot.openState/loadingOlder。
   */
  loadOlder(): Promise<void>
  /**
   * 针对本 session 的 Agent 执行一行斜杠命令。这里只表达准入语义，Host 执行器会
   * 持久记录完整生命周期。
   * @param line - 包含开头斜杠的完整命令行。
   * @returns 准入结果，或 Remote 接口的错误分支。
   */
  command(line: string): Promise<RemoteResult<{ matched: boolean }>>
}

/**
 * 完整对外接口：行为方法加对话读取侧（`useSession` hook 的源）。
 * `SessionBinding.session` 和 provide 通道都携带此类型。
 */
export type SessionFace = ISession & ObservableSnapshot<ConversationSnapshot>
