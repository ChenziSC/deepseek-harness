import type { Context } from '@deepseek-ai/cordis'
import type { ConversationViewDefinition } from '../contract/conversation.ts'
import { ConversationDefinitionRegistry } from './definition-registry.ts'

/** 按 target 保存 Conversation 快照构建器的 runtime 注册表。 */
export class ConversationViewRegistry extends ConversationDefinitionRegistry<ConversationViewDefinition> {

  /** @param ctx - 拥有本注册表的客户端 Runtime 上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'conversationViews')
  }

  /**
   * 在调用方生命周期内注册一个名称唯一的视图构建器 factory。
   * @param definition - target 构建器贡献项。
   * @returns 幂等 disposer。
   */
  register(definition: ConversationViewDefinition): () => void {
    return this.registerDefinition(
      definition.target,
      definition,
      `conversation view target "${definition.target}" is already registered`,
      `conversationViews.register(${JSON.stringify(definition.target)})`,
    )
  }
}
