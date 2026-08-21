/**
 * 浏览器 Conversation 插件。`contract/` 是分别实现的 Skeleton 与 Chat 域之间共享的类型
 * 边界，`apply.ts` 负责二者的 Slot 组装。
 */
export type {} from './conversation-nodes/assistant.ts'
export type {} from './conversation-nodes/command.ts'
export type {} from './conversation-nodes/compaction.ts'
export type {} from './conversation-nodes/fallback.ts'
export type {} from './conversation-nodes/message.ts'
export type {} from './conversation-nodes/retry.ts'
export type {} from './conversation-nodes/tool.ts'
export type {} from './conversation-nodes/turn-error.ts'
export type {} from './conversation-nodes/turn-max-tokens.ts'
export type {} from './conversation-nodes/turn-tail.ts'

export { apply, inject } from './apply.ts'
export { ConversationController } from './service.ts'
export type { IConversation } from './service.ts'
export type { DraftAttachmentId } from './input/contract.ts'

export type {
  CallId, ChatStoreState, SelectionTarget, ViewTab,
} from './contract/views.ts'
export type { ConversationKey } from './locales.ts'
export type {
  AssistantChatData, ChatNode, ChatNodeDataMap, ChatNodeKind, ManualCompactionChatData,
  RetryChatData, ToolChatData, TurnTailChatData,
} from './contract/chat-nodes.ts'
export type {
  ChatFileMentions, ChatNodeOwnerProps, ChatNodeViewProps,
  ChatStore, ChatViewInjected, ChatViewSlotProps, CommandRowOwnerProps, CommandRowProps, ComposerBarInjected,
  ComposerAttachment, ComposerAttachmentsOwnerProps, ComposerAttachmentsProps, ComposerChainProps, ConversationInjected,
  ConversationHeaderLineageOwnerProps, ConversationSessionHeaderInjected, ConversationSessionInjected,
  ConversationSlotProps, ConvViewOwnerProps,
  ConvViewProps, DetailsInjected, DetailsSlotProps, DetailsToolOwnerProps, EmptyWorkspaceOwnerProps, HeroBrandMarkOwnerProps,
  MessageImagesOwnerProps, MessageImagesProps, RenderMessageImages, TurnTailOwnerProps, UseChatNodeTurnData,
} from './contract/slots.ts'
// 导出规则见 packages/client/AGENTS.md。

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 只暴露对外接口；具体服务保留在本插件内部。 */
    conversation: import('./service.ts').IConversation
  }
}
