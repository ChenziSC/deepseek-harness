/** Persistent content-addressed cache for document chunking and retrieval-text derivation. */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  KnowledgeChunkId,
  KnowledgeDocumentId,
  type KnowledgeChunkId as KnowledgeChunkIdType,
  type KnowledgeDocumentId as KnowledgeDocumentIdType,
} from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeBm25Analyzer } from './bm25.ts'
import type { ChunkingStrategy } from './chunker.ts'
import type { CorpusDocument } from './corpus.ts'
import { retrievalText } from './retrieval-text.ts'
import {
  inImmediateTransaction,
  isSha256Digest,
  lengthEncodedSha256,
} from './storage/cache-primitives.ts'

/** Fixed SQLite filename inside a document-derivation cache directory. */
export const DOCUMENT_DERIVATION_CACHE_FILE = 'documents.sqlite'
/** Version of the chunking and retrieval-text derivation semantics included in cache keys. */
export const DOCUMENT_DERIVATION_IMPLEMENTATION_VERSION = 'knowledge-local-document-derivation-v2'
/** Version of the BM25 preprocessing semantics stored in derived document payloads. */
export const BM25_PREPROCESS_IMPLEMENTATION_VERSION = 'knowledge-local-bm25-preprocess-v1'

/** Settings that determine reusable document-derived content. */
export interface DocumentDerivationCacheConfig {
  readonly tokenizerModelId: string
  readonly tokenizerRevision: string
  readonly chunkingStrategy: ChunkingStrategy
  readonly maxTokens: number
  readonly overlapTokens: number
  readonly analyzer: KnowledgeBm25Analyzer
  readonly bm25ImplementationVersion: typeof BM25_PREPROCESS_IMPLEMENTATION_VERSION
  readonly implementationVersion: typeof DOCUMENT_DERIVATION_IMPLEMENTATION_VERSION
}

/** One cached chunk without target-index ordinal or projected document metadata. */
interface DerivedChunk {
  readonly id: KnowledgeChunkIdType
  readonly sectionPath?: string
  readonly text: string
  readonly startToken: number
  readonly endToken: number
  readonly denseText: string
  readonly bm25Text: string
}

/** Complete reusable derivation for one source document. */
export interface DerivedDocument {
  readonly documentId: KnowledgeDocumentIdType
  readonly title?: string
  readonly chunks: readonly DerivedChunk[]
}

/** One content-addressed document derivation ready for an atomic cache write. */
export interface DocumentDerivationCacheEntry {
  readonly key: string
  readonly document: DerivedDocument
}

interface CacheRow {
  readonly config_sha256: unknown
  readonly payload_sha256: unknown
  readonly payload: unknown
}

function configValues(config: DocumentDerivationCacheConfig): readonly string[] {
  return [
    config.tokenizerModelId,
    config.tokenizerRevision,
    config.chunkingStrategy,
    String(config.maxTokens),
    String(config.overlapTokens),
    config.analyzer,
    config.bm25ImplementationVersion,
    config.implementationVersion,
  ]
}

/**
 * Hash the complete document-derivation configuration.
 * @param config - settings that must match before derived content can be reused.
 * @returns SHA-256 digest recorded with every cache entry.
 */
export function documentDerivationConfigSha256(config: DocumentDerivationCacheConfig): string {
  return lengthEncodedSha256(configValues(config))
}

/**
 * Address one derivation by configuration and source fields that affect retrieval content.
 * @param config - tokenizer, chunking, and BM25 preprocessing settings.
 * @param document - source document whose id, title, and text determine the result.
 * @returns length-delimited SHA-256 cache key.
 */
export function documentDerivationCacheKey(
  config: DocumentDerivationCacheConfig,
  document: Pick<CorpusDocument, 'id' | 'title' | 'text'>,
): string {
  return lengthEncodedSha256([
    ...configValues(config),
    document.id,
    document.title === undefined ? '0' : '1',
    ...(document.title === undefined ? [] : [document.title]),
    document.text,
  ])
}

function canonicalPayload(document: DerivedDocument): string {
  return JSON.stringify({
    documentId: document.documentId,
    title: document.title ?? null,
    chunks: document.chunks.map(chunk => ({
      id: chunk.id,
      sectionPath: chunk.sectionPath ?? null,
      text: chunk.text,
      startToken: chunk.startToken,
      endToken: chunk.endToken,
      denseText: chunk.denseText,
      bm25Text: chunk.bm25Text,
    })),
  })
}

function exactFields(value: Record<string, unknown>, expected: readonly string[], key: string, subject: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject} fields`)
  }
  if (actual.some((field, index) => field !== sortedExpected[index])) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject} fields`)
  }
}

function record(value: unknown, key: string, subject: string): Record<string, unknown> {
  if (typeof value !== 'object') {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  if (value === null) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  if (Array.isArray(value)) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, key: string, subject: string): string | undefined {
  if (value === null) return undefined
  if (typeof value !== 'string') {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  if (value.length === 0) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  return value
}

function nonEmptyString(value: unknown, key: string, subject: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  if (value.length === 0) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  return value
}

function nonNegativeInteger(value: unknown, key: string, subject: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  if (value < 0) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid ${subject}`)
  }
  return value
}

function parsePayload(bytes: Uint8Array, key: string, expected: Pick<CorpusDocument, 'id' | 'title'>): DerivedDocument {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
  } catch (error) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid JSON`, { cause: error })
  }
  const document = record(value, key, 'document')
  exactFields(document, ['documentId', 'title', 'chunks'], key, 'document')
  if (document['documentId'] !== expected.id) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has incompatible document identity`)
  }
  if (document['title'] !== (expected.title ?? null)) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has incompatible document identity`)
  }
  if (!Array.isArray(document['chunks'])) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has no chunks`)
  }
  if (document['chunks'].length === 0) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has no chunks`)
  }
  const chunks: DerivedChunk[] = []
  let previousStart = -1
  let previousEnd = -1
  for (const rawChunk of document['chunks']) {
    const chunk = record(rawChunk, key, 'chunk')
    exactFields(chunk, ['id', 'sectionPath', 'text', 'startToken', 'endToken', 'denseText', 'bm25Text'], key, 'chunk')
    const startToken = nonNegativeInteger(chunk['startToken'], key, 'chunk start token')
    const endToken = nonNegativeInteger(chunk['endToken'], key, 'chunk end token')
    const id = nonEmptyString(chunk['id'], key, 'chunk id')
    const sectionPath = optionalString(chunk['sectionPath'], key, 'chunk section path')
    const text = nonEmptyString(chunk['text'], key, 'chunk text')
    const denseText = nonEmptyString(chunk['denseText'], key, 'Dense input')
    if (typeof chunk['bm25Text'] !== 'string') {
      throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid BM25 text`)
    }
    if (endToken <= startToken) {
      throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid chunk order or identity`)
    }
    if (startToken <= previousStart) {
      throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid chunk order or identity`)
    }
    if (endToken <= previousEnd) {
      throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid chunk order or identity`)
    }
    if (id !== `${encodeURIComponent(expected.id)}:${startToken}-${endToken}`) {
      throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid chunk order or identity`)
    }
    if (denseText !== retrievalText(expected.title, sectionPath, text)) {
      throw new TypeError(`knowledge-local: document derivation cache entry ${key} has invalid Dense input`)
    }
    chunks.push({
      id: KnowledgeChunkId(id),
      ...(sectionPath === undefined ? {} : { sectionPath }),
      text,
      startToken,
      endToken,
      denseText,
      bm25Text: chunk['bm25Text'],
    })
    previousStart = startToken
    previousEnd = endToken
  }
  return {
    documentId: KnowledgeDocumentId(expected.id),
    ...(expected.title === undefined ? {} : { title: expected.title }),
    chunks,
  }
}

function cachedDocument(
  value: unknown,
  key: string,
  configSha256: string,
  expected: Pick<CorpusDocument, 'id' | 'title'>,
): DerivedDocument {
  const row = value as CacheRow
  if (row.config_sha256 !== configSha256) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has an incompatible configuration digest`)
  }
  /* v8 ignore next 3 -- the STRICT TEXT column prevents a non-string durable digest. */
  if (typeof row.payload_sha256 !== 'string') {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has an invalid payload digest`)
  }
  if (!isSha256Digest(row.payload_sha256)) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has an invalid payload digest`)
  }
  /* v8 ignore next 3 -- the STRICT BLOB column prevents a non-byte durable payload. */
  if (!(row.payload instanceof Uint8Array)) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has an invalid payload`)
  }
  const digest = createHash('sha256').update(row.payload).digest('hex')
  if (digest !== row.payload_sha256) {
    throw new TypeError(`knowledge-local: document derivation cache entry ${key} has a payload digest mismatch`)
  }
  return parsePayload(row.payload, key, expected)
}

/** SQLite cache whose entries contain complete, ordinal-independent document derivations. */
export class DocumentDerivationCache {
  private readonly database: DatabaseSync
  private readonly select: StatementSync
  private readonly insert: StatementSync
  private readonly configSha256: string
  private closed = false

  private constructor(path: string, config: DocumentDerivationCacheConfig) {
    const database = new DatabaseSync(path)
    try {
      const version = database.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
      if (version?.['user_version'] !== 0 && version?.['user_version'] !== 1) {
        throw new TypeError('knowledge-local: document derivation cache schema version must be 1')
      }
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS derived_documents (
          cache_key TEXT PRIMARY KEY,
          config_sha256 TEXT NOT NULL,
          payload_sha256 TEXT NOT NULL,
          payload BLOB NOT NULL,
          CHECK (length(cache_key) = 64),
          CHECK (length(config_sha256) = 64),
          CHECK (length(payload_sha256) = 64)
        ) STRICT;
        PRAGMA user_version = 1;
      `)
      this.select = database.prepare(`
        SELECT config_sha256, payload_sha256, payload
        FROM derived_documents
        WHERE cache_key = ?
      `)
      this.insert = database.prepare(`
        INSERT INTO derived_documents(cache_key, config_sha256, payload_sha256, payload)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cache_key) DO NOTHING
      `)
    } catch (error) {
      database.close()
      throw error
    }
    this.database = database
    this.configSha256 = documentDerivationConfigSha256(config)
  }

  /**
   * Open or create one reusable document-derivation cache.
   * @param directory - directory that owns the fixed SQLite cache file.
   * @param config - derivation settings for every requested key.
   * @returns open cache handle that the caller must close.
   */
  static async open(directory: string, config: DocumentDerivationCacheConfig): Promise<DocumentDerivationCache> {
    await mkdir(directory, { recursive: true })
    return new DocumentDerivationCache(join(directory, DOCUMENT_DERIVATION_CACHE_FILE), config)
  }

  /**
   * Read and validate complete document derivations for a bounded source batch.
   * @param requests - content-addressed keys paired with their expected document identity.
   * @returns unique cache hits keyed by digest.
   */
  getMany(
    requests: ReadonlyArray<{ readonly key: string; readonly document: Pick<CorpusDocument, 'id' | 'title'> }>,
  ): Map<string, DerivedDocument> {
    const documents = new Map<string, DerivedDocument>()
    for (const request of new Map(requests.map(item => [item.key, item])).values()) {
      const row = this.select.get(request.key)
      if (row !== undefined) {
        documents.set(request.key, cachedDocument(row, request.key, this.configSha256, request.document))
      }
    }
    return documents
  }

  /**
   * Commit complete document derivations in one durable transaction.
   * @param entries - validated ordinal-independent entries from one source batch.
   * @returns number of keys newly inserted rather than already present.
   */
  putMany(entries: readonly DocumentDerivationCacheEntry[]): number {
    const payloads = entries.map((entry) => {
      const payload = Buffer.from(canonicalPayload(entry.document), 'utf8')
      parsePayload(payload, entry.key, {
        id: entry.document.documentId,
        ...(entry.document.title === undefined ? {} : { title: entry.document.title }),
      })
      return { ...entry, payload, payloadSha256: createHash('sha256').update(payload).digest('hex') }
    })
    return inImmediateTransaction(this.database, () => {
      let inserted = 0
      for (const entry of payloads) {
        const result = this.insert.run(entry.key, this.configSha256, entry.payloadSha256, entry.payload)
        inserted += Number(result.changes)
      }
      return inserted
    })
  }

  /** Close the cache after all committed entries are durable. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}
