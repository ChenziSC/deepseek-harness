/** 浏览器附件插件：填充 Conversation 的 Composer 与消息图片 Slot。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ComposerAttachments } from './ComposerAttachments.tsx'
import { MessageImages } from './MessageImages.tsx'

/** 本展示插件依赖的 Slot 注册表。 */
export const inject = ['slots']

/** 注册附件展示，但不把 React 组件作为包值导出。 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments',
    locale: 'conversation',
  }, ComposerAttachments))
  ctx.slots.inject('conversation.message.images', () => ctx.slots.register({
    name: 'conversation.message.images',
    locale: 'conversation',
  }, MessageImages))
}
