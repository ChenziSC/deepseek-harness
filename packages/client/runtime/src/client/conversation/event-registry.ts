import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '../contract/conversation.ts'
import { ConversationDefinitionRegistry } from './definition-registry.ts'

/** 独立所有的 Conversation 业务 Definitions 在 runtime 中的注册表。 */
export class ConversationEventRegistry extends ConversationDefinitionRegistry<ConversationNodeDefinition> {
  private fallback: ConversationNodeDefinition | undefined

  /** @param ctx - 拥有本注册表的客户端 Runtime 上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'conversationEvents')
  }

  /**
   * 在调用方生命周期内注册一个名称唯一的业务 Definition。
   * @param definition - Definition 贡献项。
   * @returns 幂等 disposer。
   */
  register(definition: ConversationNodeDefinition): () => void {
    assertDefinitionTarget(definition)
    return this.registerDefinition(
      definition.kind,
      definition,
      `conversation Definition "${definition.kind}" is already registered`,
      `conversationEvents.register(${JSON.stringify(definition.kind)})`,
    )
  }

  /**
   * 注册唯一 fallback，仅在没有普通 Definition 匹配时使用。
   * @param definition - fallback Definition。
   * @returns 幂等 disposer。
   */
  registerFallback(definition: ConversationNodeDefinition): () => void {
    assertDefinitionTarget(definition)
    const target = definition.target
    if (target === undefined) throw new Error('conversation fallback Definition must declare a target')
    if (this.fallback !== undefined) throw new Error('conversation fallback Definition is already registered')
    const owner = this.ctx
    const dispose = owner.effect(() => {
      this.fallback = definition
      this.refresh()
      return () => {
        if (this.fallback !== definition) return
        this.fallback = undefined
        this.refresh()
      }
    }, `conversationEvents.registerFallback(${JSON.stringify(definition.kind)})`)
    return () => { void dispose() }
  }

  /**
   * 返回当前用于未匹配事件的 fallback。
   * @returns 已安装 fallback；不存在时返回 undefined。
   */
  fallbackEntry(): ConversationNodeDefinition | undefined {
    return this.fallback
  }
}

function assertDefinitionTarget(definition: ConversationNodeDefinition): void {
  if ((definition.target === undefined) !== (definition.buildViewNode === undefined)) {
    throw new Error(
      `conversation Definition "${definition.kind}" must declare target and buildViewNode together`,
    )
  }
}
