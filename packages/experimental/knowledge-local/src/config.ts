/** Loader configuration for the local knowledge provider. */

import type {
  KnowledgeDenseIndex,
  KnowledgeRerank,
  KnowledgeRetrieval,
} from '@deepseek-ai/dsh-experimental-knowledge'
import {
  BGE_DENSE_DTYPE,
  BGE_DENSE_MODEL_FILE,
  BGE_QUERY_PREFIX,
  DEFAULT_DENSE_MAX_TOKENS,
} from './model-runtime.ts'
import { DENSE_DIMENSIONS } from './dense.ts'
import { DEFAULT_RRF_K } from './hybrid.ts'
import { DEFAULT_HNSW_EXPANSION_SEARCH } from './hnsw.ts'
import {
  BGE_RERANKER_DTYPE,
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  DEFAULT_RERANKER_BATCH_SIZE,
  DEFAULT_RERANKER_MAX_TOKENS,
} from './reranker.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION } from './tokenizer.ts'

/** Default number of candidates retained by the local provider. */
export const DEFAULT_CANDIDATE_COUNT = 50
/** Default number of recalled candidates scored by the cross-encoder. */
export const DEFAULT_RERANKER_CANDIDATE_COUNT = 20
/** Default recall algorithm for requests without an explicit strategy. */
export const DEFAULT_RETRIEVAL: KnowledgeRetrieval = 'hybrid'
/** Default Dense index preference for requests without an explicit strategy. */
export const DEFAULT_DENSE_INDEX: KnowledgeDenseIndex = 'auto'
/** Default reranking preference for requests without an explicit strategy. */
export const DEFAULT_RERANK: Exclude<KnowledgeRerank, 'auto'> = 'off'
/** Default recall algorithms exposed by the provider. */
export const DEFAULT_ALLOWED_RETRIEVAL: readonly KnowledgeRetrieval[] = ['bm25', 'dense', 'hybrid']
/** Dense indexes supported by the local provider. */
export const DEFAULT_ALLOWED_DENSE_INDEXES: readonly Exclude<KnowledgeDenseIndex, 'auto'>[] = ['exact', 'hnsw']

/** Local BM25, Dense, and Hybrid retrieval configuration. */
export interface LocalKnowledgeConfig {
  /** Directory containing one completed immutable index. */
  indexDir: string
  /** Recompute all payload hashes during activation instead of checking sizes only. */
  verifyPayloadHashes?: boolean
  /** Recall algorithm used when a request omits it. */
  defaultRetrieval?: KnowledgeRetrieval
  /** Dense index preference used when a request omits it. */
  defaultDenseIndex?: KnowledgeDenseIndex
  /** Reranking preference used when a request omits it or requests `auto`. */
  defaultRerank?: Exclude<KnowledgeRerank, 'auto'>
  /** Recall algorithms callers may request. */
  allowedRetrieval?: KnowledgeRetrieval[]
  /** Concrete Dense indexes callers may request. */
  allowedDenseIndexes?: Array<Exclude<KnowledgeDenseIndex, 'auto'>>
  /** Whether callers may request reranking. */
  allowedRerank?: boolean
  /** Number of candidates retained before the caller result limit is applied. */
  candidateCount?: number
  /** Maximum leading recall candidates submitted to the reranker. */
  rerankerCandidateCount?: number
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
  /** Fixed ONNX file identity recorded in the index. */
  denseModelFile?: typeof BGE_DENSE_MODEL_FILE
  /** Embedding width expected from the configured model. */
  denseDimensions?: number
  /** Text prepended to each Dense query. */
  denseQueryPrefix?: string
  /** HNSW query expansion used for each native search. */
  hnswExpansionSearch?: number
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
  readonly verifyPayloadHashes: boolean
  readonly defaultRetrieval: KnowledgeRetrieval
  readonly defaultDenseIndex: KnowledgeDenseIndex
  readonly defaultRerank: Exclude<KnowledgeRerank, 'auto'>
  readonly allowedRetrieval: readonly KnowledgeRetrieval[]
  readonly allowedDenseIndexes: readonly Exclude<KnowledgeDenseIndex, 'auto'>[]
  readonly allowedRerank: boolean
  readonly candidateCount: number
  readonly rerankerCandidateCount: number
  readonly rrfK: number
  readonly modelCacheDir?: string
  readonly denseModelId: string
  readonly denseModelRevision: string
  readonly denseDtype: 'q8'
  readonly denseModelFile: string
  readonly denseDimensions: number
  readonly denseQueryPrefix: string
  readonly hnswExpansionSearch: number
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
  const candidateCount = config.candidateCount ?? DEFAULT_CANDIDATE_COUNT
  const resolved: ResolvedConfig = {
    indexDir: config.indexDir,
    verifyPayloadHashes: config.verifyPayloadHashes ?? false,
    defaultRetrieval: config.defaultRetrieval ?? DEFAULT_RETRIEVAL,
    defaultDenseIndex: config.defaultDenseIndex ?? DEFAULT_DENSE_INDEX,
    defaultRerank: config.defaultRerank ?? DEFAULT_RERANK,
    allowedRetrieval: [...(config.allowedRetrieval ?? DEFAULT_ALLOWED_RETRIEVAL)],
    allowedDenseIndexes: [...(config.allowedDenseIndexes ?? DEFAULT_ALLOWED_DENSE_INDEXES)],
    allowedRerank: config.allowedRerank ?? true,
    candidateCount,
    rerankerCandidateCount: Math.min(config.rerankerCandidateCount ?? DEFAULT_RERANKER_CANDIDATE_COUNT, candidateCount),
    rrfK: config.rrfK ?? DEFAULT_RRF_K,
    ...(config.modelCacheDir === undefined ? {} : { modelCacheDir: config.modelCacheDir }),
    denseModelId: config.denseModelId ?? BGE_M3_MODEL_ID,
    denseModelRevision: config.denseModelRevision ?? BGE_M3_REVISION,
    denseDtype: config.denseDtype ?? BGE_DENSE_DTYPE,
    denseModelFile: config.denseModelFile ?? BGE_DENSE_MODEL_FILE,
    denseDimensions: config.denseDimensions ?? DENSE_DIMENSIONS,
    denseQueryPrefix: config.denseQueryPrefix ?? BGE_QUERY_PREFIX,
    hnswExpansionSearch: config.hnswExpansionSearch ?? DEFAULT_HNSW_EXPANSION_SEARCH,
    denseMaxTokens: config.denseMaxTokens ?? DEFAULT_DENSE_MAX_TOKENS,
    rerankerModelId: config.rerankerModelId ?? BGE_RERANKER_MODEL_ID,
    rerankerModelRevision: config.rerankerModelRevision ?? BGE_RERANKER_REVISION,
    rerankerDtype: config.rerankerDtype ?? BGE_RERANKER_DTYPE,
    rerankerBatchSize: config.rerankerBatchSize ?? DEFAULT_RERANKER_BATCH_SIZE,
    rerankerMaxTokens: config.rerankerMaxTokens ?? DEFAULT_RERANKER_MAX_TOKENS,
  }
  if (resolved.indexDir.trim().length === 0) throw new TypeError('knowledge-local: indexDir must be non-empty')
  if (resolved.allowedRetrieval.length === 0) {
    throw new TypeError('knowledge-local: allowedRetrieval must contain at least one value')
  }
  if (!resolved.allowedRetrieval.includes(resolved.defaultRetrieval)) {
    throw new TypeError('knowledge-local: defaultRetrieval must be included in allowedRetrieval')
  }
  const denseAllowed = resolved.allowedRetrieval.some(value => value !== 'bm25')
  if (denseAllowed && resolved.allowedDenseIndexes.length === 0) {
    throw new TypeError('knowledge-local: allowedDenseIndexes must contain at least one value when Dense retrieval is allowed')
  }
  if (
    denseAllowed
    && resolved.defaultDenseIndex !== 'auto'
    && !resolved.allowedDenseIndexes.includes(resolved.defaultDenseIndex)
  ) {
    throw new TypeError('knowledge-local: defaultDenseIndex must be auto or included in allowedDenseIndexes')
  }
  if (resolved.defaultRerank === 'on' && !resolved.allowedRerank) {
    throw new TypeError('knowledge-local: defaultRerank cannot be on when reranking is not allowed')
  }
  if (!Number.isSafeInteger(resolved.candidateCount) || resolved.candidateCount < 1) {
    throw new TypeError('knowledge-local: candidateCount must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.rerankerCandidateCount)
    || resolved.rerankerCandidateCount < 1
  ) {
    throw new TypeError('knowledge-local: rerankerCandidateCount must be a positive safe integer')
  }
  if (!Number.isSafeInteger(resolved.rrfK) || resolved.rrfK < 1) {
    throw new TypeError('knowledge-local: rrfK must be a positive safe integer')
  }
  if ((denseAllowed || resolved.allowedRerank) && (resolved.modelCacheDir === undefined || resolved.modelCacheDir.trim().length === 0)) {
    throw new TypeError('knowledge-local: modelCacheDir is required when Dense retrieval or reranking is allowed')
  }
  if (resolved.denseModelId.trim().length === 0) throw new TypeError('knowledge-local: denseModelId must be non-empty')
  if (!/^[a-f0-9]{40}$/u.test(resolved.denseModelRevision)) {
    throw new TypeError('knowledge-local: denseModelRevision must be a full lowercase commit SHA')
  }
  if (resolved.denseModelFile !== BGE_DENSE_MODEL_FILE) throw new TypeError('knowledge-local: denseModelFile is unsupported')
  if (!Number.isSafeInteger(resolved.denseDimensions) || resolved.denseDimensions < 1) {
    throw new TypeError('knowledge-local: denseDimensions must be a positive safe integer')
  }
  if (!Number.isSafeInteger(resolved.hnswExpansionSearch) || resolved.hnswExpansionSearch < 1) {
    throw new TypeError('knowledge-local: hnswExpansionSearch must be a positive safe integer')
  }
  if (!Number.isSafeInteger(resolved.denseMaxTokens) || resolved.denseMaxTokens < 1 || resolved.denseMaxTokens > 8192) {
    throw new TypeError('knowledge-local: denseMaxTokens must be an integer from 1 through 8192')
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
