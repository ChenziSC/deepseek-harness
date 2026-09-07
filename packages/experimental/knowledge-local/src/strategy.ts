/** Pure resolution of provider defaults and caller-selected retrieval strategy. */

import {
  KnowledgeError,
  type KnowledgeDenseIndex,
  type KnowledgeRerank,
  type KnowledgeRetrieval,
  type ResolvedKnowledgeRetrieval,
  type KnowledgeSearchStrategy,
} from '@deepseek-ai/dsh-experimental-knowledge'
import { profileTextScript, type TextScriptProfile } from './script-profile.ts'

/** Provider policy used to resolve one search strategy. */
export interface KnowledgeSearchPolicy {
  readonly defaultRetrieval: KnowledgeRetrieval
  readonly defaultDenseIndex: KnowledgeDenseIndex
  readonly defaultRerank: Exclude<KnowledgeRerank, 'auto'>
  readonly allowedRetrieval: readonly ResolvedKnowledgeRetrieval[]
  readonly allowedDenseIndexes: readonly Exclude<KnowledgeDenseIndex, 'auto'>[]
  readonly allowedRerank: boolean
}

/** Dense index capabilities recorded by one loaded index. */
export interface KnowledgeSearchCapabilities {
  readonly autoDenseIndex: Exclude<KnowledgeDenseIndex, 'auto'>
  readonly availableDenseIndexes: readonly Exclude<KnowledgeDenseIndex, 'auto'>[]
  readonly corpusScript: TextScriptProfile
}

/** Concrete retrieval plan resolved before recall candidates exist. */
export interface KnowledgeSearchExecutionPlan {
  readonly retrieval: ResolvedKnowledgeRetrieval
  readonly denseIndex?: Exclude<KnowledgeDenseIndex, 'auto'>
  readonly rerank: KnowledgeRerank
}

function notAllowed(message: string): never {
  throw new KnowledgeError(message, 'KNOWLEDGE_STRATEGY_NOT_ALLOWED')
}

function hasExactTermSignal(query: string): boolean {
  return /(?:https?:\/\/|www\.)/iu.test(query)
    || /(?:^|\s)(?:[./~]|[A-Za-z]:\\)[^\s]+/u.test(query)
    || /\b(?:[A-Z][A-Z0-9_]{2,}|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+)\b/u.test(query)
    || /\b(?:0x)?[a-f0-9]{8,}\b/iu.test(query)
    || /\b\d{6,}\b/u.test(query)
}

function routedRetrieval(query: string, corpusScript: TextScriptProfile): ResolvedKnowledgeRetrieval {
  if (hasExactTermSignal(query)) return 'bm25'
  const queryScript = profileTextScript(query)
  if (
    (queryScript === 'latin' && corpusScript === 'cjk')
    || (queryScript === 'cjk' && corpusScript === 'latin')
  ) return 'dense'
  return 'hybrid'
}

function allowedRetrieval(
  preferred: ResolvedKnowledgeRetrieval,
  allowed: readonly ResolvedKnowledgeRetrieval[],
): ResolvedKnowledgeRetrieval {
  const fallbacks: Record<ResolvedKnowledgeRetrieval, readonly ResolvedKnowledgeRetrieval[]> = {
    bm25: ['bm25', 'hybrid', 'dense'],
    dense: ['dense', 'hybrid', 'bm25'],
    hybrid: ['hybrid', 'dense', 'bm25'],
  }
  const selected = fallbacks[preferred].find(value => allowed.includes(value))
  /* v8 ignore next -- configuration validation requires a non-empty concrete allowed set. */
  if (selected === undefined) notAllowed('No knowledge retrieval strategy is allowed.')
  return selected
}

/**
 * Resolve one request against immutable deployment policy and index capabilities.
 * @param query - validated query text used by automatic routing.
 * @param request - optional caller-selected high-level strategy.
 * @param policy - validated provider defaults and allowed values.
 * @param capabilities - immutable Dense index choices available to this provider.
 * @returns the complete high-level strategy to execute.
 */
export function resolveKnowledgeSearchStrategy(
  query: string,
  request: KnowledgeSearchStrategy | undefined,
  policy: KnowledgeSearchPolicy,
  capabilities: KnowledgeSearchCapabilities,
): KnowledgeSearchExecutionPlan {
  const requestedRetrieval = request?.retrieval ?? policy.defaultRetrieval
  const retrieval = requestedRetrieval === 'auto'
    ? allowedRetrieval(routedRetrieval(query, capabilities.corpusScript), policy.allowedRetrieval)
    : requestedRetrieval
  if (!policy.allowedRetrieval.includes(retrieval)) {
    notAllowed(`Knowledge retrieval strategy ${JSON.stringify(requestedRetrieval)} is not allowed.`)
  }

  if (retrieval === 'bm25' && request?.denseIndex !== undefined && request.denseIndex !== 'auto') {
    throw new KnowledgeError('BM25 retrieval cannot select a Dense index.', 'KNOWLEDGE_INVALID_REQUEST')
  }

  const rerank = request?.rerank ?? policy.defaultRerank
  if (rerank !== 'off' && !policy.allowedRerank) notAllowed('Knowledge reranking is not allowed.')

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
