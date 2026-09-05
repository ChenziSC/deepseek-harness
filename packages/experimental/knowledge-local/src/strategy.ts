/** Pure resolution of provider defaults and caller-selected retrieval strategy. */

import {
  KnowledgeError,
  type KnowledgeDenseIndex,
  type KnowledgeRerank,
  type KnowledgeRetrieval,
  type KnowledgeSearchStrategy,
  type ResolvedKnowledgeSearchStrategy,
} from '@deepseek-ai/dsh-experimental-knowledge'

/** Provider policy used to resolve one search strategy. */
export interface KnowledgeSearchPolicy {
  readonly defaultRetrieval: KnowledgeRetrieval
  readonly defaultDenseIndex: KnowledgeDenseIndex
  readonly defaultRerank: Exclude<KnowledgeRerank, 'auto'>
  readonly allowedRetrieval: readonly KnowledgeRetrieval[]
  readonly allowedDenseIndexes: readonly Exclude<KnowledgeDenseIndex, 'auto'>[]
  readonly allowedRerank: boolean
}

/** Dense index capabilities recorded by one loaded index. */
export interface KnowledgeSearchCapabilities {
  readonly autoDenseIndex: Exclude<KnowledgeDenseIndex, 'auto'>
  readonly availableDenseIndexes: readonly Exclude<KnowledgeDenseIndex, 'auto'>[]
}

function notAllowed(message: string): never {
  throw new KnowledgeError(message, 'KNOWLEDGE_STRATEGY_NOT_ALLOWED')
}

/**
 * Resolve one request against immutable deployment policy and index capabilities.
 * @param request - optional caller-selected high-level strategy.
 * @param policy - validated provider defaults and allowed values.
 * @param capabilities - immutable Dense index choices available to this provider.
 * @returns the complete high-level strategy to execute.
 */
export function resolveKnowledgeSearchStrategy(
  request: KnowledgeSearchStrategy | undefined,
  policy: KnowledgeSearchPolicy,
  capabilities: KnowledgeSearchCapabilities,
): ResolvedKnowledgeSearchStrategy {
  const retrieval = request?.retrieval ?? policy.defaultRetrieval
  if (!policy.allowedRetrieval.includes(retrieval)) {
    notAllowed(`Knowledge retrieval strategy ${JSON.stringify(retrieval)} is not allowed.`)
  }

  if (retrieval === 'bm25' && request?.denseIndex !== undefined && request.denseIndex !== 'auto') {
    throw new KnowledgeError('BM25 retrieval cannot select a Dense index.', 'KNOWLEDGE_INVALID_REQUEST')
  }

  const rerankRequest = request?.rerank ?? 'auto'
  const rerank = rerankRequest === 'auto' ? policy.defaultRerank === 'on' : rerankRequest === 'on'
  if (rerank && !policy.allowedRerank) notAllowed('Knowledge reranking is not allowed.')

  if (retrieval === 'bm25') return { retrieval, rerank }

  const denseRequest = request?.denseIndex ?? policy.defaultDenseIndex
  const denseIndex = denseRequest === 'auto' ? capabilities.autoDenseIndex : denseRequest
  if (!policy.allowedDenseIndexes.includes(denseIndex)) {
    notAllowed(`Knowledge Dense index ${JSON.stringify(denseIndex)} is not allowed.`)
  }
  if (!capabilities.availableDenseIndexes.includes(denseIndex)) {
    throw new KnowledgeError(`Knowledge index does not provide ${denseIndex} Dense retrieval.`, 'KNOWLEDGE_SEARCH_FAILED')
  }
  return { retrieval, denseIndex, rerank }
}
