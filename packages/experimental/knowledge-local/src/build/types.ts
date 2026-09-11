/** Public request and statistics types for local index construction. */

import type { KnowledgeBm25Analyzer } from '../bm25.ts'
import type { ChunkingOptions } from '../chunker.ts'
import type { DenseEncoder } from '../model-runtime.ts'
import { BGE_DENSE_MODEL_FILE } from '../model-runtime.ts'
import type { ChunkTokenizer } from '../tokenizer.ts'

/** Dense payload mode requested before the corpus size is known. */
export type DenseIndexRequest = 'auto' | 'exact' | 'hnsw' | 'both'
/** Concrete Dense payloads retained by one completed build. */
export type DenseIndexMode = Exclude<DenseIndexRequest, 'auto'>

/** Size-based recommendation emitted after deterministic chunking and before embedding. */
export interface DenseIndexBuildPlan {
  readonly documentCount: number
  readonly chunkCount: number
  readonly dimensions: number
  readonly scanElements: number
  readonly exactScanMaxElements: number
  readonly requestedIndex: DenseIndexRequest
  readonly recommendedIndex: Exclude<DenseIndexMode, 'both'>
  readonly estimatedExactBytes: number
  readonly estimatedHnswBytes: number
  readonly estimatedBothBytes: number
}

/** Content-addressed reuse and phase timings for one Dense build. */
export interface DenseVectorBuildStats {
  readonly totalInputCount: number
  readonly cacheHitCount: number
  readonly encodedInputCount: number
  readonly reuseRatio: number
  readonly importedVectorCount: number
  readonly embeddingBatchCount: number
  readonly timingsMs: {
    readonly corpusStaging: number
    readonly chunking: number
    readonly sqliteFinalize: number
    readonly import: number
    readonly cacheLookup: number
    readonly embedding: number
    readonly cacheWrite: number
    readonly exactWrite: number
    readonly hnswAdd: number
    readonly hnswSave: number
  }
}

/** Document-level reuse counts and phase timings for one complete index build. */
export interface KnowledgeIndexBuildStats {
  readonly cacheEnabled: boolean
  readonly cacheQueryCount: number
  readonly cacheHitDocumentCount: number
  readonly recomputedDocumentCount: number
  readonly reusedChunkCount: number
  readonly newChunkCount: number
  readonly timingsMs: {
    readonly corpusStaging: number
    readonly derivedCacheLookup: number
    readonly chunking: number
    readonly bm25Preprocess: number
    readonly derivedCacheWrite: number
    readonly sqliteWrite: number
    readonly sqliteFinalize: number
  }
}

/** Inputs shared by BM25-only and BM25-plus-Dense index builds. */
export interface BuildBm25IndexOptions {
  /** Complete in-memory corpus used by small fixtures. Mutually exclusive with `corpusPath`. */
  readonly corpusText?: string
  /** JSONL or gzipped JSONL corpus read as a stream. Mutually exclusive with `corpusText`. */
  readonly corpusPath?: string
  readonly corpusSource?: string
  readonly corpusFormat?: 'generic' | 'scifact' | 'mldr' | 't2ranking'
  readonly outputDir: string
  readonly tokenizer: ChunkTokenizer
  readonly chunking: ChunkingOptions
  /** Lexical analyzer recorded in both the manifest and SQLite metadata. */
  readonly analyzer?: KnowledgeBm25Analyzer
  /** Maximum source documents and chunks written in one transaction. */
  readonly sqliteBatchSize?: number
  readonly tokenizerModelId?: string
  readonly tokenizerRevision?: string
  /** Directory containing the reusable document chunking and BM25 derivation cache. */
  readonly derivedCacheDir?: string
  /** Observe document reuse counts and construction phase timings after publication. */
  readonly onBuildStats?: (stats: KnowledgeIndexBuildStats) => void
}

/** Dense component configuration for one index build. */
export interface BuildDenseIndexOptions {
  readonly encoder: Pick<DenseEncoder, 'embedDocuments'>
  /** Maximum texts passed to one embedding call. */
  readonly batchSize: number
  readonly modelId: string
  readonly revision: string
  readonly dtype: 'q8'
  readonly modelFile?: typeof BGE_DENSE_MODEL_FILE
  readonly dimensions?: number
  readonly maxTokens?: number
  readonly queryPrefix?: string
  readonly denseIndex?: DenseIndexRequest
  readonly exactScanMaxElements?: number
  readonly connectivity?: number
  readonly expansionAdd?: number
  /** Directory containing the reusable build-time SQLite vector cache. */
  readonly vectorCacheDir?: string
  /** Verified format-four Exact index used to prefill the vector cache. */
  readonly importVectorsFrom?: string
  /** Observe successful cache reuse and vector construction timings. */
  readonly onVectorBuildStats?: (stats: DenseVectorBuildStats) => void
  /** Let an interactive workflow confirm or override an automatic recommendation. */
  readonly selectIndex?: (plan: DenseIndexBuildPlan) => DenseIndexMode | Promise<DenseIndexMode>
}

/** Complete local index construction inputs. */
export interface BuildKnowledgeIndexOptions extends BuildBm25IndexOptions {
  readonly dense?: BuildDenseIndexOptions
}

/** Inputs for deriving a smaller index from the ordinal prefix of an existing Exact index. */
export interface DeriveKnowledgeIndexOptions extends BuildBm25IndexOptions {
  /** Format-version-four source index that retains `dense.f32le`. */
  readonly sourceIndexDir: string
  /** Dense payloads retained by the derived index. */
  readonly denseIndex: DenseIndexMode
  /** Maximum scalar comparisons used only to record the size recommendation. */
  readonly exactScanMaxElements?: number
  readonly connectivity?: number
  readonly expansionAdd?: number
}
