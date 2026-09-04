/** Experimental Service Definition for read-only external knowledge retrieval. @module @deepseek-ai/dsh-experimental-knowledge */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { KnowledgeSearchRequest, KnowledgeSearchResult } from './types.ts'

export type * from './types.ts'
export { KnowledgeChunkId, KnowledgeDocumentId } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    knowledge: Knowledge
  }
}

/** Stable caller-visible failure categories for knowledge retrieval. */
export type KnowledgeErrorCode =
  | 'KNOWLEDGE_INVALID_REQUEST'
  | 'KNOWLEDGE_CANCELLED'
  | 'KNOWLEDGE_SEARCH_FAILED'

/** Typed knowledge failure whose message is safe for callers. */
export class KnowledgeError extends HarnessError {
  declare readonly code: KnowledgeErrorCode

  // The base stores the value; this signature narrows its open string code.
  // oxlint-disable-next-line typescript/no-useless-constructor
  constructor(message: string, code: KnowledgeErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}

/** Abstract read-only knowledge retrieval service. */
export abstract class Knowledge extends Service {
  constructor(ctx: Context) {
    super(ctx, 'knowledge')
  }

  /**
   * Retrieve ranked evidence for one query.
   * @param request - validated query text and caller-owned result limit.
   * @param signal - optional cooperative cancellation signal.
   * @returns provider-neutral ranked evidence.
   */
  abstract search(request: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResult>
}

export default Knowledge
