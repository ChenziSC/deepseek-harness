/**
 * 客户端 Agent scope 基元：创建带所属 Agent 身份标签的 Cordis 上下文。机制与宿主
 * `dsh-scope` 架构对应（无操作插件 fiber + 上下文标签 + `Context.filter` 路由谓词），
 * 但结构有意不同：filter 直接位于 actx，而不是单独载体对象上，因此 scope 分发就是
 * 普通 cordis 调用：`actx.bail(actx, event, payload)` / `actx.emit(actx, ...)`，无需
 * 包装器。宿主的分发主体是业务 Agent 对象，所以需要分离载体；客户端 scope 事件只
 * 携带 ID，actx 自然就是主体。另一处差异是 scope key 使用按值比较的 branded
 * `SessionId`，而非对象身份。Agent 与 session 一一对应并共用一个 ID，不另设
 * AgentId brand，因此客户端 scope 身份就是该传输 ID。最后，客户端限定的是 Agent
 * 身份而非活跃 Agent 对象；冷 session 的宿主 Agent 已销毁，但客户端 actx 仍需存活，
 * 以便查看历史。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote, TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol'

/** 携带一个 Agent 身份及其 scoped Remote 命名空间的客户端 Cordis Context。 */
export type AgentContext = Omit<Context, 'remote'> & {
  readonly remote: TypertClientRemote & TypertRemoteScopeApi<'agent'>
}

/** 由 {@link createScope} 写入的 Context 标签。 */
const kScope = Symbol('dsh.client.scope')

/** 创建出的 Agent scope 及其销毁边界。 */
export interface AgentScopeHandle {
  /**
   * 带标签的上下文：scope 自有注册和 scoped 分发都经过它。将其作为分发主体时，
   * 事件会路由到本 Agent 的带标签监听器以及所有无标签监听器。
   */
  ctx: AgentContext
  /** 支撑该 scope 的 fiber；销毁它会拆除 scope 拥有的全部注册。 */
  fiber: Fiber
}

/** 所有 Agent scope fiber 共用的无操作插件。 */
function agentScope(): void {}

/**
 * 在 `ctx` 下创建 Agent scope：一个无操作插件 fiber，其上下文携带 Agent 标签和分发
 * filter。无标签监听器全局接收，带标签监听器只接收匹配 Agent 的事件。通过返回 ctx
 * 建立的注册会随 fiber 一同销毁。
 * @param ctx - 挂载 scope fiber 的客户端根上下文。
 * @param key - 所属 Agent 身份，即路由标签；Agent ID 等于 session ID。
 * @returns 带标签的上下文及其支撑 fiber。
 */
export function createScope(ctx: Context, key: SessionId): AgentScopeHandle {
  const fiber = ctx.plugin(agentScope)
  const scoped = fiber.ctx.extend({
    [kScope]: key,
    [CordisContext.filter](listenerCtx: Context): boolean {
      const tag = scopeOf(listenerCtx)
      return tag === undefined || tag === key
    },
  }) as AgentContext
  return {
    fiber,
    ctx: scoped,
  }
}

/**
 * 读取上下文继承到的最近 Agent 标签。
 * @param ctx - 任意客户端上下文。
 * @returns Agent 身份（即 session ID）；根上下文返回 undefined。
 */
export function scopeOf(ctx: Context): SessionId | undefined {
  return (ctx as Context & { [kScope]?: SessionId })[kScope]
}
