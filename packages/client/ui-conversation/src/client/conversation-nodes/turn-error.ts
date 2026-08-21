import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, TurnErrorNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { displayFailureMessage } from '@deepseek-ai/dsh-client-runtime/client'
import { chatNode } from './common.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** 记录在轮次结束原因中的终止失败。 */
    'turn-error': TurnErrorNode
  }
}

interface TurnErrorState {
  readonly turn: number
  readonly failure?: {
    readonly seq: number
    readonly time: number
    readonly message: string
    readonly code?: string
  }
}

function lastStep(context: ConversationNodeContext<TurnErrorState>): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return 0
  return location.turn.steps.at(-1)?.step ?? 0
}

function failureFrom(match: ConversationMatch): TurnErrorState['failure'] | undefined {
  if (match.event.type !== 'turn/end' || match.event.data.reason.kind !== 'error') return undefined
  const failure = match.event.data.reason.error
  return {
    seq: match.event.seq,
    time: match.event.time,
    message: displayFailureMessage(failure),
    code: failure.code,
  }
}

function fallbackState(context: ConversationNodeContext<TurnErrorState>): TurnErrorState | undefined {
  const end = context.matches.find(match => failureFrom(match) !== undefined)
  if (end?.event.type !== 'turn/end') return undefined
  const failure = failureFrom(end)
  if (failure === undefined) return undefined
  return { turn: end.event.data.turn, failure }
}

/**
 * 终止轮次失败 Definition。重试发生在失败轮次内部，因此该轮次的 `llm/retry`
 * 历史绝不会抑制此终止行；model-retry 节点会单独渲染该历史。
 */
export const turnErrorDefinition: ConversationNodeDefinition<TurnErrorState> = {
  kind: 'turn-error',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('turn-error start requires turn/start')
    return { turn: match.event.data.turn }
  },
  update: (context, match) => {
    const failure = failureFrom(match)
    return failure === undefined ? context.state : { ...context.state, failure }
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state?.failure === undefined) return null
    const failure = state.failure
    const node: TurnErrorNode = {
      kind: 'turn-error',
      seq: failure.seq,
      time: failure.time,
      turn: state.turn,
      step: lastStep(context),
      message: failure.message,
      ...failure.code === undefined ? {} : { code: failure.code },
    }
    return chatNode(context, 'turn-error', node.seq, node)
  },
}

/**
 * Register the terminal Turn-error business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnErrorConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(turnErrorDefinition)
}
