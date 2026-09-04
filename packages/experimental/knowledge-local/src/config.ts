/** Loader configuration for the local knowledge provider. */

import {
  BGE_DENSE_DTYPE,
  DEFAULT_DENSE_MAX_TOKENS,
} from './model-runtime.ts'
import { DEFAULT_RRF_K } from './hybrid.ts'
import {
  BGE_RERANKER_DTYPE,
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  DEFAULT_RERANKER_BATCH_SIZE,
  DEFAULT_RERANKER_MAX_TOKENS,
} from './reranker.ts'
import { BGE_SMALL_EN_MODEL_ID, BGE_SMALL_EN_REVISION } from './tokenizer.ts'

/** Default number of candidates retained by the local provider. */
export const DEFAULT_CANDIDATE_COUNT = 50
/** Default Okapi BM25 term-frequency saturation parameter. */
export const DEFAULT_BM25_K1 = 1.2
/** Default Okapi BM25 document-length normalization parameter. */
export const DEFAULT_BM25_B = 0.75

/** Local BM25, Dense, and Hybrid retrieval configuration. */
export interface LocalKnowledgeConfig {
  /** Directory containing one completed immutable index. */
  indexDir: string
  /** Retrieval mode selected for all requests. */
  mode?: 'bm25' | 'dense' | 'hybrid'
  /** Whether to rerank recalled candidates with the configured cross-encoder. */
  rerank?: boolean
  /** Number of candidates retained before the caller result limit is applied. */
  candidateCount?: number
  /** BM25 term-frequency saturation parameter. */
  bm25K1?: number
  /** BM25 document-length normalization parameter. */
  bm25B?: number
  /** Reciprocal Rank Fusion constant used by Hybrid mode. */
  rrfK?: number
  /** Explicit Transformers.js cache required by Dense, Hybrid, and reranked modes. */
  modelCacheDir?: string
  /** Dense embedding model repository. */
  denseModelId?: string
  /** Full immutable Dense model revision. */
  denseModelRevision?: string
  /** Dense ONNX model data type. */
  denseDtype?: 'q8'
  /** Maximum model tokens for one Dense input. */
  denseMaxTokens?: number
  /** Cross-encoder reranker model repository. */
  rerankerModelId?: string
  /** Full immutable reranker model revision. */
  rerankerModelRevision?: string
  /** Reranker ONNX model data type. */
  rerankerDtype?: 'q8'
  /** Number of candidate pairs submitted per reranker inference. */
  rerankerBatchSize?: number
  /** Maximum model tokens for one reranker text pair. */
  rerankerMaxTokens?: number
}

/** Fully resolved immutable provider configuration. */
export interface ResolvedConfig {
  readonly indexDir: string
  readonly mode: 'bm25' | 'dense' | 'hybrid'
  readonly rerank: boolean
  readonly candidateCount: number
  readonly bm25K1: number
  readonly bm25B: number
  readonly rrfK: number
  readonly modelCacheDir?: string
  readonly denseModelId: string
  readonly denseModelRevision: string
  readonly denseDtype: 'q8'
  readonly denseMaxTokens: number
  readonly rerankerModelId: string
  readonly rerankerModelRevision: string
  readonly rerankerDtype: 'q8'
  readonly rerankerBatchSize: number
  readonly rerankerMaxTokens: number
}

/**
 * Apply defaults and reject values the schema cannot express precisely.
 * @param config - loader configuration.
 * @returns validated runtime configuration with all defaults applied.
 */
export function resolveConfig(config: LocalKnowledgeConfig): ResolvedConfig {
  const resolved: ResolvedConfig = {
    indexDir: config.indexDir,
    mode: config.mode ?? 'bm25',
    rerank: config.rerank ?? false,
    candidateCount: config.candidateCount ?? DEFAULT_CANDIDATE_COUNT,
    bm25K1: config.bm25K1 ?? DEFAULT_BM25_K1,
    bm25B: config.bm25B ?? DEFAULT_BM25_B,
    rrfK: config.rrfK ?? DEFAULT_RRF_K,
    ...(config.modelCacheDir === undefined ? {} : { modelCacheDir: config.modelCacheDir }),
    denseModelId: config.denseModelId ?? BGE_SMALL_EN_MODEL_ID,
    denseModelRevision: config.denseModelRevision ?? BGE_SMALL_EN_REVISION,
    denseDtype: config.denseDtype ?? BGE_DENSE_DTYPE,
    denseMaxTokens: config.denseMaxTokens ?? DEFAULT_DENSE_MAX_TOKENS,
    rerankerModelId: config.rerankerModelId ?? BGE_RERANKER_MODEL_ID,
    rerankerModelRevision: config.rerankerModelRevision ?? BGE_RERANKER_REVISION,
    rerankerDtype: config.rerankerDtype ?? BGE_RERANKER_DTYPE,
    rerankerBatchSize: config.rerankerBatchSize ?? DEFAULT_RERANKER_BATCH_SIZE,
    rerankerMaxTokens: config.rerankerMaxTokens ?? DEFAULT_RERANKER_MAX_TOKENS,
  }
  if (resolved.indexDir.trim().length === 0) throw new TypeError('knowledge-local: indexDir must be non-empty')
  if (!Number.isSafeInteger(resolved.candidateCount) || resolved.candidateCount < 1) {
    throw new TypeError('knowledge-local: candidateCount must be a positive safe integer')
  }
  if (!Number.isFinite(resolved.bm25K1) || resolved.bm25K1 <= 0) {
    throw new TypeError('knowledge-local: bm25K1 must be a positive finite number')
  }
  if (!Number.isFinite(resolved.bm25B) || resolved.bm25B < 0 || resolved.bm25B > 1) {
    throw new TypeError('knowledge-local: bm25B must be a finite number from 0 through 1')
  }
  if (!Number.isSafeInteger(resolved.rrfK) || resolved.rrfK < 1) {
    throw new TypeError('knowledge-local: rrfK must be a positive safe integer')
  }
  if ((resolved.mode !== 'bm25' || resolved.rerank) && (resolved.modelCacheDir === undefined || resolved.modelCacheDir.trim().length === 0)) {
    throw new TypeError('knowledge-local: modelCacheDir is required for Dense, Hybrid, and reranked modes')
  }
  if (resolved.denseModelId.trim().length === 0) throw new TypeError('knowledge-local: denseModelId must be non-empty')
  if (!/^[a-f0-9]{40}$/u.test(resolved.denseModelRevision)) {
    throw new TypeError('knowledge-local: denseModelRevision must be a full lowercase commit SHA')
  }
  if (!Number.isSafeInteger(resolved.denseMaxTokens) || resolved.denseMaxTokens < 1 || resolved.denseMaxTokens > 512) {
    throw new TypeError('knowledge-local: denseMaxTokens must be an integer from 1 through 512')
  }
  if (resolved.rerankerModelId.trim().length === 0) throw new TypeError('knowledge-local: rerankerModelId must be non-empty')
  if (!/^[a-f0-9]{40}$/u.test(resolved.rerankerModelRevision)) {
    throw new TypeError('knowledge-local: rerankerModelRevision must be a full lowercase commit SHA')
  }
  if (!Number.isSafeInteger(resolved.rerankerBatchSize) || resolved.rerankerBatchSize < 1) {
    throw new TypeError('knowledge-local: rerankerBatchSize must be a positive safe integer')
  }
  if (!Number.isSafeInteger(resolved.rerankerMaxTokens) || resolved.rerankerMaxTokens < 1 || resolved.rerankerMaxTokens > 512) {
    throw new TypeError('knowledge-local: rerankerMaxTokens must be an integer from 1 through 512')
  }
  return resolved
}
