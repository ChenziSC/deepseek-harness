/** Offline construction of immutable local knowledge indexes. */

import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  MIXED_ZH_EN_ANALYZER,
  type KnowledgeBm25Analyzer,
} from './bm25.ts'
import { writeChunkPayload } from './build/chunks.ts'
import {
  createDenseIndexBuildPlan,
  denseIndexBuildPlan,
  importExactVectors,
  resolveDenseIndexMode,
  validateDenseOptions,
  validateDeriveOptions,
  vectorCacheConfig,
  writeDenseVectors,
  writeDerivedDenseVectors,
} from './build/dense-payload.ts'
import {
  DENSE_FILE,
  finalizePayloads,
  prepareOutputDirectory,
  writeManifest,
} from './build/output.ts'
import { stageCorpus, type StagedCorpus } from './build/stage.ts'
import type {
  BuildBm25IndexOptions,
  BuildKnowledgeIndexOptions,
  DenseIndexMode,
  DenseVectorBuildStats,
  DeriveKnowledgeIndexOptions,
  KnowledgeIndexBuildStats,
} from './build/types.ts'
import { DEFAULT_CHUNKING_STRATEGY } from './chunker.ts'
import { DENSE_DIMENSIONS } from './dense.ts'
import {
  DEFAULT_HNSW_CONNECTIVITY,
  DEFAULT_HNSW_EXPANSION_ADD,
  HNSW_FILE,
  HnswBuilder,
  USEARCH_VERSION,
} from './hnsw.ts'
import {
  loadKnowledgeIndex,
  type DenseIndexManifest,
  type KnowledgeIndexManifest,
} from './index-format.ts'
import { BGE_DENSE_MODEL_FILE, BGE_QUERY_PREFIX, DEFAULT_DENSE_MAX_TOKENS } from './model-runtime.ts'
import { KNOWLEDGE_SQLITE_FILE } from './sqlite-index.ts'
import { KnowledgeSqliteWriter } from './sqlite-writer.ts'
import { BGE_SMALL_EN_MODEL_ID, BGE_SMALL_EN_REVISION } from './tokenizer.ts'
import { DenseVectorCache } from './vector-cache.ts'

/** Default number of source documents and chunks committed per SQLite transaction. */
const DEFAULT_SQLITE_BATCH_SIZE = 500

interface BuildPipelineContext {
  readonly staged: StagedCorpus
  readonly writer: KnowledgeSqliteWriter
  readonly chunkCount: number
  readonly buildStats: KnowledgeIndexBuildStats
  readonly corpusStagingMs: number
}

interface BuiltDensePayload {
  readonly denseIndex?: DenseIndexMode
  readonly dense?: DenseIndexManifest
  readonly hnsw?: NonNullable<KnowledgeIndexManifest['hnsw']>
}

interface BuildPipelineHooks {
  readonly beforeChunks?: () => void | Promise<void>
  readonly buildDense?: (context: BuildPipelineContext) => Promise<BuiltDensePayload>
  readonly close?: () => void | Promise<void>
}

interface CompletedBuild {
  readonly manifest: KnowledgeIndexManifest
  readonly stats: KnowledgeIndexBuildStats
}

function sqliteBatchSize(options: BuildBm25IndexOptions): number {
  const value = options.sqliteBatchSize ?? DEFAULT_SQLITE_BATCH_SIZE
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('knowledge-local: sqliteBatchSize must be a positive safe integer')
  }
  return value
}

function validateDerivedCacheOptions(options: BuildBm25IndexOptions): void {
  if (options.derivedCacheDir !== undefined && options.derivedCacheDir.trim().length === 0) {
    throw new TypeError('knowledge-local: derivedCacheDir must be non-empty')
  }
}

function openIndexWriter(outputDir: string, analyzer: KnowledgeBm25Analyzer, staged: StagedCorpus): KnowledgeSqliteWriter {
  try {
    return new KnowledgeSqliteWriter(join(outputDir, KNOWLEDGE_SQLITE_FILE), analyzer)
  } catch (error) {
    /* v8 ignore next -- only an external filesystem or SQLite failure can prevent opening this new payload. */
    staged.database.close()
    /* v8 ignore next -- the original external error is propagated unchanged. */
    throw error
  }
}

async function runBuildPipeline(
  options: BuildBm25IndexOptions,
  analyzer: KnowledgeBm25Analyzer,
  tokenizerModelId: string,
  tokenizerRevision: string,
  batchSize: number,
  hooks: BuildPipelineHooks = {},
): Promise<CompletedBuild> {
  const startedAt = performance.now()
  const staged = await stageCorpus(options, batchSize)
  const corpusStagingMs = performance.now() - startedAt
  const writer = openIndexWriter(options.outputDir, analyzer, staged)
  let chunkCount: number
  let buildStats: KnowledgeIndexBuildStats
  let densePayload: BuiltDensePayload = {}
  try {
    await hooks.beforeChunks?.()
    const chunks = await writeChunkPayload(
      options,
      staged,
      writer,
      analyzer,
      batchSize,
      corpusStagingMs,
      tokenizerModelId,
      tokenizerRevision,
    )
    chunkCount = chunks.chunkCount
    buildStats = chunks.stats
    densePayload = await hooks.buildDense?.({
      staged,
      writer,
      chunkCount,
      buildStats,
      corpusStagingMs,
    }) ?? {}
  } finally {
    try {
      await hooks.close?.()
    } finally {
      try {
        staged.database.close()
      } finally {
        writer.close()
      }
    }
  }
  const payloads = await finalizePayloads(
    options.outputDir,
    staged,
    chunkCount,
    analyzer,
    densePayload.denseIndex,
    densePayload.hnsw !== undefined,
  )
  const manifest = await writeManifest({
    outputDir: options.outputDir,
    startedAt,
    staged,
    chunkCount,
    analyzer,
    tokenizerModelId,
    tokenizerRevision,
    chunking: options.chunking,
    ...(densePayload.dense === undefined ? {} : { dense: densePayload.dense }),
    ...(densePayload.hnsw === undefined ? {} : { hnsw: densePayload.hnsw }),
    payloads,
  })
  return { manifest, stats: buildStats }
}

/**
 * Build a complete local index and write the manifest last.
 * @param options - corpus, tokenizer, output, retrieval, and optional Dense settings.
 * @returns the manifest written after all payloads succeed.
 */
export async function buildKnowledgeIndex(options: BuildKnowledgeIndexOptions): Promise<KnowledgeIndexManifest> {
  const batchSize = sqliteBatchSize(options)
  validateDerivedCacheOptions(options)
  const denseOptions = options.dense
  if (denseOptions !== undefined) validateDenseOptions(denseOptions)
  const analyzer = options.analyzer ?? MIXED_ZH_EN_ANALYZER
  const tokenizerModelId = options.tokenizerModelId ?? BGE_SMALL_EN_MODEL_ID
  const tokenizerRevision = options.tokenizerRevision ?? BGE_SMALL_EN_REVISION
  await prepareOutputDirectory(options.outputDir)
  let vectorCache: DenseVectorCache | undefined
  let importedVectorCount = 0
  let importMs = 0
  let denseBuildStats: DenseVectorBuildStats | undefined
  const vectorCacheDir = denseOptions?.vectorCacheDir
  const beforeChunks = denseOptions === undefined || vectorCacheDir === undefined
    ? undefined
    : async () => {
      const config = vectorCacheConfig(denseOptions)
      vectorCache = await DenseVectorCache.open(vectorCacheDir, config)
      if (denseOptions.importVectorsFrom !== undefined) {
        const importStartedAt = performance.now()
        importedVectorCount = await importExactVectors(
          vectorCache,
          config,
          denseOptions.importVectorsFrom,
          denseOptions.batchSize,
        )
        importMs = performance.now() - importStartedAt
      }
    }
  const completed = await runBuildPipeline(options, analyzer, tokenizerModelId, tokenizerRevision, batchSize, {
    ...(beforeChunks === undefined ? {} : { beforeChunks }),
    ...(denseOptions === undefined
      ? {}
      : { buildDense: async ({ staged, writer, chunkCount, buildStats, corpusStagingMs }: BuildPipelineContext) => {
        const cacheConfig = vectorCacheConfig(denseOptions)
        const densePlan = createDenseIndexBuildPlan(staged.documentCount, chunkCount, denseOptions)
        const resolvedDenseIndex = await resolveDenseIndexMode(densePlan, denseOptions.selectIndex)
        const autoDenseIndex = resolvedDenseIndex === 'both' ? densePlan.recommendedIndex : resolvedDenseIndex
        const hnsw = resolvedDenseIndex === 'hnsw' || resolvedDenseIndex === 'both'
          ? new HnswBuilder({
            dimensions: densePlan.dimensions,
            connectivity: denseOptions.connectivity ?? DEFAULT_HNSW_CONNECTIVITY,
            expansionAdd: denseOptions.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD,
          })
          : undefined
        const exactFile = resolvedDenseIndex === 'exact' || resolvedDenseIndex === 'both'
          ? await open(join(options.outputDir, DENSE_FILE), 'wx')
          : undefined
        const vectorStats = await writeDenseVectors(
          exactFile,
          writer,
          chunkCount,
          denseOptions,
          hnsw,
          vectorCache,
          cacheConfig,
        )
        const hnswSaveStartedAt = performance.now()
        hnsw?.save(join(options.outputDir, HNSW_FILE))
        const hnswSaveMs = hnsw === undefined ? 0 : performance.now() - hnswSaveStartedAt
        denseBuildStats = {
          totalInputCount: vectorStats.totalInputCount,
          cacheHitCount: vectorStats.cacheHitCount,
          encodedInputCount: vectorStats.encodedInputCount,
          reuseRatio: vectorStats.totalInputCount === 0 ? 0 : vectorStats.cacheHitCount / vectorStats.totalInputCount,
          importedVectorCount,
          embeddingBatchCount: vectorStats.embeddingBatchCount,
          timingsMs: {
            corpusStaging: corpusStagingMs,
            chunking: buildStats.timingsMs.chunking,
            sqliteFinalize: buildStats.timingsMs.sqliteFinalize,
            import: importMs,
            ...vectorStats.timingsMs,
            hnswSave: hnswSaveMs,
          },
        }
        return {
          denseIndex: resolvedDenseIndex,
          dense: {
            modelId: denseOptions.modelId,
            revision: denseOptions.revision,
            dtype: denseOptions.dtype,
            modelFile: denseOptions.modelFile ?? BGE_DENSE_MODEL_FILE,
            pooling: 'cls',
            normalized: true,
            dimensions: denseOptions.dimensions ?? DENSE_DIMENSIONS,
            maxTokens: denseOptions.maxTokens ?? DEFAULT_DENSE_MAX_TOKENS,
            queryPrefix: denseOptions.queryPrefix ?? BGE_QUERY_PREFIX,
            vectorCount: chunkCount,
            scanElements: densePlan.scanElements,
            exactScanMaxElements: densePlan.exactScanMaxElements,
            requestedIndex: densePlan.requestedIndex,
            recommendedIndex: densePlan.recommendedIndex,
            resolvedIndex: resolvedDenseIndex,
            autoDenseIndex,
          },
          ...(hnsw === undefined ? {} : {
            hnsw: {
              library: 'usearch' as const,
              libraryVersion: USEARCH_VERSION,
              metric: 'cosine' as const,
              dtype: 'f32' as const,
              connectivity: denseOptions.connectivity ?? DEFAULT_HNSW_CONNECTIVITY,
              expansionAdd: denseOptions.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD,
            },
          }),
        }
      } }),
    close: () => vectorCache?.close(),
  })
  if (denseBuildStats !== undefined) denseOptions?.onVectorBuildStats?.(denseBuildStats)
  options.onBuildStats?.(completed.stats)
  return completed.manifest
}

/**
 * Derive a smaller format-version-four index from the ordinal prefix of an existing Exact index.
 *
 * The target corpus is chunked again and every Dense input is compared with the source SQLite row
 * at the same ordinal before its existing vector is copied. No embedding model is loaded or called.
 *
 * @param options - source Exact index, target corpus, output, and retained Dense payloads.
 * @returns the target manifest written after SQLite, Exact, and optional HNSW payloads succeed.
 */
export async function deriveKnowledgeIndexFromExact(
  options: DeriveKnowledgeIndexOptions,
): Promise<KnowledgeIndexManifest> {
  const batchSize = sqliteBatchSize(options)
  validateDerivedCacheOptions(options)
  validateDeriveOptions(options)
  await prepareOutputDirectory(options.outputDir)
  const source = await loadKnowledgeIndex(options.sourceIndexDir)
  try {
    const sourceDense = source.manifest.dense
    if (sourceDense === undefined || source.dense === undefined) {
      throw new TypeError('knowledge-local: source index must retain dense.f32le')
    }
    const sourceDensePath = source.dense.path
    const analyzer = options.analyzer ?? source.manifest.bm25.analyzer
    const tokenizerModelId = options.tokenizerModelId ?? source.manifest.chunking.tokenizerModelId
    const tokenizerRevision = options.tokenizerRevision ?? source.manifest.chunking.tokenizerRevision
    if (analyzer !== source.manifest.bm25.analyzer) {
      throw new TypeError('knowledge-local: derived analyzer must match the source index')
    }
    if (
      options.chunking.maxTokens !== source.manifest.chunking.maxTokens
      || options.chunking.overlapTokens !== source.manifest.chunking.overlapTokens
      || (options.chunking.strategy ?? DEFAULT_CHUNKING_STRATEGY) !== source.manifest.chunking.strategy
    ) {
      throw new TypeError('knowledge-local: derived chunking must match the source index')
    }
    if (
      tokenizerModelId !== source.manifest.chunking.tokenizerModelId
      || tokenizerRevision !== source.manifest.chunking.tokenizerRevision
    ) {
      throw new TypeError('knowledge-local: derived tokenizer must match the source index')
    }
    const connectivity = options.connectivity ?? source.manifest.hnsw?.connectivity ?? DEFAULT_HNSW_CONNECTIVITY
    const expansionAdd = options.expansionAdd ?? source.manifest.hnsw?.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD
    const exactScanMaxElements = options.exactScanMaxElements ?? sourceDense.exactScanMaxElements
    const completed = await runBuildPipeline(options, analyzer, tokenizerModelId, tokenizerRevision, batchSize, {
      buildDense: async ({ staged, writer, chunkCount }) => {
        const densePlan = denseIndexBuildPlan(
          staged.documentCount,
          chunkCount,
          sourceDense.dimensions,
          exactScanMaxElements,
          options.denseIndex,
          connectivity,
        )
        const hnsw = options.denseIndex === 'hnsw' || options.denseIndex === 'both'
          ? new HnswBuilder({ dimensions: sourceDense.dimensions, connectivity, expansionAdd })
          : undefined
        const sourceFile = await open(sourceDensePath, 'r')
        let exactFile: FileHandle | undefined
        try {
          exactFile = options.denseIndex === 'exact' || options.denseIndex === 'both'
            ? await open(join(options.outputDir, DENSE_FILE), 'wx')
            : undefined
          await writeDerivedDenseVectors(
            sourceFile,
            source.sqlite,
            exactFile,
            writer,
            chunkCount,
            sourceDense.dimensions,
            batchSize,
            hnsw,
          )
        } finally {
          await Promise.all([sourceFile.close(), exactFile?.close()])
        }
        hnsw?.save(join(options.outputDir, HNSW_FILE))
        return {
          denseIndex: options.denseIndex,
          dense: {
            modelId: sourceDense.modelId,
            revision: sourceDense.revision,
            dtype: sourceDense.dtype,
            modelFile: sourceDense.modelFile,
            pooling: sourceDense.pooling,
            normalized: sourceDense.normalized,
            dimensions: sourceDense.dimensions,
            maxTokens: sourceDense.maxTokens,
            queryPrefix: sourceDense.queryPrefix,
            vectorCount: chunkCount,
            scanElements: densePlan.scanElements,
            exactScanMaxElements: densePlan.exactScanMaxElements,
            requestedIndex: options.denseIndex,
            recommendedIndex: densePlan.recommendedIndex,
            resolvedIndex: options.denseIndex,
            autoDenseIndex: options.denseIndex === 'both' ? densePlan.recommendedIndex : options.denseIndex,
          },
          ...(hnsw === undefined ? {} : {
            hnsw: {
              library: 'usearch' as const,
              libraryVersion: USEARCH_VERSION,
              metric: 'cosine' as const,
              dtype: 'f32' as const,
              connectivity,
              expansionAdd,
            },
          }),
        }
      },
    })
    options.onBuildStats?.(completed.stats)
    return completed.manifest
  } finally {
    source.sqlite.close()
  }
}
