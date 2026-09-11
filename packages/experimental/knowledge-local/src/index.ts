/** Experimental local-index provider for `ctx.knowledge`. @module @deepseek-ai/dsh-experimental-knowledge-local */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ADAPTIVE_RERANK_MIN_SCORE_GAP_RATIO,
  DEFAULT_ADJACENT_CHUNK_COUNT,
  DEFAULT_ALLOWED_DENSE_INDEXES,
  DEFAULT_ALLOWED_RETRIEVAL,
  DEFAULT_CANDIDATE_COUNT,
  DEFAULT_DENSE_INDEX,
  DEFAULT_RERANK,
  DEFAULT_RERANKER_CANDIDATE_COUNT,
  DEFAULT_RETRIEVAL,
  type LocalKnowledgeConfig,
} from './config.ts'
import { DENSE_DIMENSIONS } from './dense.ts'
import { DEFAULT_HNSW_EXPANSION_SEARCH } from './hnsw.ts'
import { DEFAULT_RRF_K } from './hybrid.ts'
import {
  BGE_DENSE_DTYPE,
  BGE_DENSE_MODEL_FILE,
  BGE_QUERY_PREFIX,
  DEFAULT_DENSE_MAX_TOKENS,
} from './model-runtime.ts'
import LocalKnowledgeProvider from './provider.ts'
import {
  BGE_RERANKER_DTYPE,
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  DEFAULT_RERANKER_BATCH_SIZE,
  DEFAULT_RERANKER_MAX_TOKENS,
} from './reranker.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION } from './tokenizer.ts'

/** Loader configuration for local BM25, Dense, and Hybrid retrieval. */
export type Config = LocalKnowledgeConfig

/** Schemastery loader schema for local BM25, Dense, and Hybrid retrieval. */
export const Config: z<Config> = z.object({
  indexDir: z.string().required(),
  verifyPayloadHashes: z.boolean().default(false),
  defaultRetrieval: z.union(['auto', 'bm25', 'dense', 'hybrid'] as const).default(DEFAULT_RETRIEVAL),
  defaultDenseIndex: z.union(['auto', 'exact', 'hnsw'] as const).default(DEFAULT_DENSE_INDEX),
  defaultRerank: z.union(['on', 'off'] as const).default(DEFAULT_RERANK),
  allowedRetrieval: z.array(z.union(['bm25', 'dense', 'hybrid'] as const)).min(1).default([...DEFAULT_ALLOWED_RETRIEVAL]),
  allowedDenseIndexes: z.array(z.union(['exact', 'hnsw'] as const)).default([...DEFAULT_ALLOWED_DENSE_INDEXES]),
  allowedRerank: z.boolean().default(true),
  candidateCount: z.number().step(1).min(1).default(DEFAULT_CANDIDATE_COUNT),
  rerankerCandidateCount: z.number().step(1).min(1).default(DEFAULT_RERANKER_CANDIDATE_COUNT),
  adaptiveRerankMinScoreGapRatio: z.number().min(0).max(1).default(DEFAULT_ADAPTIVE_RERANK_MIN_SCORE_GAP_RATIO),
  adjacentChunkCount: z.number().step(1).min(0).max(1).default(DEFAULT_ADJACENT_CHUNK_COUNT),
  rrfK: z.number().step(1).min(1).default(DEFAULT_RRF_K),
  modelCacheDir: z.string(),
  denseModelId: z.string().default(BGE_M3_MODEL_ID),
  denseModelRevision: z.string().default(BGE_M3_REVISION),
  denseDtype: z.const(BGE_DENSE_DTYPE).default(BGE_DENSE_DTYPE),
  denseModelFile: z.const(BGE_DENSE_MODEL_FILE).default(BGE_DENSE_MODEL_FILE),
  denseDimensions: z.number().step(1).min(1).default(DENSE_DIMENSIONS),
  denseQueryPrefix: z.string().default(BGE_QUERY_PREFIX),
  hnswExpansionSearch: z.number().step(1).min(1).default(DEFAULT_HNSW_EXPANSION_SEARCH),
  denseMaxTokens: z.number().step(1).min(1).max(8192).default(DEFAULT_DENSE_MAX_TOKENS),
  rerankerModelId: z.string().default(BGE_RERANKER_MODEL_ID),
  rerankerModelRevision: z.string().default(BGE_RERANKER_REVISION),
  rerankerDtype: z.const(BGE_RERANKER_DTYPE).default(BGE_RERANKER_DTYPE),
  rerankerBatchSize: z.number().step(1).min(1).default(DEFAULT_RERANKER_BATCH_SIZE),
  rerankerMaxTokens: z.number().step(1).min(1).max(512).default(DEFAULT_RERANKER_MAX_TOKENS),
})

/** Local immutable BM25, Dense, and Hybrid knowledge provider. */
export class LocalKnowledge extends LocalKnowledgeProvider {
  static Config = Config

  /**
   * Create one provider with resolved immutable runtime configuration.
   * @param ctx - owning Cordis context.
   * @param config - index, retrieval, and local model settings.
   */
  // The entrypoint declares this signature so the Loader config catalog can inspect it.
  // oxlint-disable-next-line eslint/no-useless-constructor
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
  }
}

export default LocalKnowledge
