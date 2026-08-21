/** Web 端子智能体目录、导航，以及定址会话输入区的所有者。 */
import type {
  ClientContext, SessionId, SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SubagentHeaderLineage, type SubagentCatalogInjected } from './SubagentHeaderLineage.tsx'
import {
  SubagentReadOnlyComposer, type SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type SubagentKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 子智能体目录与只读输入区文案。 */
    'subagent': SubagentKey
  }
}

export type {
  SubagentCatalogInjected, SubagentHeaderLineageProps,
} from './SubagentHeaderLineage.tsx'
export type {
  SubagentReadOnlyComposerProps, SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'

/** 会话 Slot 与 Session 导航所需的服务。 */
export const inject = ['sessions', 'slots', 'locale']

/** Claim the composer for one-shot history or an unavailable continuation owner. */
function selectReadOnlySubagent(owner: ComposerChainProps): SubagentReadOnlyMatch | null {
  const subagent = owner.session?.subagent
  if (subagent === undefined || subagent === null) return null
  if (subagent.address.mode === 'one-shot') return { reason: 'one-shot' }
  if (subagent.parentAvailable) return null
  // 父会话离线但仍在运行、可继续的子会话保留默认输入区：其中输入被禁用，
  // 但仍保留同一个主“停止”操作，因而可以中断子会话。子会话停止后再由本只读视图接管。
  return owner.session?.running === true ? null : { reason: 'parent-unavailable' }
}

/**
 * Client 插件主体：注册子智能体目录和只读输入区位置。
 * @param ctx - Client 根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-subagent: dictionaries')
  const sessions = ctx.sessions
  const catalogActions = (_parentSessionId: SessionId): SubagentCatalogInjected => ({
    openChild(address: SubagentAddress) {
      sessions.openSubagent(address)
    },
    refresh(parentSessionId: SessionId) {
      void sessions.refreshSubagents(parentSessionId)
    },
    setCatalogOpen(parentSessionId: SessionId, open: boolean) {
      sessions.setSubagentCatalogOpen(parentSessionId, open)
    },
  })
  ctx.slots.inject(
    'conversation.session.header.lineage',
    () => ctx.slots.register({
      name: 'conversation.session.header.lineage',
      locale: NS,
      inject: catalogActions,
    }, SubagentHeaderLineage),
  )
  ctx.slots.inject(
    'conversation.composer',
    () => ctx.slots.register({
      name: 'conversation.composer',
      priority: -10,
      locale: NS,
      select: selectReadOnlySubagent,
    }, SubagentReadOnlyComposer),
  )
}
