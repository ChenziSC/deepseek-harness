/** Immutable BM25 and Dense index loading and validation. */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KnowledgeChunkId,
  KnowledgeDocumentId,
  KnowledgeError,
  type KnowledgeHit,
} from '@deepseek-ai/dsh-experimental-knowledge'
import { compareCodePoints, type Bm25Index, type Bm25Posting, type Bm25Term } from './bm25.ts'
import { DENSE_DIMENSIONS, DENSE_NORMALIZATION_TOLERANCE } from './dense.ts'

const MANIFEST_FILE = 'manifest.json'
const CHUNKS_FILE = 'chunks.jsonl'
const BM25_FILE = 'bm25.json'
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
  readonly pooling: 'cls'
  readonly normalized: true
  readonly dimensions: 384
}

/** Version-one local knowledge index manifest. */
export interface KnowledgeIndexManifest {
  readonly formatVersion: 1
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
    readonly analyzer: 'english-v1'
    readonly k1: number
    readonly b: number
  }
  readonly dense?: DenseIndexManifest
  readonly payloads: readonly PayloadManifest[]
}

/** One validated local index and its ordinal-aligned retrieval data. */
export interface LoadedKnowledgeIndex {
  readonly chunks: readonly KnowledgeHit[]
  readonly bm25: Bm25Index
  readonly dense?: {
    readonly dimensions: 384
    readonly vectors: Float32Array
  }
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
  exactFields(value, ['modelId', 'revision', 'dtype', 'pooling', 'normalized', 'dimensions'], 'manifest dense')
  if (
    value['dtype'] !== 'q8'
    || value['pooling'] !== 'cls'
    || value['normalized'] !== true
    || value['dimensions'] !== DENSE_DIMENSIONS
  ) {
    fail('manifest Dense representation is unsupported')
  }
  return {
    modelId: nonEmptyString(value['modelId'], 'manifest dense.modelId'),
    revision: revision(value['revision'], 'manifest dense.revision'),
    dtype: 'q8',
    pooling: 'cls',
    normalized: true,
    dimensions: DENSE_DIMENSIONS,
  }
}

function parseManifest(value: unknown): KnowledgeIndexManifest {
  if (!isRecord(value)) fail('manifest must be an object')
  const hasDense = 'dense' in value
  exactFields(
    value,
    ['formatVersion', 'createdBy', 'build', 'corpus', 'chunking', 'bm25', ...(hasDense ? ['dense'] : []), 'payloads'],
    'manifest',
  )
  if (value['formatVersion'] !== 1) fail('manifest formatVersion must be 1')
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
  exactFields(bm25, ['analyzer', 'k1', 'b'], 'manifest bm25')
  if (createdBy['package'] !== '@deepseek-ai/dsh-experimental-knowledge-local') fail('manifest package is unsupported')
  const durationMs = finiteNumber(build['durationMs'], 'manifest build.durationMs')
  if (durationMs < 0) fail('manifest build.durationMs must be non-negative')
  const documentCount = safeInteger(corpus['documentCount'], 'manifest corpus.documentCount')
  const chunkCount = safeInteger(corpus['chunkCount'], 'manifest corpus.chunkCount')
  const maxTokens = safeInteger(chunking['maxTokens'], 'manifest chunking.maxTokens')
  const overlapTokens = safeInteger(chunking['overlapTokens'], 'manifest chunking.overlapTokens')
  if (maxTokens < 1 || overlapTokens >= maxTokens) fail('manifest chunking limits are invalid')
  const k1 = finiteNumber(bm25['k1'], 'manifest bm25.k1')
  const b = finiteNumber(bm25['b'], 'manifest bm25.b')
  if (bm25['analyzer'] !== 'english-v1' || k1 <= 0 || b < 0 || b > 1) fail('manifest BM25 configuration is unsupported')
  const dense = hasDense ? parseDenseManifest(value['dense']) : undefined
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
  const expectedPaths = [CHUNKS_FILE, BM25_FILE, ...(dense === undefined ? [] : [DENSE_FILE])]
  if (paths.length !== expectedPaths.length || paths.some((path, index) => path !== expectedPaths[index])) {
    fail(`manifest payload paths must be ${expectedPaths.join(', ')}`)
  }
  return {
    formatVersion: 1,
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
    bm25: { analyzer: 'english-v1', k1, b },
    ...(dense === undefined ? {} : { dense }),
    payloads: parsedPayloads,
  }
}

function parseChunks(text: string): { chunks: KnowledgeHit[]; documentCount: number } {
  const chunks: KnowledgeHit[] = []
  const ids = new Set<string>()
  const documentIds = new Set<string>()
  for (const [lineIndex, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue
    const value = parseJson(line, `${CHUNKS_FILE}:${lineIndex + 1}`)
    if (!isRecord(value)) fail(`${CHUNKS_FILE}:${lineIndex + 1} must be an object`)
    const optionalFields = ['title', 'source'].filter(field => field in value)
    exactFields(value, ['ordinal', 'id', 'documentId', 'text', 'startToken', 'endToken', ...optionalFields], `${CHUNKS_FILE}:${lineIndex + 1}`)
    const ordinal = safeInteger(value['ordinal'], `${CHUNKS_FILE}:${lineIndex + 1} ordinal`)
    const id = nonEmptyString(value['id'], `${CHUNKS_FILE}:${lineIndex + 1} id`)
    const documentId = nonEmptyString(value['documentId'], `${CHUNKS_FILE}:${lineIndex + 1} documentId`)
    const body = nonEmptyString(value['text'], `${CHUNKS_FILE}:${lineIndex + 1} text`)
    const startToken = safeInteger(value['startToken'], `${CHUNKS_FILE}:${lineIndex + 1} startToken`)
    const endToken = safeInteger(value['endToken'], `${CHUNKS_FILE}:${lineIndex + 1} endToken`)
    if (ordinal !== chunks.length || ids.has(id) || endToken <= startToken) {
      fail(`${CHUNKS_FILE}:${lineIndex + 1} has an invalid ordinal, id, or token range`)
    }
    if (id !== `${encodeURIComponent(documentId)}:${startToken}-${endToken}`) {
      fail(`${CHUNKS_FILE}:${lineIndex + 1} id does not match its document and token range`)
    }
    const title = value['title']
    const source = value['source']
    if (title !== undefined && typeof title !== 'string') fail(`${CHUNKS_FILE}:${lineIndex + 1} title must be a string`)
    if (source !== undefined && typeof source !== 'string') fail(`${CHUNKS_FILE}:${lineIndex + 1} source must be a string`)
    ids.add(id)
    documentIds.add(documentId)
    chunks.push({
      documentId: KnowledgeDocumentId(documentId),
      chunkId: KnowledgeChunkId(id),
      ...(title === undefined ? {} : { title }),
      text: body,
      ...(source === undefined ? {} : { source }),
      score: 0,
    })
  }
  return { chunks, documentCount: documentIds.size }
}

function parsePosting(value: unknown, label: string): Bm25Posting {
  if (!Array.isArray(value) || value.length !== 2) fail(`${label} must be [ordinal, termFrequency]`)
  const ordinal = safeInteger(value[0], `${label}[0]`)
  const frequency = safeInteger(value[1], `${label}[1]`)
  if (frequency < 1) fail(`${label}[1] must be positive`)
  return [ordinal, frequency]
}

function parseBm25(value: unknown): Bm25Index {
  if (!isRecord(value)) fail('bm25.json must be an object')
  exactFields(value, ['version', 'documentLengths', 'averageDocumentLength', 'terms'], 'bm25.json')
  if (value['version'] !== 1) fail('bm25.json version must be 1')
  const lengths = value['documentLengths']
  const terms = value['terms']
  if (!Array.isArray(lengths) || !Array.isArray(terms)) fail('bm25.json fields are incomplete')
  const documentLengths = lengths.map((length, index) => safeInteger(length, `bm25.documentLengths[${index}]`))
  let previousTerm: string | undefined
  const parsedTerms = terms.map((term, index): Bm25Term => {
    if (!isRecord(term)) fail(`bm25.terms[${index}] is invalid`)
    exactFields(term, ['term', 'documentFrequency', 'postings'], `bm25.terms[${index}]`)
    const termText = nonEmptyString(term['term'], `bm25.terms[${index}].term`)
    if (previousTerm !== undefined && compareCodePoints(previousTerm, termText) >= 0) fail('bm25 terms are not strictly sorted')
    previousTerm = termText
    if (!Array.isArray(term['postings'])) fail(`bm25.terms[${index}].postings must be an array`)
    const postings = term['postings'].map((posting, postingIndex) => parsePosting(posting, `bm25.terms[${index}].postings[${postingIndex}]`))
    for (let postingIndex = 0; postingIndex < postings.length; postingIndex += 1) {
      const posting = postings[postingIndex]
      if (
        posting === undefined
        || posting[0] >= documentLengths.length
        || (postingIndex > 0 && posting[0] <= (postings[postingIndex - 1]?.[0] ?? -1))
      ) {
        fail(`bm25.terms[${index}] postings are invalid`)
      }
    }
    const documentFrequency = safeInteger(term['documentFrequency'], `bm25.terms[${index}].documentFrequency`)
    if (documentFrequency !== postings.length) fail(`bm25.terms[${index}] documentFrequency is inconsistent`)
    return { term: termText, documentFrequency, postings }
  })
  const averageDocumentLength = finiteNumber(value['averageDocumentLength'], 'bm25.averageDocumentLength')
  const expectedAverage = documentLengths.length === 0
    ? 0
    : documentLengths.reduce((sum, length) => sum + length, 0) / documentLengths.length
  if (Math.abs(averageDocumentLength - expectedAverage) > Number.EPSILON * Math.max(1, expectedAverage)) {
    fail('bm25 averageDocumentLength is inconsistent')
  }
  return { version: 1, documentLengths, averageDocumentLength, terms: parsedTerms }
}

function parseDense(data: Buffer, chunkCount: number, dimensions: number): Float32Array {
  const expectedBytes = chunkCount * dimensions * Float32Array.BYTES_PER_ELEMENT
  if (data.byteLength !== expectedBytes) fail(`${DENSE_FILE} byte length does not match the manifest dimensions`)
  const vectors = new Float32Array(chunkCount * dimensions)
  for (let index = 0; index < vectors.length; index += 1) {
    const value = data.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
    if (!Number.isFinite(value)) fail(`${DENSE_FILE} contains a non-finite value`)
    vectors[index] = value
  }
  for (let row = 0; row < chunkCount; row += 1) {
    let squaredNorm = 0
    const offset = row * dimensions
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const value = vectors[offset + dimension] ?? 0
      squaredNorm += value * value
    }
    if (Math.abs(Math.sqrt(squaredNorm) - 1) > DENSE_NORMALIZATION_TOLERANCE) {
      fail(`${DENSE_FILE} row ${row} is not L2-normalized`)
    }
  }
  return vectors
}

async function verifiedPayload(indexDir: string, payload: PayloadManifest): Promise<Buffer> {
  const path = join(indexDir, payload.path)
  let data: Buffer
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size !== payload.bytes) fail(`${payload.path} size does not match manifest`)
    data = await readFile(path)
  } catch (error) {
    if (error instanceof KnowledgeError) throw error
    fail(`${payload.path} cannot be read`, { cause: error })
  }
  if (createHash('sha256').update(data).digest('hex') !== payload.sha256) fail(`${payload.path} hash does not match manifest`)
  return data
}

/**
 * Load and validate one complete immutable local knowledge index.
 * @param indexDir - directory containing the manifest and payloads.
 * @returns validated chunks, retrieval data, and manifest.
 */
export async function loadKnowledgeIndex(indexDir: string): Promise<LoadedKnowledgeIndex> {
  let manifestText: string
  try {
    manifestText = await readFile(join(indexDir, MANIFEST_FILE), 'utf8')
  } catch (error) {
    fail('manifest.json cannot be read', { cause: error })
  }
  const manifest = parseManifest(parseJson(manifestText, MANIFEST_FILE))
  const payloads = await Promise.all(manifest.payloads.map(payload => verifiedPayload(indexDir, payload)))
  const { chunks, documentCount } = parseChunks(payloads[0]?.toString('utf8') ?? '')
  const bm25 = parseBm25(parseJson(payloads[1]?.toString('utf8') ?? '', BM25_FILE))
  if (
    chunks.length !== manifest.corpus.chunkCount
    || documentCount !== manifest.corpus.documentCount
    || bm25.documentLengths.length !== chunks.length
  ) {
    fail('document or chunk counts disagree across manifest and payloads')
  }
  const dense = manifest.dense === undefined
    ? undefined
    : {
      dimensions: manifest.dense.dimensions,
      vectors: parseDense(payloads[2] ?? Buffer.alloc(0), chunks.length, manifest.dense.dimensions),
    } as const
  return { chunks, bm25, ...(dense === undefined ? {} : { dense }), manifest }
}
