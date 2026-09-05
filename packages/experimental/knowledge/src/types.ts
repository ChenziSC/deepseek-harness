/** Provider-neutral types for the experimental knowledge retrieval capability. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identifier of one source document. */
export type KnowledgeDocumentId = Branded<'KnowledgeDocumentId'>

/**
 * Convert a validated source identifier into its public nominal type.
 * @param value - validated source-document identifier.
 * @returns the branded source-document identifier.
 */
export function KnowledgeDocumentId(value: string): KnowledgeDocumentId {
  return value as KnowledgeDocumentId
}

/** Stable identifier of one indexed document fragment. */
export type KnowledgeChunkId = Branded<'KnowledgeChunkId'>

/**
 * Convert a validated fragment identifier into its public nominal type.
 * @param value - validated indexed-fragment identifier.
 * @returns the branded indexed-fragment identifier.
 */
export function KnowledgeChunkId(value: string): KnowledgeChunkId {
  return value as KnowledgeChunkId
}

/** Provider-neutral recall algorithm requested for one search. */
export type KnowledgeRetrieval = 'bm25' | 'dense' | 'hybrid'

/** Provider-neutral Dense index preference requested for one search. */
export type KnowledgeDenseIndex = 'auto' | 'exact' | 'hnsw'

/** Provider-neutral reranking preference requested for one search. */
export type KnowledgeRerank = 'auto' | 'on' | 'off'

/** Optional high-level retrieval choices for one search. */
export interface KnowledgeSearchStrategy {
  /** Recall algorithm; the provider default applies when omitted. */
  readonly retrieval?: KnowledgeRetrieval
  /** Dense index preference; meaningful only for Dense and Hybrid recall. */
  readonly denseIndex?: KnowledgeDenseIndex
  /** Reranking preference; `auto` uses the provider default. */
  readonly rerank?: KnowledgeRerank
}

/** High-level retrieval choices executed by a provider. */
export interface ResolvedKnowledgeSearchStrategy {
  /** Recall algorithm used for this result. */
  readonly retrieval: KnowledgeRetrieval
  /** Dense index used by Dense or Hybrid recall. */
  readonly denseIndex?: Exclude<KnowledgeDenseIndex, 'auto'>
  /** Whether neural reranking was applied. */
  readonly rerank: boolean
}

/** One provider-neutral retrieval request. */
export interface KnowledgeSearchRequest {
  /** Non-empty natural-language query. */
  readonly query: string
  /** Maximum number of ranked hits the provider may return. */
  readonly maxResults: number
  /** Optional high-level retrieval choices interpreted by the provider. */
  readonly strategy?: KnowledgeSearchStrategy
}

/** One ranked fragment returned by a knowledge provider. */
export interface KnowledgeHit {
  /** Original source-document identifier. */
  readonly documentId: KnowledgeDocumentId
  /** Stable fragment identifier. */
  readonly chunkId: KnowledgeChunkId
  /** Optional source title. */
  readonly title?: string
  /** Original fragment text. */
  readonly text: string
  /** Optional source label; not necessarily a URL or filesystem path. */
  readonly source?: string
  /** Finite score comparable only within this response. */
  readonly score: number
}

/** Provider-neutral ranked retrieval result. */
export interface KnowledgeSearchResult {
  /** Hits in final descending rank order. */
  readonly hits: readonly KnowledgeHit[]
  /** High-level retrieval choices executed for this result. */
  readonly strategy: ResolvedKnowledgeSearchStrategy
}
