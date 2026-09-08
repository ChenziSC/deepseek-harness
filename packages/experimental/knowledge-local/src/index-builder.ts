/** Offline construction of immutable local knowledge indexes. */

import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { createGunzip } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { CorpusFormatError, parseCorpusDocumentLine, type CorpusDocument } from './corpus.ts'
import {
  chunkDocuments,
  DEFAULT_CHUNKING_STRATEGY,
  type ChunkRecord,
  type ChunkingOptions,
} from './chunker.ts'
import { DENSE_DIMENSIONS, validateDenseVectors } from './dense.ts'
import { BGE_DENSE_MODEL_FILE, BGE_QUERY_PREFIX, DEFAULT_DENSE_MAX_TOKENS } from './model-runtime.ts'
import {
  MIXED_ZH_EN_ANALYZER,
  type KnowledgeBm25Analyzer,
} from './bm25.ts'
import {
  loadKnowledgeIndex,
  type DenseIndexManifest,
  type KnowledgeIndexManifest,
  type PayloadManifest,
} from './index-format.ts'
import type { DenseEncoder } from './model-runtime.ts'
import {
  KNOWLEDGE_SQLITE_FILE,
  KnowledgeSqliteWriter,
  type KnowledgeSqliteIndex,
} from './sqlite-index.ts'
import {
  DEFAULT_HNSW_CONNECTIVITY,
  DEFAULT_HNSW_EXPANSION_ADD,
  HNSW_FILE,
  HnswBuilder,
  USEARCH_VERSION,
} from './hnsw.ts'
import {
  BGE_SMALL_EN_MODEL_ID,
  BGE_SMALL_EN_REVISION,
  type ChunkTokenizer,
} from './tokenizer.ts'
import { countTextScripts, resolveTextScriptProfile, type TextScriptCounts } from './script-profile.ts'
import {
  DENSE_ENCODING_IMPLEMENTATION_VERSION,
  DenseVectorCache,
  denseVectorCacheKey,
  type DenseVectorCacheConfig,
} from './vector-cache.ts'

const DENSE_FILE = 'dense.f32le'
const MANIFEST_FILE = 'manifest.json'
const SOURCE_DATABASE_FILE = '.source.sqlite'

/** Default number of source documents and chunks committed per SQLite transaction. */
export const DEFAULT_SQLITE_BATCH_SIZE = 500
/** Default maximum scalar comparisons selected for Exact Dense retrieval. */
export const DEFAULT_EXACT_SCAN_MAX_ELEMENTS = 50_000_000

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
  /** Verified format-three Exact index used to prefill the vector cache. */
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
  /** Format-version-three source index that retains `dense.f32le`. */
  readonly sourceIndexDir: string
  /** Dense payloads retained by the derived index. */
  readonly denseIndex: DenseIndexMode
  /** Maximum scalar comparisons used only to record the size recommendation. */
  readonly exactScanMaxElements?: number
  readonly connectivity?: number
  readonly expansionAdd?: number
}

interface SourceDocumentRow {
  readonly id: string
  readonly title: string | null
  readonly source: string | null
  readonly text: string
}

interface PendingDocument {
  readonly document: CorpusDocument
  readonly line: number
}

function denseBytes(vectors: Float32Array): Buffer {
  const data = Buffer.allocUnsafe(vectors.length * Float32Array.BYTES_PER_ELEMENT)
  for (let index = 0; index < vectors.length; index += 1) {
    data.writeFloatLE(vectors[index] as number, index * Float32Array.BYTES_PER_ELEMENT)
  }
  return data
}

async function prepareOutputDirectory(outputDir: string): Promise<void> {
  try {
    const entries = await readdir(outputDir)
    if (entries.length > 0) throw new Error(`knowledge-local: output directory is not empty: ${outputDir}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(outputDir, { recursive: true })
  }
}

async function packageVersion(): Promise<string> {
  const text = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const value = JSON.parse(text) as { version?: unknown }
  /* v8 ignore next -- package metadata validation guarantees the published version field. */
  if (typeof value.version !== 'string') throw new TypeError('knowledge-local: package version is unavailable')
  return value.version
}

async function payloadManifest(outputDir: string, path: string): Promise<PayloadManifest> {
  const target = join(outputDir, path)
  const metadata = await stat(target)
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(target)) digest.update(chunk as Buffer)
  return { path, bytes: metadata.size, sha256: digest.digest('hex') }
}

function inputStream(options: BuildBm25IndexOptions): Readable {
  if ((options.corpusText === undefined) === (options.corpusPath === undefined)) {
    throw new TypeError('knowledge-local: exactly one of corpusText or corpusPath is required')
  }
  if (options.corpusText !== undefined) return Readable.from([Buffer.from(options.corpusText)])
  const stream = createReadStream(options.corpusPath as string)
  return options.corpusPath?.endsWith('.gz') === true ? stream.pipe(createGunzip()) : stream
}

async function* nonBlankCorpusLines(
  options: BuildBm25IndexOptions,
  digest: Hash,
): AsyncGenerator<{ line: number; text: string }> {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let line = 0
  for await (const value of inputStream(options)) {
    const chunk = Buffer.from(value as Uint8Array)
    digest.update(chunk)
    pending += decoder.write(chunk)
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      line += 1
      const text = pending.slice(0, newline).replace(/\r$/u, '')
      pending = pending.slice(newline + 1)
      if (text.trim().length > 0 && !(options.corpusFormat === 't2ranking' && line === 1 && text === 'pid\ttext')) {
        yield { line, text }
      }
    }
  }
  pending += decoder.end()
  if (pending.length > 0) {
    line += 1
    const text = pending.replace(/\r$/u, '')
    if (text.trim().length > 0 && !(options.corpusFormat === 't2ranking' && line === 1 && text === 'pid\ttext')) {
      yield { line, text }
    }
  }
}

function sourceDocument(row: unknown): CorpusDocument {
  const value = row as SourceDocumentRow
  return {
    id: value.id as CorpusDocument['id'],
    text: value.text,
    ...(value.title === null ? {} : { title: value.title }),
    ...(value.source === null ? {} : { source: value.source }),
  }
}

function commitSourceBatch(
  database: DatabaseSync,
  insert: ReturnType<DatabaseSync['prepare']>,
  batch: readonly PendingDocument[],
  source: string,
): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const { document, line } of batch) {
      try {
        insert.run(document.id, document.title ?? null, document.source ?? null, document.text)
      } catch (error) {
        /* v8 ignore next -- node:sqlite reports statement failures as Error instances. */
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          throw new CorpusFormatError(source, line, `duplicate document id ${JSON.stringify(document.id)}`)
        }
        /* v8 ignore next -- non-uniqueness SQLite failures are external I/O faults and propagate unchanged. */
        throw error
      }
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function stageCorpus(
  options: BuildBm25IndexOptions,
  batchSize: number,
): Promise<{ database: DatabaseSync; corpusSha256: string; documentCount: number; scriptCounts: TextScriptCounts }> {
  const source = options.corpusSource ?? options.corpusPath ?? 'corpus.jsonl'
  const database = new DatabaseSync(join(options.outputDir, SOURCE_DATABASE_FILE))
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE source_documents (
        id TEXT PRIMARY KEY,
        title TEXT,
        source TEXT,
        text TEXT NOT NULL
      ) STRICT;
    `)
    const insert = database.prepare('INSERT INTO source_documents(id, title, source, text) VALUES (?, ?, ?, ?)')
    const digest = createHash('sha256')
    const batch: PendingDocument[] = []
    let documentCount = 0
    let latin = 0
    let cjk = 0
    for await (const input of nonBlankCorpusLines(options, digest)) {
      const document = parseCorpusDocumentLine(input.text, options.corpusFormat ?? 'generic', source, input.line)
      batch.push({
        document,
        line: input.line,
      })
      const counts = countTextScripts(`${document.title ?? ''}\n${document.text}`)
      latin += counts.latin
      cjk += counts.cjk
      documentCount += 1
      if (batch.length === batchSize) {
        commitSourceBatch(database, insert, batch, source)
        batch.length = 0
      }
    }
    if (batch.length > 0) commitSourceBatch(database, insert, batch, source)
    return { database, corpusSha256: digest.digest('hex'), documentCount, scriptCounts: { latin, cjk } }
  } catch (error) {
    database.close()
    throw error
  }
}

function writeChunks(
  sourceDatabase: DatabaseSync,
  writer: KnowledgeSqliteWriter,
  tokenizer: ChunkTokenizer,
  chunking: ChunkingOptions,
  batchSize: number,
): number {
  const select = sourceDatabase.prepare('SELECT id, title, source, text FROM source_documents ORDER BY id COLLATE BINARY')
  const batch: ChunkRecord[] = []
  let ordinal = 0
  for (const row of select.iterate()) {
    for (const chunk of chunkDocuments([sourceDocument(row)], tokenizer, chunking)) {
      batch.push({ ...chunk, ordinal })
      ordinal += 1
      if (batch.length === batchSize) {
        writer.insert(batch)
        batch.length = 0
      }
    }
  }
  if (batch.length > 0) writer.insert(batch)
  return ordinal
}

function validateDenseOptions(options: BuildDenseIndexOptions): void {
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
  const exactScanMaxElements = options.exactScanMaxElements ?? DEFAULT_EXACT_SCAN_MAX_ELEMENTS
  if (!Number.isSafeInteger(exactScanMaxElements) || exactScanMaxElements < 1) {
    throw new TypeError('knowledge-local: Dense exactScanMaxElements must be a positive safe integer')
  }
  for (const [label, value] of [
    ['connectivity', options.connectivity ?? DEFAULT_HNSW_CONNECTIVITY],
    ['expansionAdd', options.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`knowledge-local: Dense ${label} must be positive`)
  }
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

function validateDeriveOptions(options: DeriveKnowledgeIndexOptions): void {
  const exactScanMaxElements = options.exactScanMaxElements ?? DEFAULT_EXACT_SCAN_MAX_ELEMENTS
  if (!Number.isSafeInteger(exactScanMaxElements) || exactScanMaxElements < 1) {
    throw new TypeError('knowledge-local: Dense exactScanMaxElements must be a positive safe integer')
  }
  for (const [label, value] of [
    ['connectivity', options.connectivity ?? DEFAULT_HNSW_CONNECTIVITY],
    ['expansionAdd', options.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`knowledge-local: Dense ${label} must be positive`)
  }
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

function denseIndexBuildPlan(
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

async function resolveDenseIndexMode(
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

function vectorCacheConfig(options: BuildDenseIndexOptions): DenseVectorCacheConfig {
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

async function writeDenseVectors(
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

async function importExactVectors(
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
        /* v8 ignore next 2 -- the validated format-three SQLite schema requires consecutive ordinals. */
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

async function writeDerivedDenseVectors(
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

/**
 * Build a complete local index and write the manifest last.
 * @param options - corpus, tokenizer, output, retrieval, and optional Dense settings.
 * @returns the manifest written after all payloads succeed.
 */
export async function buildKnowledgeIndex(options: BuildKnowledgeIndexOptions): Promise<KnowledgeIndexManifest> {
  const sqliteBatchSize = options.sqliteBatchSize ?? DEFAULT_SQLITE_BATCH_SIZE
  if (!Number.isSafeInteger(sqliteBatchSize) || sqliteBatchSize < 1) {
    throw new TypeError('knowledge-local: sqliteBatchSize must be a positive safe integer')
  }
  if (options.dense !== undefined) validateDenseOptions(options.dense)
  const analyzer = options.analyzer ?? MIXED_ZH_EN_ANALYZER
  await prepareOutputDirectory(options.outputDir)
  const startedAt = performance.now()
  const staged = await stageCorpus(options, sqliteBatchSize)
  const corpusStagingMs = performance.now() - startedAt
  let writer: KnowledgeSqliteWriter
  try {
    writer = new KnowledgeSqliteWriter(join(options.outputDir, KNOWLEDGE_SQLITE_FILE), analyzer)
  } catch (error) {
    /* v8 ignore next -- only an external filesystem or SQLite failure can prevent opening this new payload. */
    staged.database.close()
    /* v8 ignore next -- the original external error is propagated unchanged. */
    throw error
  }
  let chunkCount: number
  let hnsw: HnswBuilder | undefined
  let densePlan: DenseIndexBuildPlan | undefined
  let resolvedDenseIndex: DenseIndexMode | undefined
  let autoDenseIndex: 'exact' | 'hnsw' | undefined
  let vectorCache: DenseVectorCache | undefined
  let denseBuildStats: DenseVectorBuildStats | undefined
  try {
    let importedVectorCount = 0
    let importMs = 0
    if (options.dense?.vectorCacheDir !== undefined) {
      const config = vectorCacheConfig(options.dense)
      vectorCache = await DenseVectorCache.open(options.dense.vectorCacheDir, config)
      if (options.dense.importVectorsFrom !== undefined) {
        const importStartedAt = performance.now()
        importedVectorCount = await importExactVectors(
          vectorCache,
          config,
          options.dense.importVectorsFrom,
          options.dense.batchSize,
        )
        importMs = performance.now() - importStartedAt
      }
    }
    const chunkingStartedAt = performance.now()
    chunkCount = writeChunks(staged.database, writer, options.tokenizer, options.chunking, sqliteBatchSize)
    const chunkingMs = performance.now() - chunkingStartedAt
    const finalizeStartedAt = performance.now()
    writer.finalize(staged.documentCount, chunkCount)
    const sqliteFinalizeMs = performance.now() - finalizeStartedAt
    if (options.dense !== undefined) {
      const cacheConfig = vectorCacheConfig(options.dense)
      densePlan = createDenseIndexBuildPlan(staged.documentCount, chunkCount, options.dense)
      resolvedDenseIndex = await resolveDenseIndexMode(densePlan, options.dense.selectIndex)
      autoDenseIndex = resolvedDenseIndex === 'both' ? densePlan.recommendedIndex : resolvedDenseIndex
      if (resolvedDenseIndex === 'hnsw' || resolvedDenseIndex === 'both') {
        hnsw = new HnswBuilder({
          dimensions: densePlan.dimensions,
          connectivity: options.dense.connectivity ?? DEFAULT_HNSW_CONNECTIVITY,
          expansionAdd: options.dense.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD,
        })
      }
      const exactFile = resolvedDenseIndex === 'exact' || resolvedDenseIndex === 'both'
        ? await open(join(options.outputDir, DENSE_FILE), 'wx')
        : undefined
      const vectorStats = await writeDenseVectors(
        exactFile,
        writer,
        chunkCount,
        options.dense,
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
          chunking: chunkingMs,
          sqliteFinalize: sqliteFinalizeMs,
          import: importMs,
          ...vectorStats.timingsMs,
          hnswSave: hnswSaveMs,
        },
      }
    }
  } finally {
    vectorCache?.close()
    staged.database.close()
    writer.close()
  }
  await unlink(join(options.outputDir, SOURCE_DATABASE_FILE))
  const payloads = [await payloadManifest(options.outputDir, KNOWLEDGE_SQLITE_FILE)]
  if (resolvedDenseIndex === 'exact' || resolvedDenseIndex === 'both') {
    payloads.push(await payloadManifest(options.outputDir, DENSE_FILE))
  }
  if (hnsw !== undefined) payloads.push(await payloadManifest(options.outputDir, HNSW_FILE))
  const dense: DenseIndexManifest | undefined = options.dense === undefined
    ? undefined
    : {
      modelId: options.dense.modelId,
      revision: options.dense.revision,
      dtype: options.dense.dtype,
      modelFile: options.dense.modelFile ?? BGE_DENSE_MODEL_FILE,
      pooling: 'cls',
      normalized: true,
      dimensions: options.dense.dimensions ?? DENSE_DIMENSIONS,
      maxTokens: options.dense.maxTokens ?? DEFAULT_DENSE_MAX_TOKENS,
      queryPrefix: options.dense.queryPrefix ?? BGE_QUERY_PREFIX,
      vectorCount: chunkCount,
      scanElements: densePlan?.scanElements as number,
      exactScanMaxElements: densePlan?.exactScanMaxElements as number,
      requestedIndex: densePlan?.requestedIndex as DenseIndexRequest,
      recommendedIndex: densePlan?.recommendedIndex as 'exact' | 'hnsw',
      resolvedIndex: resolvedDenseIndex as DenseIndexMode,
      autoDenseIndex: autoDenseIndex as 'exact' | 'hnsw',
    }
  const manifest: KnowledgeIndexManifest = {
    formatVersion: 3,
    createdBy: {
      package: '@deepseek-ai/dsh-experimental-knowledge-local',
      version: await packageVersion(),
    },
    build: { durationMs: performance.now() - startedAt },
    corpus: {
      sha256: staged.corpusSha256,
      documentCount: staged.documentCount,
      chunkCount,
      scriptProfile: resolveTextScriptProfile(staged.scriptCounts),
    },
    chunking: {
      tokenizerModelId: options.tokenizerModelId ?? BGE_SMALL_EN_MODEL_ID,
      tokenizerRevision: options.tokenizerRevision ?? BGE_SMALL_EN_REVISION,
      maxTokens: options.chunking.maxTokens,
      overlapTokens: options.chunking.overlapTokens,
      strategy: options.chunking.strategy ?? DEFAULT_CHUNKING_STRATEGY,
    },
    bm25: { analyzer, implementation: 'sqlite-fts5' },
    ...(dense === undefined ? {} : { dense }),
    ...(hnsw === undefined ? {} : {
      hnsw: {
        library: 'usearch',
        libraryVersion: USEARCH_VERSION,
        metric: 'cosine',
        dtype: 'f32',
        connectivity: options.dense?.connectivity ?? DEFAULT_HNSW_CONNECTIVITY,
        expansionAdd: options.dense?.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD,
      },
    }),
    payloads,
  }
  await writeFile(join(options.outputDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  if (denseBuildStats !== undefined) options.dense?.onVectorBuildStats?.(denseBuildStats)
  return manifest
}

/**
 * Derive a smaller format-version-three index from the ordinal prefix of an existing Exact index.
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
  const sqliteBatchSize = options.sqliteBatchSize ?? DEFAULT_SQLITE_BATCH_SIZE
  if (!Number.isSafeInteger(sqliteBatchSize) || sqliteBatchSize < 1) {
    throw new TypeError('knowledge-local: sqliteBatchSize must be a positive safe integer')
  }
  validateDeriveOptions(options)
  await prepareOutputDirectory(options.outputDir)
  const source = await loadKnowledgeIndex(options.sourceIndexDir)
  try {
    const sourceDense = source.manifest.dense
    if (sourceDense === undefined || source.dense === undefined) {
      throw new TypeError('knowledge-local: source index must retain dense.f32le')
    }
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
    const startedAt = performance.now()
    const staged = await stageCorpus(options, sqliteBatchSize)
    let writer: KnowledgeSqliteWriter
    try {
      writer = new KnowledgeSqliteWriter(join(options.outputDir, KNOWLEDGE_SQLITE_FILE), analyzer)
    } catch (error) {
      /* v8 ignore next -- only an external filesystem or SQLite failure can prevent opening this new payload. */
      staged.database.close()
      /* v8 ignore next -- the original external error is propagated unchanged. */
      throw error
    }
    const connectivity = options.connectivity ?? source.manifest.hnsw?.connectivity ?? DEFAULT_HNSW_CONNECTIVITY
    const expansionAdd = options.expansionAdd ?? source.manifest.hnsw?.expansionAdd ?? DEFAULT_HNSW_EXPANSION_ADD
    const exactScanMaxElements = options.exactScanMaxElements ?? sourceDense.exactScanMaxElements
    let chunkCount: number
    let hnsw: HnswBuilder | undefined
    let densePlan: DenseIndexBuildPlan
    try {
      chunkCount = writeChunks(staged.database, writer, options.tokenizer, options.chunking, sqliteBatchSize)
      writer.finalize(staged.documentCount, chunkCount)
      densePlan = denseIndexBuildPlan(
        staged.documentCount,
        chunkCount,
        sourceDense.dimensions,
        exactScanMaxElements,
        options.denseIndex,
        connectivity,
      )
      if (options.denseIndex === 'hnsw' || options.denseIndex === 'both') {
        hnsw = new HnswBuilder({ dimensions: sourceDense.dimensions, connectivity, expansionAdd })
      }
      const sourceFile = await open(source.dense.path, 'r')
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
          sqliteBatchSize,
          hnsw,
        )
      } finally {
        await Promise.all([sourceFile.close(), exactFile?.close()])
      }
      hnsw?.save(join(options.outputDir, HNSW_FILE))
    } finally {
      staged.database.close()
      writer.close()
    }
    await unlink(join(options.outputDir, SOURCE_DATABASE_FILE))
    const payloads = [await payloadManifest(options.outputDir, KNOWLEDGE_SQLITE_FILE)]
    if (options.denseIndex === 'exact' || options.denseIndex === 'both') {
      payloads.push(await payloadManifest(options.outputDir, DENSE_FILE))
    }
    if (hnsw !== undefined) payloads.push(await payloadManifest(options.outputDir, HNSW_FILE))
    const dense: DenseIndexManifest = {
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
    }
    const manifest: KnowledgeIndexManifest = {
      formatVersion: 3,
      createdBy: {
        package: '@deepseek-ai/dsh-experimental-knowledge-local',
        version: await packageVersion(),
      },
      build: { durationMs: performance.now() - startedAt },
      corpus: {
        sha256: staged.corpusSha256,
        documentCount: staged.documentCount,
        chunkCount,
        scriptProfile: resolveTextScriptProfile(staged.scriptCounts),
      },
      chunking: {
        tokenizerModelId,
        tokenizerRevision,
        maxTokens: options.chunking.maxTokens,
        overlapTokens: options.chunking.overlapTokens,
        strategy: options.chunking.strategy ?? DEFAULT_CHUNKING_STRATEGY,
      },
      bm25: { analyzer, implementation: 'sqlite-fts5' },
      dense,
      ...(hnsw === undefined ? {} : {
        hnsw: {
          library: 'usearch',
          libraryVersion: USEARCH_VERSION,
          metric: 'cosine',
          dtype: 'f32',
          connectivity,
          expansionAdd,
        },
      }),
      payloads,
    }
    await writeFile(join(options.outputDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return manifest
  } finally {
    source.sqlite.close()
  }
}

/**
 * Build the BM25-only form of the local index.
 * @param options - corpus, tokenizer, output, chunking, and SQLite settings.
 * @returns the manifest written after the SQLite payload succeeds.
 */
export function buildBm25KnowledgeIndex(options: BuildBm25IndexOptions): Promise<KnowledgeIndexManifest> {
  return buildKnowledgeIndex(options)
}
