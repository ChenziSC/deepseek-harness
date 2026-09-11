/** Types shared by offline retrieval evaluation modules. */

import type {
  KnowledgeRerank,
  KnowledgeRetrieval,
  KnowledgeSearchResult,
  ResolvedKnowledgeRetrieval,
  ResolvedKnowledgeSearchStrategy,
} from '@deepseek-ai/dsh-experimental-knowledge'
import type { SciFactEvaluationQuery } from '../../corpus.ts'

/** Retrieval preferences included in the evaluation matrix. */
export type EvaluationMode = KnowledgeRetrieval

/** Aggregate quality measurements for one successful run. */
export interface EvaluationMetrics {
  readonly recallAt1: number
  readonly recallAt5: number
  readonly recallAt10: number
  readonly recallAt20: number
  readonly recallAt100: number
  readonly mrrAt10: number
  readonly ndcgAt10: number
  readonly successAt1: number
  readonly successAt5: number
  readonly successAt10: number
  readonly successAt20: number
  readonly successAt100: number
}

/** One completed or failed evaluation configuration. */
export interface EvaluationRun {
  readonly mode: EvaluationMode
  readonly denseIndex?: 'exact' | 'hnsw'
  readonly rerank: KnowledgeRerank
  readonly status: 'success' | 'failed'
  readonly queryCount: number
  readonly error?: string
  readonly metrics?: EvaluationMetrics
  readonly latencyMs?: { readonly p50: number; readonly p95: number }
  readonly rerankAppliedRate?: number
  readonly resolvedRetrievalCounts?: Readonly<Record<ResolvedKnowledgeRetrieval, number>>
  readonly approximation?: { readonly recallAt10: number; readonly recallAt100: number }
}

/** One document in a query's de-duplicated result ranking. */
export interface EvaluationRankedDocument {
  readonly documentId: string
  readonly score: number
}

/** Per-query evidence retained outside the concise aggregate report. */
export interface EvaluationQueryDetail {
  readonly schemaVersion: 1
  readonly queryId: string
  readonly queryText: string
  readonly requestedStrategy: {
    readonly retrieval: EvaluationMode
    readonly denseIndex?: 'exact' | 'hnsw'
    readonly rerank: KnowledgeRerank
  }
  readonly relevantDocuments: readonly { readonly documentId: string; readonly relevance: number }[]
  readonly status: 'success' | 'failed'
  readonly latencyMs: number
  readonly resolvedStrategy?: ResolvedKnowledgeSearchStrategy
  readonly recallTopScoreGapRatio?: number
  readonly rankedDocuments?: readonly EvaluationRankedDocument[]
  readonly metrics?: EvaluationMetrics
  readonly error?: string
}

/** Receives each measured query record in stable execution order. */
export type EvaluationQueryDetailSink = (detail: EvaluationQueryDetail) => void | Promise<void>

/** Machine-readable result of one fixed dataset evaluation matrix. */
export interface EvaluationReport {
  readonly schemaVersion: 2
  readonly createdAt: string
  readonly dataset: 'scifact' | 'mldr' | 't2ranking' | 'mlqa'
  readonly platform: {
    readonly os: string
    readonly release: string
    readonly arch: string
    readonly node: string
  }
  readonly corpusSha256: string
  readonly indexFingerprint: string
  readonly inputs: {
    readonly queriesSha256: string
    readonly qrelsSha256: string
  }
  readonly models: {
    readonly dense?: { readonly modelId: string; readonly revision: string; readonly dtype: 'q8' }
    readonly reranker?: { readonly modelId: string; readonly revision: string; readonly dtype: 'q8' }
  }
  readonly config: {
    readonly candidateCount: number
    readonly rerankerCandidateCount: number
    readonly maxResults: number
    readonly warmupQueries: number
    readonly queryLimit?: number
    readonly modes: readonly EvaluationMode[]
    readonly denseIndexes: readonly ('exact' | 'hnsw')[]
    readonly rerankValues: readonly KnowledgeRerank[]
    readonly adaptiveRerankMinScoreGapRatio: number
    readonly bm25Implementation: 'sqlite-fts5'
    readonly rrfK: 60
    readonly chunkMaxTokens: number
    readonly chunkOverlapTokens: number
    readonly denseMaxTokens?: number
    readonly hnswExpansionSearch?: number
    readonly rerankerBatchSize: number
    readonly rerankerMaxTokens: number
    readonly hybridExecution: 'sequential'
  }
  readonly runs: readonly EvaluationRun[]
  readonly build: {
    readonly durationMs: number
    readonly indexBytes: number
    readonly payloadBytes: Readonly<Record<string, number>>
  }
}

/** Search and disposal operations needed by one evaluation run. */
export interface EvaluationProvider {
  readonly search: (query: string, maxResults: number) => Promise<KnowledgeSearchResult>
  readonly dispose: () => Promise<void>
}

/** Factory for one immutable mode and reranking combination. */
export type EvaluationProviderFactory = (
  mode: EvaluationMode,
  rerank: KnowledgeRerank,
  denseIndex: 'exact' | 'hnsw',
) => Promise<EvaluationProvider>

export interface RankedDocuments {
  readonly query: SciFactEvaluationQuery
  readonly documentIds: readonly string[]
}
