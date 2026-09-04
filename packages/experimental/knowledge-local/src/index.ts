/** Experimental local-index provider for `ctx.knowledge`. @module @deepseek-ai/dsh-experimental-knowledge-local */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_BM25_B,
  DEFAULT_BM25_K1,
  DEFAULT_CANDIDATE_COUNT,
  type LocalKnowledgeConfig,
} from './config.ts'
import { DEFAULT_RRF_K } from './hybrid.ts'
import { BGE_DENSE_DTYPE, DEFAULT_DENSE_MAX_TOKENS } from './model-runtime.ts'
import LocalKnowledgeProvider from './provider.ts'
import {
  BGE_RERANKER_DTYPE,
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  DEFAULT_RERANKER_BATCH_SIZE,
  DEFAULT_RERANKER_MAX_TOKENS,
} from './reranker.ts'
import { BGE_SMALL_EN_MODEL_ID, BGE_SMALL_EN_REVISION } from './tokenizer.ts'

/** Loader configuration for local BM25, Dense, and Hybrid retrieval. */
export type Config = LocalKnowledgeConfig

/** Schemastery loader schema for local BM25, Dense, and Hybrid retrieval. */
export const Config: z<Config> = z.object({
  indexDir: z.string().required(),
  mode: z.union(['bm25', 'dense', 'hybrid'] as const).default('bm25'),
  rerank: z.boolean().default(false),
  candidateCount: z.number().step(1).min(1).default(DEFAULT_CANDIDATE_COUNT),
  bm25K1: z.number().default(DEFAULT_BM25_K1),
  bm25B: z.number().min(0).max(1).default(DEFAULT_BM25_B),
  rrfK: z.number().step(1).min(1).default(DEFAULT_RRF_K),
  modelCacheDir: z.string(),
  denseModelId: z.string().default(BGE_SMALL_EN_MODEL_ID),
  denseModelRevision: z.string().default(BGE_SMALL_EN_REVISION),
  denseDtype: z.const(BGE_DENSE_DTYPE).default(BGE_DENSE_DTYPE),
  denseMaxTokens: z.number().step(1).min(1).max(512).default(DEFAULT_DENSE_MAX_TOKENS),
  rerankerModelId: z.string().default(BGE_RERANKER_MODEL_ID),
  rerankerModelRevision: z.string().default(BGE_RERANKER_REVISION),
  rerankerDtype: z.const(BGE_RERANKER_DTYPE).default(BGE_RERANKER_DTYPE),
  rerankerBatchSize: z.number().step(1).min(1).default(DEFAULT_RERANKER_BATCH_SIZE),
  rerankerMaxTokens: z.number().step(1).min(1).max(512).default(DEFAULT_RERANKER_MAX_TOKENS),
})

export { analyzeEnglishV1, buildBm25Index, explainBm25, searchBm25 } from './bm25.ts'
export { compareCodePoints } from './bm25.ts'
export type {
  Bm25DiagnosticMatch,
  Bm25Diagnostics,
  Bm25Index,
  Bm25Match,
  Bm25Posting,
  Bm25Term,
  Bm25TermContribution,
} from './bm25.ts'
export { chunkDocuments } from './chunker.ts'
export type { ChunkRecord, ChunkingOptions } from './chunker.ts'
export { resolveConfig } from './config.ts'
export type { LocalKnowledgeConfig, ResolvedConfig } from './config.ts'
export {
  CorpusFormatError,
  parseCorpusJsonl,
  parseSciFactCorpusJsonl,
  parseSciFactQrelsTsv,
  parseSciFactQueriesJsonl,
} from './corpus.ts'
export type {
  CorpusDocument,
  SciFactEvaluationQuery,
  SciFactQuery,
  SciFactRelevance,
} from './corpus.ts'
export {
  DENSE_DIMENSIONS,
  DENSE_NORMALIZATION_TOLERANCE,
  searchDense,
  validateDenseVectors,
} from './dense.ts'
export type { DenseMatch } from './dense.ts'
export {
  calculateMetrics,
  evaluateMatrix,
  evaluateSciFact,
  nearestRank,
  renderEvaluationReport,
} from './evaluation.ts'
export type {
  EvaluationMetrics,
  EvaluationMode,
  EvaluationProvider,
  EvaluationProviderFactory,
  EvaluationReport,
  EvaluationRun,
  EvaluateSciFactOptions,
} from './evaluation.ts'
export { DEFAULT_RRF_K, fuseRrf } from './hybrid.ts'
export type { HybridMatch } from './hybrid.ts'
export { buildBm25KnowledgeIndex, buildKnowledgeIndex } from './index-builder.ts'
export type {
  BuildBm25IndexOptions,
  BuildDenseIndexOptions,
  BuildKnowledgeIndexOptions,
} from './index-builder.ts'
export { loadKnowledgeIndex } from './index-format.ts'
export type {
  DenseIndexManifest,
  KnowledgeIndexManifest,
  LoadedKnowledgeIndex,
  PayloadManifest,
} from './index-format.ts'
export {
  BGE_DENSE_DTYPE,
  BGE_QUERY_PREFIX,
  DEFAULT_DENSE_MAX_TOKENS,
  DenseEncoder,
  loadDenseEncoder,
} from './model-runtime.ts'
export {
  extractSciFactArchive,
  prepareSciFact,
  SCIFACT_MD5,
  SCIFACT_URL,
} from './prepare.ts'
export type { PrepareDependencies, PrepareResult } from './prepare.ts'
export {
  BGE_RERANKER_DTYPE,
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  DEFAULT_RERANKER_BATCH_SIZE,
  DEFAULT_RERANKER_MAX_TOKENS,
  loadReranker,
  Reranker,
} from './reranker.ts'
export type {
  RerankMatch,
  RerankerBackend,
  RerankerBackendFactory,
  RerankerInferenceOptions,
  RerankerLoadOptions,
  RerankerTensorOutput,
} from './reranker.ts'
export type {
  DenseEncoderLoadOptions,
  DenseFeatureExtractionOptions,
  DenseFeatureExtractor,
  DenseFeatureExtractorFactory,
  DenseTensorOutput,
} from './model-runtime.ts'
export {
  BGE_SMALL_EN_MODEL_ID,
  BGE_SMALL_EN_REVISION,
  loadBgeChunkTokenizer,
} from './tokenizer.ts'
export type { BgeTokenizerOptions, ChunkTokenizer } from './tokenizer.ts'

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
