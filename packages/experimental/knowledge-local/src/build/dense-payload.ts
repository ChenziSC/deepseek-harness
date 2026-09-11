/** Dense payload planning, encoding, cache import, and Exact-prefix reuse. */

import { open, type FileHandle } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { DENSE_DIMENSIONS, validateDenseVectors } from '../dense.ts'
import {
  DEFAULT_HNSW_CONNECTIVITY,
  DEFAULT_HNSW_EXPANSION_ADD,
  HnswBuilder,
} from '../hnsw.ts'
import { loadKnowledgeIndex, type DenseIndexManifest } from '../index-format.ts'
import { BGE_DENSE_MODEL_FILE, BGE_QUERY_PREFIX, DEFAULT_DENSE_MAX_TOKENS } from '../model-runtime.ts'
import type { KnowledgeSqliteIndex } from '../sqlite-index.ts'
import type { KnowledgeSqliteWriter } from '../sqlite-writer.ts'
import {
  DENSE_ENCODING_IMPLEMENTATION_VERSION,
  DenseVectorCache,
  denseVectorCacheKey,
  type DenseVectorCacheConfig,
} from '../vector-cache.ts'
import type {
  BuildDenseIndexOptions,
  DenseIndexBuildPlan,
  DenseIndexMode,
  DenseIndexRequest,
  DeriveKnowledgeIndexOptions,
} from './types.ts'

/** Default maximum scalar comparisons selected for Exact Dense retrieval. */
export const DEFAULT_EXACT_SCAN_MAX_ELEMENTS = 50_000_000

function denseBytes(vectors: Float32Array): Buffer {
  const data = Buffer.allocUnsafe(vectors.length * Float32Array.BYTES_PER_ELEMENT)
  for (let index = 0; index < vectors.length; index += 1) {
    data.writeFloatLE(vectors[index] as number, index * Float32Array.BYTES_PER_ELEMENT)
  }
  return data
}

export function validateDenseOptions(options: BuildDenseIndexOptions): void {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) {
    throw new TypeError('knowledge-local: Dense batchSize must be a positive safe integer')
  }
  if (options.modelId.trim().length === 0) throw new TypeError('knowledge-local: Dense modelId must be non-empty')
  if (!/^[a-f0-9]{40}$/u.test(options.revision)) {
    throw new TypeError('knowledge-local: Dense revision must be a full lowercase commit SHA')
  }
  const dimensions = options.dimensions ?? DENSE_DIMENSIONS
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new TypeError('knowledge-local: Dense dimensions must be a positive safe integer')
  }
  validateDenseStorageOptions(
    options.exactScanMaxElements ?? DEFAULT_EXACT_SCAN_MAX_ELEMENTS,
    options.connectivity ?? DEFAULT_HNSW_CONNECTIVITY,
    options.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD,
  )
  if (options.vectorCacheDir !== undefined && options.vectorCacheDir.trim().length === 0) {
    throw new TypeError('knowledge-local: Dense vectorCacheDir must be non-empty')
  }
  if (options.importVectorsFrom !== undefined && options.importVectorsFrom.trim().length === 0) {
    throw new TypeError('knowledge-local: Dense importVectorsFrom must be non-empty')
  }
  if (options.importVectorsFrom !== undefined && options.vectorCacheDir === undefined) {
    throw new TypeError('knowledge-local: Dense importVectorsFrom requires vectorCacheDir')
  }
}

function validateDenseStorageOptions(exactScanMaxElements: number, connectivity: number, expansionAdd: number): void {
  if (!Number.isSafeInteger(exactScanMaxElements) || exactScanMaxElements < 1) {
    throw new TypeError('knowledge-local: Dense exactScanMaxElements must be a positive safe integer')
  }
  for (const [label, value] of [
    ['connectivity', connectivity],
    ['expansionAdd', expansionAdd],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`knowledge-local: Dense ${label} must be positive`)
  }
}

export function validateDeriveOptions(options: DeriveKnowledgeIndexOptions): void {
  validateDenseStorageOptions(
    options.exactScanMaxElements ?? DEFAULT_EXACT_SCAN_MAX_ELEMENTS,
    options.connectivity ?? DEFAULT_HNSW_CONNECTIVITY,
    options.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD,
  )
}

/**
 * Resolve the storage recommendation from the completed chunk count.
 * @param documentCount - source documents stored in SQLite.
 * @param chunkCount - vectors that will be generated.
 * @param options - validated Dense build settings.
 * @returns immutable sizes and the conservative Exact/HNSW recommendation.
 */
export function createDenseIndexBuildPlan(
  documentCount: number,
  chunkCount: number,
  options: BuildDenseIndexOptions,
): DenseIndexBuildPlan {
  return denseIndexBuildPlan(
    documentCount,
    chunkCount,
    options.dimensions ?? DENSE_DIMENSIONS,
    options.exactScanMaxElements ?? DEFAULT_EXACT_SCAN_MAX_ELEMENTS,
    options.denseIndex ?? 'auto',
    options.connectivity ?? DEFAULT_HNSW_CONNECTIVITY,
  )
}

export function denseIndexBuildPlan(
  documentCount: number,
  chunkCount: number,
  dimensions: number,
  exactScanMaxElements: number,
  requestedIndex: DenseIndexRequest,
  connectivity: number,
): DenseIndexBuildPlan {
  const scanElements = chunkCount * dimensions
  if (!Number.isSafeInteger(scanElements)) throw new TypeError('knowledge-local: Dense scanElements exceeds safe integer range')
  const estimatedExactBytes = scanElements * Float32Array.BYTES_PER_ELEMENT
  const estimatedHnswBytes = estimatedExactBytes + chunkCount * connectivity * BigUint64Array.BYTES_PER_ELEMENT
  return {
    documentCount,
    chunkCount,
    dimensions,
    scanElements,
    exactScanMaxElements,
    requestedIndex,
    recommendedIndex: scanElements <= exactScanMaxElements ? 'exact' : 'hnsw',
    estimatedExactBytes,
    estimatedHnswBytes,
    estimatedBothBytes: estimatedExactBytes + estimatedHnswBytes,
  }
}

export async function resolveDenseIndexMode(
  plan: DenseIndexBuildPlan,
  selectIndex: BuildDenseIndexOptions['selectIndex'],
): Promise<DenseIndexMode> {
  if (plan.requestedIndex !== 'auto') return plan.requestedIndex
  const selected: unknown = selectIndex === undefined ? plan.recommendedIndex : await selectIndex(plan)
  if (selected !== 'exact' && selected !== 'hnsw' && selected !== 'both') {
    throw new TypeError('knowledge-local: Dense index selection must be exact, hnsw, or both')
  }
  return selected
}

export function vectorCacheConfig(options: BuildDenseIndexOptions): DenseVectorCacheConfig {
  return {
    modelId: options.modelId,
    revision: options.revision,
    dtype: options.dtype,
    modelFile: options.modelFile ?? BGE_DENSE_MODEL_FILE,
    pooling: 'cls',
    normalized: true,
    dimensions: options.dimensions ?? DENSE_DIMENSIONS,
    maxTokens: options.maxTokens ?? DEFAULT_DENSE_MAX_TOKENS,
    queryPrefix: options.queryPrefix ?? BGE_QUERY_PREFIX,
    implementationVersion: DENSE_ENCODING_IMPLEMENTATION_VERSION,
  }
}

interface MutableDenseVectorBuildStats {
  totalInputCount: number
  cacheHitCount: number
  encodedInputCount: number
  embeddingBatchCount: number
  timingsMs: {
    cacheLookup: number
    embedding: number
    cacheWrite: number
    exactWrite: number
    hnswAdd: number
  }
}

export async function writeDenseVectors(
  exactFile: FileHandle | undefined,
  writer: KnowledgeSqliteWriter,
  chunkCount: number,
  options: BuildDenseIndexOptions,
  hnsw: HnswBuilder | undefined,
  cache: DenseVectorCache | undefined,
  cacheConfig: DenseVectorCacheConfig,
): Promise<MutableDenseVectorBuildStats> {
  const stats: MutableDenseVectorBuildStats = {
    totalInputCount: 0,
    cacheHitCount: 0,
    encodedInputCount: 0,
    embeddingBatchCount: 0,
    timingsMs: { cacheLookup: 0, embedding: 0, cacheWrite: 0, exactWrite: 0, hnswAdd: 0 },
  }
  let writtenRows = 0
  try {
    for (;;) {
      const rows = writer.denseInputs(writtenRows - 1, options.batchSize)
      if (rows.length === 0) break
      stats.totalInputCount += rows.length
      let vectors: Float32Array
      if (cache === undefined) {
        const embeddingStartedAt = performance.now()
        vectors = await options.encoder.embedDocuments(rows.map(row => row.text))
        stats.timingsMs.embedding += performance.now() - embeddingStartedAt
        stats.encodedInputCount += rows.length
        stats.embeddingBatchCount += 1
        validateDenseVectors(vectors, rows.length, cacheConfig.dimensions, 'knowledge-local: Dense build output')
      } else {
        const keys = rows.map(row => denseVectorCacheKey(cacheConfig, row.text))
        const lookupStartedAt = performance.now()
        const available = cache.getMany(keys)
        stats.timingsMs.cacheLookup += performance.now() - lookupStartedAt
        const missing = new Map<string, string>()
        for (const [index, key] of keys.entries()) {
          if (!available.has(key)) missing.set(key, rows[index]?.text as string)
        }
        stats.encodedInputCount += missing.size
        stats.cacheHitCount += rows.length - missing.size
        if (missing.size > 0) {
          const missingEntries = [...missing.entries()]
          const embeddingStartedAt = performance.now()
          const encoded = await options.encoder.embedDocuments(missingEntries.map(([, text]) => text))
          stats.timingsMs.embedding += performance.now() - embeddingStartedAt
          stats.embeddingBatchCount += 1
          validateDenseVectors(encoded, missingEntries.length, cacheConfig.dimensions, 'knowledge-local: Dense build output')
          const cacheEntries = missingEntries.map(([key], index) => ({
            key,
            vector: encoded.slice(index * cacheConfig.dimensions, (index + 1) * cacheConfig.dimensions),
          }))
          const cacheWriteStartedAt = performance.now()
          cache.putMany(cacheEntries)
          stats.timingsMs.cacheWrite += performance.now() - cacheWriteStartedAt
          for (const entry of cacheEntries) available.set(entry.key, entry.vector)
        }
        vectors = new Float32Array(rows.length * cacheConfig.dimensions)
        for (const [index, key] of keys.entries()) {
          /* v8 ignore next -- every key is either a validated hit or a just-encoded cache entry. */
          const vector = available.get(key) as Float32Array
          vectors.set(vector, index * cacheConfig.dimensions)
        }
      }
      if (exactFile !== undefined) {
        const exactStartedAt = performance.now()
        await exactFile.write(denseBytes(vectors))
        stats.timingsMs.exactWrite += performance.now() - exactStartedAt
      }
      if (hnsw !== undefined) {
        const hnswStartedAt = performance.now()
        hnsw.add(writtenRows, vectors)
        stats.timingsMs.hnswAdd += performance.now() - hnswStartedAt
      }
      writtenRows += rows.length
    }
  } finally {
    await exactFile?.close()
  }
  /* v8 ignore next -- denseInputs reads every consecutive ordinal from the just-built owned SQLite table. */
  if (writtenRows !== chunkCount) throw new TypeError('knowledge-local: Dense row count does not match SQLite chunks')
  return stats
}

async function readExactVectorBatch(
  source: FileHandle,
  firstOrdinal: number,
  rowCount: number,
  dimensions: number,
): Promise<{ readonly bytes: Buffer; readonly vectors: Float32Array }> {
  const rowBytes = dimensions * Float32Array.BYTES_PER_ELEMENT
  const bytes = Buffer.allocUnsafeSlow(rowCount * rowBytes)
  let bytesRead = 0
  while (bytesRead < bytes.length) {
    const result = await source.read(bytes, bytesRead, bytes.length - bytesRead, firstOrdinal * rowBytes + bytesRead)
    /* v8 ignore next 3 -- source payload size is validated before the read; only a concurrent external truncation can reach this. */
    if (result.bytesRead === 0) {
      throw new TypeError('knowledge-local: source Dense payload ended before the target prefix')
    }
    bytesRead += result.bytesRead
  }
  const vectors = new Float32Array(bytes.buffer, bytes.byteOffset, rowCount * dimensions)
  validateDenseVectors(vectors, rowCount, dimensions, 'knowledge-local: source Dense prefix')
  return { bytes, vectors }
}

function assertImportConfiguration(source: DenseIndexManifest, config: DenseVectorCacheConfig): void {
  if (
    source.modelId !== config.modelId
    || source.revision !== config.revision
    || source.modelFile !== config.modelFile
    || source.dimensions !== config.dimensions
    || source.maxTokens !== config.maxTokens
    || source.queryPrefix !== config.queryPrefix
  ) {
    throw new TypeError('knowledge-local: imported Exact index Dense configuration does not match the current build')
  }
}

export async function importExactVectors(
  cache: DenseVectorCache,
  config: DenseVectorCacheConfig,
  sourceIndexDir: string,
  batchSize: number,
): Promise<number> {
  const source = await loadKnowledgeIndex(sourceIndexDir, { verifyPayloadHashes: true })
  let sourceFile: FileHandle | undefined
  try {
    if (source.manifest.dense === undefined || source.dense === undefined) {
      throw new TypeError('knowledge-local: imported index must retain dense.f32le')
    }
    assertImportConfiguration(source.manifest.dense, config)
    sourceFile = await open(source.dense.path, 'r')
    let importedVectorCount = 0
    let nextOrdinal = 0
    for (;;) {
      const rows = source.sqlite.denseInputs(nextOrdinal - 1, batchSize)
      if (rows.length === 0) break
      for (const [index, row] of rows.entries()) {
        /* v8 ignore next 2 -- the validated format-four SQLite schema requires consecutive ordinals. */
        if (row.ordinal !== nextOrdinal + index) {
          throw new TypeError('knowledge-local: imported Exact index Dense ordinals are not consecutive')
        }
      }
      const batch = await readExactVectorBatch(sourceFile, nextOrdinal, rows.length, config.dimensions)
      const entries = new Map<string, Float32Array>()
      for (const [index, row] of rows.entries()) {
        const key = denseVectorCacheKey(config, row.text)
        if (!entries.has(key)) {
          entries.set(key, batch.vectors.slice(index * config.dimensions, (index + 1) * config.dimensions))
        }
      }
      importedVectorCount += cache.putMany([...entries].map(([key, vector]) => ({ key, vector })))
      nextOrdinal += rows.length
    }
    /* v8 ignore next 2 -- index loading validates SQLite and manifest vector counts before import. */
    if (nextOrdinal !== source.manifest.dense.vectorCount) {
      throw new TypeError('knowledge-local: imported Exact index Dense row count is inconsistent')
    }
    return importedVectorCount
  } finally {
    await sourceFile?.close()
    source.sqlite.close()
  }
}

export async function writeDerivedDenseVectors(
  sourceFile: FileHandle,
  sourceSqlite: KnowledgeSqliteIndex,
  exactFile: FileHandle | undefined,
  writer: KnowledgeSqliteWriter,
  chunkCount: number,
  dimensions: number,
  batchSize: number,
  hnsw: HnswBuilder | undefined,
): Promise<void> {
  let writtenRows = 0
  for (;;) {
    const targetRows = writer.denseInputs(writtenRows - 1, batchSize)
    if (targetRows.length === 0) break
    const sourceRows = sourceSqlite.denseInputs(writtenRows - 1, batchSize)
    for (const [index, targetRow] of targetRows.entries()) {
      const sourceRow = sourceRows[index]
      if (
        sourceRow === undefined
        /* v8 ignore next -- both validated SQLite queries return the requested consecutive ordinal range. */
        || sourceRow.ordinal !== targetRow.ordinal
        || sourceRow.chunkId !== targetRow.chunkId
        || sourceRow.documentId !== targetRow.documentId
        || sourceRow.text !== targetRow.text
      ) {
        throw new TypeError(
          `knowledge-local: target Dense input at ordinal ${targetRow.ordinal} does not match the source index prefix`,
        )
      }
    }
    const batch = await readExactVectorBatch(sourceFile, writtenRows, targetRows.length, dimensions)
    if (exactFile !== undefined) await exactFile.write(batch.bytes)
    hnsw?.add(writtenRows, batch.vectors)
    writtenRows += targetRows.length
  }
  /* v8 ignore next -- denseInputs reads every consecutive ordinal from the just-built owned SQLite table. */
  if (writtenRows !== chunkCount) throw new TypeError('knowledge-local: derived Dense row count does not match SQLite chunks')
}
