import { Service } from '@deepseek-ai/cordis'

/** Conversation Definition 注册表共用的生命周期和稳定条目存储。 */
export abstract class ConversationDefinitionRegistry<Definition> extends Service {
  protected readonly definitions = new Map<string, Definition>()
  private listeners = new Set<() => void>()
  private cached: readonly Definition[] = []

  /**
   * 按注册顺序返回引用稳定的 Definitions。
   * @returns 当前 Definitions。
   */
  entries(): readonly Definition[] {
    return this.cached
  }

  /**
   * 观察低频注册表变化。
   * @param listener - 同步失效回调。
   * @returns 取消订阅回调。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 在调用方生命周期内注册一个键唯一的 Definition。
   * @param key - 注册表内唯一键。
   * @param definition - 贡献的 Definition。
   * @param duplicateMessage - 键已被占用时抛出的错误消息。
   * @param effectName - Cordis effect 诊断标签。
   * @returns 幂等 disposer。
   */
  protected registerDefinition(
    key: string,
    definition: Definition,
    duplicateMessage: string,
    effectName: string,
  ): () => void {
    if (this.definitions.has(key)) throw new Error(duplicateMessage)
    const owner = this.ctx
    const dispose = owner.effect(() => {
      this.definitions.set(key, definition)
      this.refresh()
      return () => {
        if (this.definitions.get(key) !== definition) return
        this.definitions.delete(key)
        this.refresh()
      }
    }, effectName)
    return () => { void dispose() }
  }

  /** 刷新缓存条目并同步通知订阅者失效。 */
  protected refresh(): void {
    this.cached = [...this.definitions.values()]
    for (const listener of this.listeners) listener()
  }
}
