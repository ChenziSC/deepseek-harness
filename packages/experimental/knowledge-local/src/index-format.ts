/** Immutable SQLite and Dense index loading and validation. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { KnowledgeError } from '@deepseek-ai/dsh-experimental-knowledge'
import {
  ENGLISH_ANALYZER,
  MIXED_ZH_EN_ANALYZER,
  compareCodePoints,
  type KnowledgeBm25Analyzer,
} from './bm25.ts'
import { validateDenseVectors } from './dense.ts'
import { BGE_DENSE_MODEL_FILE } from './model-runtime.ts'
import { HNSW_FILE, USEARCH_VERSION } from './hnsw.ts'
import {
  KNOWLEDGE_SQLITE_FILE,
  openKnowledgeSqlite,
  type KnowledgeSqliteIndex,
} from './sqlite-index.ts'
import type { DenseIndexMode, DenseIndexRequest } from './index-builder.ts'

const MANIFEST_FILE = 'manifest.json'
const DENSE_FILE = 'dense.f32le'

/** One fixed-name payload recorded in an index manifest. */
export interface PayloadManifest {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/** Dense model identity and vector representation recorded in an index. */
export interface DenseIndexManifest {
  readonly modelId: string
  readonly revision: string
  readonly dtype: 'q8'
  readonly modelFile: typeof BGE_DENSE_MODEL_FILE
  readonly pooling: 'cls'
  readonly normalized: true
  readonly dimensions: number
  readonly maxTokens: number
  readonly queryPrefix: string
  readonly vectorCount: number
  readonly scanElements: number
  readonly exactScanMaxElements: number
  readonly requestedIndex: DenseIndexRequest
  readonly recommendedIndex: 'exact' | 'hnsw'
  readonly resolvedIndex: DenseIndexMode
  readonly autoDenseIndex: 'exact' | 'hnsw'
}

/** HNSW graph identity and build parameters recorded in an index. */
export interface HnswIndexManifest {
  readonly library: 'usearch'
  readonly libraryVersion: string
  readonly metric: 'cosine'
  readonly dtype: 'f32'
  readonly connectivity: number
  readonly expansionAdd: number
}

/** Version-two local knowledge index manifest. */
export interface KnowledgeIndexManifest {
  readonly formatVersion: 2
  readonly createdBy: {
    readonly package: '@deepseek-ai/dsh-experimental-knowledge-local'
    readonly version: string
  }
  readonly build: { readonly durationMs: number }
  readonly corpus: {
    readonly sha256: string
    readonly documentCount: number
    readonly chunkCount: number
  }
  readonly chunking: {
    readonly tokenizerModelId: string
    readonly tokenizerRevision: string
    readonly maxTokens: number
    readonly overlapTokens: number
  }
  readonly bm25: {
    readonly analyzer: KnowledgeBm25Analyzer
    readonly implementation: 'sqlite-fts5'
  }
  readonly dense?: DenseIndexManifest
  readonly hnsw?: HnswIndexManifest
  readonly payloads: readonly PayloadManifest[]
}

/** One validated local index with a retained read-only SQLite handle. */
export interface LoadedKnowledgeIndex {
  readonly sqlite: KnowledgeSqliteIndex
  readonly dense?: {
    readonly dimensions: number
    readonly path: string
  }
  readonly hnsw?: { readonly path: string }
  readonly manifest: KnowledgeIndexManifest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string, options?: ErrorOptions): never {
  throw new KnowledgeError(`Knowledge index is invalid: ${message}`, 'KNOWLEDGE_SEARCH_FAILED', options)
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCodePoints)
  const expected = [...fields].sort(compareCodePoints)
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(`${label} fields are incompatible`)
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`)
  return value
}

function safeInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label)
  if (!Number.isSafeInteger(number) || number < 0) fail(`${label} must be a non-negative safe integer`)
  return number
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(`${label} must be a SHA-256 hex digest`)
  return value
}

function revision(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) fail(`${label} must be a full lowercase commit SHA`)
  return value
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    fail(`${label} is not valid JSON`, { cause: error })
  }
}

function parseDenseManifest(value: unknown): DenseIndexManifest {
  if (!isRecord(value)) fail('manifest dense must be an object')
  exactFields(
    value,
    [
      'modelId', 'revision', 'dtype', 'modelFile', 'pooling', 'normalized', 'dimensions', 'maxTokens', 'queryPrefix',
      'vectorCount', 'scanElements', 'exactScanMaxElements', 'requestedIndex', 'recommendedIndex', 'resolvedIndex',
      'autoDenseIndex',
    ],
    'manifest dense',
  )
  const dimensions = safeInteger(value['dimensions'], 'manifest dense.dimensions')
  const maxTokens = safeInteger(value['maxTokens'], 'manifest dense.maxTokens')
  const vectorCount = safeInteger(value['vectorCount'], 'manifest dense.vectorCount')
  const scanElements = safeInteger(value['scanElements'], 'manifest dense.scanElements')
  const exactScanMaxElements = safeInteger(value['exactScanMaxElements'], 'manifest dense.exactScanMaxElements')
  if (
    value['dtype'] !== 'q8'
    || value['modelFile'] !== BGE_DENSE_MODEL_FILE
    || value['pooling'] !== 'cls'
    || value['normalized'] !== true
    || dimensions < 1
    || maxTokens < 1
    || maxTokens > 8192
    || typeof value['queryPrefix'] !== 'string'
    || !['auto', 'exact', 'hnsw', 'both'].includes(value['requestedIndex'] as string)
    || !['exact', 'hnsw'].includes(value['recommendedIndex'] as string)
    || !['exact', 'hnsw', 'both'].includes(value['resolvedIndex'] as string)
    || !['exact', 'hnsw'].includes(value['autoDenseIndex'] as string)
    || scanElements !== vectorCount * dimensions
    || exactScanMaxElements < 1
  ) {
    fail('manifest Dense representation is unsupported')
  }
  return {
    modelId: nonEmptyString(value['modelId'], 'manifest dense.modelId'),
    revision: revision(value['revision'], 'manifest dense.revision'),
    dtype: 'q8',
    modelFile: BGE_DENSE_MODEL_FILE,
    pooling: 'cls',
    normalized: true,
    dimensions,
    maxTokens,
    queryPrefix: value['queryPrefix'],
    vectorCount,
    scanElements,
    exactScanMaxElements,
    requestedIndex: value['requestedIndex'] as DenseIndexRequest,
    recommendedIndex: value['recommendedIndex'] as 'exact' | 'hnsw',
    resolvedIndex: value['resolvedIndex'] as DenseIndexMode,
    autoDenseIndex: value['autoDenseIndex'] as 'exact' | 'hnsw',
  }
}

function parseHnswManifest(value: unknown): HnswIndexManifest {
  if (!isRecord(value)) fail('manifest hnsw must be an object')
  exactFields(value, ['library', 'libraryVersion', 'metric', 'dtype', 'connectivity', 'expansionAdd'], 'manifest hnsw')
  const connectivity = safeInteger(value['connectivity'], 'manifest hnsw.connectivity')
  const expansionAdd = safeInteger(value['expansionAdd'], 'manifest hnsw.expansionAdd')
  if (
    value['library'] !== 'usearch'
    || value['libraryVersion'] !== USEARCH_VERSION
    || value['metric'] !== 'cosine'
    || value['dtype'] !== 'f32'
    || connectivity < 1
    || expansionAdd < 1
  ) fail('manifest HNSW configuration is unsupported')
  return {
    library: 'usearch',
    libraryVersion: USEARCH_VERSION,
    metric: 'cosine',
    dtype: 'f32',
    connectivity,
    expansionAdd,
  }
}

function parseManifest(value: unknown): KnowledgeIndexManifest {
  if (!isRecord(value)) fail('manifest must be an object')
  const hasDense = 'dense' in value
  const hasHnsw = 'hnsw' in value
  exactFields(
    value,
    [
      'formatVersion', 'createdBy', 'build', 'corpus', 'chunking', 'bm25',
      ...(hasDense ? ['dense'] : []), ...(hasHnsw ? ['hnsw'] : []), 'payloads',
    ],
    'manifest',
  )
  if (value['formatVersion'] !== 2) fail('manifest formatVersion must be 2')
  const createdBy = value['createdBy']
  const build = value['build']
  const corpus = value['corpus']
  const chunking = value['chunking']
  const bm25 = value['bm25']
  const payloads = value['payloads']
  if (!isRecord(createdBy) || !isRecord(build) || !isRecord(corpus) || !isRecord(chunking) || !isRecord(bm25) || !Array.isArray(payloads)) {
    fail('manifest fields are incomplete')
  }
  exactFields(createdBy, ['package', 'version'], 'manifest createdBy')
  exactFields(build, ['durationMs'], 'manifest build')
  exactFields(corpus, ['sha256', 'documentCount', 'chunkCount'], 'manifest corpus')
  exactFields(chunking, ['tokenizerModelId', 'tokenizerRevision', 'maxTokens', 'overlapTokens'], 'manifest chunking')
  exactFields(bm25, ['analyzer', 'implementation'], 'manifest bm25')
  if (createdBy['package'] !== '@deepseek-ai/dsh-experimental-knowledge-local') fail('manifest package is unsupported')
  const durationMs = finiteNumber(build['durationMs'], 'manifest build.durationMs')
  if (durationMs < 0) fail('manifest build.durationMs must be non-negative')
  const documentCount = safeInteger(corpus['documentCount'], 'manifest corpus.documentCount')
  const chunkCount = safeInteger(corpus['chunkCount'], 'manifest corpus.chunkCount')
  const maxTokens = safeInteger(chunking['maxTokens'], 'manifest chunking.maxTokens')
  const overlapTokens = safeInteger(chunking['overlapTokens'], 'manifest chunking.overlapTokens')
  if (maxTokens < 1 || overlapTokens >= maxTokens) fail('manifest chunking limits are invalid')
  if (
    (bm25['analyzer'] !== ENGLISH_ANALYZER && bm25['analyzer'] !== MIXED_ZH_EN_ANALYZER)
    || bm25['implementation'] !== 'sqlite-fts5'
  ) {
    fail('manifest BM25 configuration is unsupported')
  }
  const dense = hasDense ? parseDenseManifest(value['dense']) : undefined
  const hnsw = hasHnsw ? parseHnswManifest(value['hnsw']) : undefined
  if (dense !== undefined) {
    if (dense.vectorCount !== chunkCount) fail('manifest Dense vectorCount does not match corpus.chunkCount')
    const recommended = dense.scanElements <= dense.exactScanMaxElements ? 'exact' : 'hnsw'
    if (dense.recommendedIndex !== recommended) fail('manifest Dense recommendation is inconsistent')
    if (dense.requestedIndex !== 'auto' && dense.resolvedIndex !== dense.requestedIndex) {
      fail('manifest Dense resolvedIndex is inconsistent')
    }
    const expectedDefault = dense.resolvedIndex === 'both' ? dense.recommendedIndex : dense.resolvedIndex
    if (dense.autoDenseIndex !== expectedDefault) fail('manifest Dense autoDenseIndex is inconsistent')
    if ((dense.resolvedIndex === 'hnsw' || dense.resolvedIndex === 'both') !== (hnsw !== undefined)) {
      fail('manifest HNSW payload selection is inconsistent')
    }
  } else if (hnsw !== undefined) {
    fail('manifest HNSW payload requires Dense metadata')
  }
  const parsedPayloads = payloads.map((payload, index): PayloadManifest => {
    if (!isRecord(payload)) fail(`manifest payloads[${index}] must be an object`)
    exactFields(payload, ['path', 'bytes', 'sha256'], `manifest payloads[${index}]`)
    return {
      path: nonEmptyString(payload['path'], `manifest payloads[${index}].path`),
      bytes: safeInteger(payload['bytes'], `manifest payloads[${index}].bytes`),
      sha256: hash(payload['sha256'], `manifest payloads[${index}].sha256`),
    }
  })
  const paths = parsedPayloads.map(payload => payload.path)
  const expectedPaths = [
    KNOWLEDGE_SQLITE_FILE,
    ...(dense?.resolvedIndex === 'exact' || dense?.resolvedIndex === 'both' ? [DENSE_FILE] : []),
    ...(hnsw === undefined ? [] : [HNSW_FILE]),
  ]
  if (paths.length !== expectedPaths.length || paths.some((path, index) => path !== expectedPaths[index])) {
    fail(`manifest payload paths must be ${expectedPaths.join(', ')}`)
  }
  const densePayload = parsedPayloads.find(payload => payload.path === DENSE_FILE)
  if (
    densePayload !== undefined
    && dense !== undefined
    && densePayload.bytes !== chunkCount * dense.dimensions * Float32Array.BYTES_PER_ELEMENT
  ) {
    fail(`${DENSE_FILE} byte length does not match the manifest dimensions`)
  }
  return {
    formatVersion: 2,
    createdBy: {
      package: '@deepseek-ai/dsh-experimental-knowledge-local',
      version: nonEmptyString(createdBy['version'], 'manifest createdBy.version'),
    },
    build: { durationMs },
    corpus: {
      sha256: hash(corpus['sha256'], 'manifest corpus.sha256'),
      documentCount,
      chunkCount,
    },
    chunking: {
      tokenizerModelId: nonEmptyString(chunking['tokenizerModelId'], 'manifest chunking.tokenizerModelId'),
      tokenizerRevision: nonEmptyString(chunking['tokenizerRevision'], 'manifest chunking.tokenizerRevision'),
      maxTokens,
      overlapTokens,
    },
    bm25: { analyzer: bm25['analyzer'], implementation: 'sqlite-fts5' },
    ...(dense === undefined ? {} : { dense }),
    ...(hnsw === undefined ? {} : { hnsw }),
    payloads: parsedPayloads,
  }
}

async function verifyPayload(indexDir: string, payload: PayloadManifest, verifyHash: boolean): Promise<string> {
  const path = join(indexDir, payload.path)
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size !== payload.bytes) fail(`${payload.path} size does not match manifest`)
    if (verifyHash) {
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
      if (digest.digest('hex') !== payload.sha256) fail(`${payload.path} hash does not match manifest`)
    }
  } catch (error) {
    if (error instanceof KnowledgeError) throw error
    fail(`${payload.path} cannot be read`, { cause: error })
  }
  return path
}

/** Controls the cost of loading a local knowledge index. */
export interface LoadKnowledgeIndexOptions {
  /** Recompute every payload SHA-256 instead of checking only file type and size. */
  readonly verifyPayloadHashes?: boolean
}

function parseDense(data: Buffer, chunkCount: number, dimensions: number): Float32Array {
  const vectors = new Float32Array(chunkCount * dimensions)
  for (let index = 0; index < vectors.length; index += 1) {
    vectors[index] = data.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
  }
  try {
    validateDenseVectors(vectors, chunkCount, dimensions, `knowledge-local: ${DENSE_FILE}`)
  } catch (error) {
    /* v8 ignore next -- validateDenseVectors throws TypeError for every rejected vector payload. */
    fail((error as Error).message.replace(/^knowledge-local: /u, ''), { cause: error })
  }
  return vectors
}

/**
 * Load and validate one complete immutable local knowledge index.
 * @param indexDir - directory containing the manifest and payloads.
 * @param options - optional full payload hash verification; disabled by default for large indexes.
 * @returns manifest, read-only SQLite handle, and optional lazy Dense payload.
 */
export async function loadKnowledgeIndex(
  indexDir: string,
  options: LoadKnowledgeIndexOptions = {},
): Promise<LoadedKnowledgeIndex> {
  let manifestText: string
  try {
    manifestText = await readFile(join(indexDir, MANIFEST_FILE), 'utf8')
  } catch (error) {
    fail('manifest.json cannot be read', { cause: error })
  }
  const manifest = parseManifest(parseJson(manifestText, MANIFEST_FILE))
  const paths = await Promise.all(
    manifest.payloads.map(payload => verifyPayload(indexDir, payload, options.verifyPayloadHashes ?? false)),
  )
  let sqlite: KnowledgeSqliteIndex
  try {
    sqlite = openKnowledgeSqlite(
      paths[0] as string,
      manifest.corpus.documentCount,
      manifest.corpus.chunkCount,
      manifest.bm25.analyzer,
    )
  } catch (error) {
    fail('knowledge.sqlite schema or contents are incompatible', { cause: error })
  }
  const payloadPaths = new Map(manifest.payloads.map((payload, index) => [payload.path, paths[index] as string]))
  const exactPath = payloadPaths.get(DENSE_FILE)
  const dense = manifest.dense === undefined || exactPath === undefined
    ? undefined
    : { dimensions: manifest.dense.dimensions, path: exactPath } as const
  const hnswPath = payloadPaths.get(HNSW_FILE)
  const hnsw = manifest.hnsw === undefined || hnswPath === undefined ? undefined : { path: hnswPath } as const
  return {
    sqlite,
    ...(dense === undefined ? {} : { dense }),
    ...(hnsw === undefined ? {} : { hnsw }),
    manifest,
  }
}

/**
 * Recompute every payload digest and validate the complete index.
 * @param indexDir - directory containing the manifest and payloads.
 * @returns the validated manifest after closing the temporary SQLite handle.
 */
export async function verifyKnowledgeIndex(indexDir: string): Promise<KnowledgeIndexManifest> {
  const index = await loadKnowledgeIndex(indexDir, { verifyPayloadHashes: true })
  index.sqlite.close()
  return index.manifest
}

/**
 * Materialize and validate Exact vectors only when a caller selects Exact Dense retrieval.
 * @param index - loaded index whose Dense payload was already size- and hash-verified.
 * @returns ordinal-aligned normalized float32 vectors.
 */
export async function loadDenseVectors(index: LoadedKnowledgeIndex): Promise<Float32Array> {
  if (index.dense === undefined) fail('dense.f32le is unavailable')
  let data: Buffer
  try {
    data = await readFile(index.dense.path)
  } catch (error) {
    fail(`${DENSE_FILE} cannot be read`, { cause: error })
  }
  return parseDense(data, index.manifest.corpus.chunkCount, index.dense.dimensions)
}
