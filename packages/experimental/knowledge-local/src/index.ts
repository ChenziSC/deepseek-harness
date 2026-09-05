/** Experimental local-index provider for `ctx.knowledge`. @module @deepseek-ai/dsh-experimental-knowledge-local */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ALLOWED_DENSE_INDEXES,
  DEFAULT_ALLOWED_RETRIEVAL,
  DEFAULT_CANDIDATE_COUNT,
  DEFAULT_RERANKER_CANDIDATE_COUNT,
  DEFAULT_DENSE_INDEX,
  DEFAULT_RERANK,
  DEFAULT_RETRIEVAL,
  type LocalKnowledgeConfig,
} from './config.ts'
import { DEFAULT_RRF_K } from './hybrid.ts'
import { DENSE_DIMENSIONS } from './dense.ts'
import { DEFAULT_HNSW_EXPANSION_SEARCH } from './hnsw.ts'
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
  defaultRetrieval: z.union(['bm25', 'dense', 'hybrid'] as const).default(DEFAULT_RETRIEVAL),
  defaultDenseIndex: z.union(['auto', 'exact', 'hnsw'] as const).default(DEFAULT_DENSE_INDEX),
  defaultRerank: z.union(['on', 'off'] as const).default(DEFAULT_RERANK),
  allowedRetrieval: z.array(z.union(['bm25', 'dense', 'hybrid'] as const)).min(1).default([...DEFAULT_ALLOWED_RETRIEVAL]),
  allowedDenseIndexes: z.array(z.union(['exact', 'hnsw'] as const)).default([...DEFAULT_ALLOWED_DENSE_INDEXES]),
  allowedRerank: z.boolean().default(true),
  candidateCount: z.number().step(1).min(1).default(DEFAULT_CANDIDATE_COUNT),
  rerankerCandidateCount: z.number().step(1).min(1).default(DEFAULT_RERANKER_CANDIDATE_COUNT),
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

export {
  analyzeBm25,
  analyzeEnglishV1,
  analyzeMixedZhEnV1,
  buildBm25Index,
  compareCodePoints,
  ENGLISH_ANALYZER,
  explainBm25,
  MIXED_ZH_EN_ANALYZER,
  searchBm25,
} from './bm25.ts'
export type {
  Bm25DiagnosticMatch,
  Bm25Diagnostics,
  Bm25Index,
  Bm25Match,
  Bm25Posting,
  Bm25Term,
  Bm25TermContribution,
  KnowledgeBm25Analyzer,
} from './bm25.ts'
export { chunkDocuments } from './chunker.ts'
export type { ChunkRecord, ChunkingOptions } from './chunker.ts'
export { resolveConfig } from './config.ts'
export {
  DEFAULT_ALLOWED_DENSE_INDEXES,
  DEFAULT_ALLOWED_RETRIEVAL,
  DEFAULT_DENSE_INDEX,
  DEFAULT_RERANKER_CANDIDATE_COUNT,
  DEFAULT_RERANK,
  DEFAULT_RETRIEVAL,
} from './config.ts'
export type { LocalKnowledgeConfig, ResolvedConfig } from './config.ts'
export {
  CorpusFormatError,
  parseCorpusDocumentLine,
  parseCorpusJsonl,
  parseMldrQueriesJsonl,
  parseSciFactCorpusJsonl,
  parseSciFactQrelsTsv,
  parseSciFactQueriesJsonl,
  parseT2RankingQrelsTsv,
  parseT2RankingQueriesTsv,
  parseTrecQrelsTsv,
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
  evaluateDataset,
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
  EvaluateDatasetOptions,
} from './evaluation.ts'
export { DEFAULT_RRF_K, fuseRrf } from './hybrid.ts'
export type { HybridMatch } from './hybrid.ts'
export {
  DEFAULT_HNSW_CONNECTIVITY,
  DEFAULT_HNSW_EXPANSION_ADD,
  DEFAULT_HNSW_EXPANSION_SEARCH,
  HNSW_FILE,
  HnswBuilder,
  HnswIndex,
  USEARCH_VERSION,
} from './hnsw.ts'
export type { HnswBuildOptions } from './hnsw.ts'
export { buildBm25KnowledgeIndex, buildKnowledgeIndex, createDenseIndexBuildPlan } from './index-builder.ts'
export { DEFAULT_EXACT_SCAN_MAX_ELEMENTS, DEFAULT_SQLITE_BATCH_SIZE } from './index-builder.ts'
export type {
  BuildBm25IndexOptions,
  BuildDenseIndexOptions,
  BuildKnowledgeIndexOptions,
  DenseIndexBuildPlan,
  DenseIndexMode,
  DenseIndexRequest,
} from './index-builder.ts'
export { loadDenseVectors, loadKnowledgeIndex, verifyKnowledgeIndex } from './index-format.ts'
export type {
  DenseIndexManifest,
  HnswIndexManifest,
  KnowledgeIndexManifest,
  LoadKnowledgeIndexOptions,
  LoadedKnowledgeIndex,
  PayloadManifest,
} from './index-format.ts'
export {
  KNOWLEDGE_SQLITE_FILE,
  KNOWLEDGE_SQLITE_SCHEMA_VERSION,
  KnowledgeSqliteIndex,
} from './sqlite-index.ts'
export {
  BGE_DENSE_DTYPE,
  BGE_QUERY_PREFIX,
  DEFAULT_DENSE_MAX_TOKENS,
  DenseEncoder,
  loadDenseEncoder,
} from './model-runtime.ts'
export { resolveKnowledgeSearchStrategy } from './strategy.ts'
export type { KnowledgeSearchCapabilities, KnowledgeSearchPolicy } from './strategy.ts'
export {
  extractSciFactArchive,
  downloadDatasetFile,
  HUGGING_FACE_ENDPOINT,
  MLQA_RETRIEVAL_REVISION,
  MLDR_REVISION,
  convertMlqaRetrievalRows,
  prepareMlqaEngZho,
  prepareMldr,
  prepareSciFact,
  prepareT2Ranking,
  SCIFACT_MD5,
  SCIFACT_URL,
  T2RANKING_REVISION,
} from './prepare.ts'
export type {
  DatasetDownloader,
  PreparedDataset,
  PreparedDatasetFile,
  PrepareDependencies,
  PrepareResult,
} from './prepare.ts'
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
  BGE_M3_MODEL_ID,
  BGE_M3_REVISION,
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
