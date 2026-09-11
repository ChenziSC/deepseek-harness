/** SQLite storage for immutable chunk metadata and FTS5 BM25 retrieval. */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  KnowledgeChunkId,
  KnowledgeDocumentId,
  type KnowledgeHit,
} from '@deepseek-ai/dsh-experimental-knowledge'
import {
  analyzeBm25,
  type Bm25Match,
  type KnowledgeBm25Analyzer,
} from './bm25.ts'
import { parseRfc3339Instant } from './rfc3339.ts'
import { denseInputFromRow, type DenseInputRow } from './sqlite-rows.ts'

/** Fixed SQLite payload name in index format version 4. */
export const KNOWLEDGE_SQLITE_FILE = 'knowledge.sqlite'
/** Monotonic schema version stored in SQLite `user_version`. */
export const KNOWLEDGE_SQLITE_SCHEMA_VERSION = 3

interface ChunkRow {
  readonly ordinal: unknown
  readonly chunk_id: unknown
  readonly document_id: unknown
  readonly title: unknown
  readonly section_path: unknown
  readonly source: unknown
  readonly source_version: unknown
  readonly valid_from: unknown
  readonly valid_until: unknown
  readonly supersedes_document_id: unknown
  readonly text: unknown
  readonly start_token: unknown
  readonly end_token: unknown
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`knowledge-local: SQLite ${label} must be a non-negative safe integer`)
  }
  return value
}

function safeInteger(value: unknown, label: string): number {
  /* v8 ignore next -- SQLite COUNT/MIN/MAX return numeric values for the fixed schema below. */
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`knowledge-local: SQLite ${label} must be a safe integer`)
  }
  return value
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`knowledge-local: SQLite ${label} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === null) return undefined
  /* v8 ignore next -- the STRICT chunks table permits only text or null for these columns. */
  if (typeof value !== 'string') throw new TypeError(`knowledge-local: SQLite ${label} must be text or null`)
  return value
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === null) return undefined
  /* v8 ignore next 3 -- the STRICT INTEGER columns permit only numbers or null. */
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`knowledge-local: SQLite ${label} must be an integer or null`)
  }
  return value
}

function chunkFromRow(value: unknown): KnowledgeHit {
  /* v8 ignore next -- node:sqlite returns each selected row as an object. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('knowledge-local: SQLite chunk row must be an object')
  }
  const row = value as unknown as ChunkRow
  integer(row.ordinal, 'chunk ordinal')
  const chunkId = string(row.chunk_id, 'chunk id')
  const documentId = string(row.document_id, 'document id')
  const startToken = integer(row.start_token, 'chunk start token')
  const endToken = integer(row.end_token, 'chunk end token')
  if (endToken <= startToken || chunkId !== `${encodeURIComponent(documentId)}:${startToken}-${endToken}`) {
    throw new TypeError('knowledge-local: SQLite chunk identity or token range is invalid')
  }
  const title = optionalString(row.title, 'chunk title')
  const sectionPath = optionalString(row.section_path, 'chunk section path')
  const source = optionalString(row.source, 'chunk source')
  const sourceVersion = optionalString(row.source_version, 'document source version')
  const validFrom = optionalString(row.valid_from, 'document valid-from')
  const validUntil = optionalString(row.valid_until, 'document valid-until')
  const supersedes = optionalString(row.supersedes_document_id, 'superseded document id')
  return {
    documentId: KnowledgeDocumentId(documentId),
    chunkId: KnowledgeChunkId(chunkId),
    ...(title === undefined ? {} : { title }),
    ...(sectionPath === undefined ? {} : { sectionPath }),
    text: string(row.text, 'chunk text'),
    ...(source === undefined ? {} : { source }),
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(supersedes === undefined ? {} : { supersedes: KnowledgeDocumentId(supersedes) }),
    score: 0,
  }
}

/** Read-only SQLite handle retained for the provider lifetime. */
export class KnowledgeSqliteIndex {
  private readonly chunkByOrdinal: StatementSync
  private readonly denseInputAfterOrdinal: StatementSync
  private readonly bm25Search: StatementSync
  private closed = false

  constructor(
    private readonly database: DatabaseSync,
    private readonly analyzer: KnowledgeBm25Analyzer,
  ) {
    this.chunkByOrdinal = database.prepare(`
      SELECT
        c.ordinal, c.chunk_id, c.document_id, d.title, c.section_path, d.source,
        d.source_version, d.valid_from, d.valid_until, d.supersedes_document_id,
        c.text, c.start_token, c.end_token
      FROM chunks AS c
      JOIN documents AS d ON d.document_id = c.document_id
      WHERE c.ordinal = ?
    `)
    this.denseInputAfterOrdinal = database.prepare(`
      SELECT c.ordinal, c.chunk_id, c.document_id, d.title, c.section_path, c.text
      FROM chunks AS c
      JOIN documents AS d ON d.document_id = c.document_id
      WHERE c.ordinal > ?
      ORDER BY c.ordinal
      LIMIT ?
    `)
    this.bm25Search = database.prepare(`
      SELECT c.ordinal AS ordinal, -bm25(bm25_fts) AS score
      FROM bm25_fts
      JOIN chunks AS c ON c.ordinal = bm25_fts.rowid
      JOIN documents AS d ON d.document_id = c.document_id
      WHERE bm25_fts MATCH ?
        AND (d.valid_from_ms IS NULL OR d.valid_from_ms <= ?)
        AND (d.valid_until_ms IS NULL OR ? < d.valid_until_ms)
      ORDER BY bm25(bm25_fts), c.chunk_id COLLATE BINARY
      LIMIT ?
    `)
  }

  /**
   * Query the fixed FTS5 BM25 implementation.
   * @param query - natural-language query analyzed with the index analyzer.
   * @param limit - maximum candidates to return.
   * @param asOfMs - fixed query instant used for document validity.
   * @returns ranked ordinal and score pairs.
   */
  searchBm25(query: string, limit: number, asOfMs = Date.now()): Bm25Match[] {
    const tokens = [...new Set(analyzeBm25(this.analyzer, query))]
    if (tokens.length === 0) return []
    const expression = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ')
    return this.bm25Search.all(expression, asOfMs, asOfMs, limit).map((value) => {
      const row = value as Record<string, unknown>
      const ordinal = integer(row['ordinal'], 'BM25 ordinal')
      const score = row['score']
      /* v8 ignore next -- SQLite FTS5 bm25() returns a finite numeric rank. */
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new TypeError('knowledge-local: SQLite BM25 score must be finite')
      }
      return { ordinal, score }
    })
  }

  /**
   * Resolve document validity for every chunk ordinal at one instant.
   * @param asOfMs - fixed query instant as Unix milliseconds.
   * @param chunkCount - manifest chunk count used to size the mask.
   * @returns ordinal eligibility and the number of eligible chunks.
   */
  eligibleOrdinals(asOfMs: number, chunkCount: number): { readonly mask: Uint8Array; readonly count: number } {
    if (!Number.isSafeInteger(asOfMs)) throw new TypeError('knowledge-local: validity time must be a safe integer')
    const mask = new Uint8Array(chunkCount)
    const rows = this.database.prepare(`
      SELECT c.ordinal
      FROM chunks AS c
      JOIN documents AS d ON d.document_id = c.document_id
      WHERE (d.valid_from_ms IS NULL OR d.valid_from_ms <= ?)
        AND (d.valid_until_ms IS NULL OR ? < d.valid_until_ms)
      ORDER BY c.ordinal
    `).all(asOfMs, asOfMs)
    for (const value of rows) {
      const ordinal = integer((value as Record<string, unknown>)['ordinal'], 'eligible ordinal')
      if (ordinal >= chunkCount) throw new TypeError('knowledge-local: SQLite eligible ordinal is out of range')
      mask[ordinal] = 1
    }
    return { mask, count: rows.length }
  }

  /**
   * Load selected chunks in caller-provided order.
   * @param ordinals - chunk ordinals produced by a retrieval implementation.
   * @returns validated chunk records with zero placeholder scores.
   */
  chunks(ordinals: readonly number[]): KnowledgeHit[] {
    return ordinals.map((ordinal) => {
      const row = this.chunkByOrdinal.get(ordinal)
      if (row === undefined) throw new TypeError(`knowledge-local: SQLite chunk ordinal ${ordinal} is missing`)
      return { ...chunkFromRow(row), score: 0 }
    })
  }

  /**
   * Load immediate same-document neighbors for one ranked chunk.
   * @param ordinal - ranked chunk ordinal.
   * @returns optional previous and next chunks without retrieval scores.
   */
  adjacentChunks(ordinal: number): { readonly previous?: KnowledgeHit; readonly next?: KnowledgeHit } {
    const currentRow = this.chunkByOrdinal.get(ordinal)
    if (currentRow === undefined) throw new TypeError(`knowledge-local: SQLite chunk ordinal ${ordinal} is missing`)
    const current = chunkFromRow(currentRow)
    const previousRow = ordinal === 0 ? undefined : this.chunkByOrdinal.get(ordinal - 1)
    const nextRow = this.chunkByOrdinal.get(ordinal + 1)
    const previous = previousRow === undefined ? undefined : chunkFromRow(previousRow)
    const next = nextRow === undefined ? undefined : chunkFromRow(nextRow)
    return {
      ...(previous?.documentId === current.documentId ? { previous } : {}),
      ...(next?.documentId === current.documentId ? { next } : {}),
    }
  }

  /**
   * Load the complete validated corpus for explicit offline evaluation.
   * @returns all chunks in ordinal order.
   */
  allChunks(): KnowledgeHit[] {
    const rows = this.database.prepare(`
      SELECT
        c.ordinal, c.chunk_id, c.document_id, d.title, c.section_path, d.source,
        d.source_version, d.valid_from, d.valid_until, d.supersedes_document_id,
        c.text, c.start_token, c.end_token
      FROM chunks AS c
      JOIN documents AS d ON d.document_id = c.document_id
      ORDER BY c.ordinal
    `).all()
    return rows.map(row => ({ ...chunkFromRow(row), score: 0 }))
  }

  /**
   * Read one bounded consecutive batch of the exact inputs used for Dense encoding.
   * @param afterOrdinal - exclusive lower ordinal bound.
   * @param limit - maximum rows to return.
   * @returns title, section, and text inputs ordered by ordinal.
   */
  denseInputs(afterOrdinal: number, limit: number): DenseInputRow[] {
    return this.denseInputAfterOrdinal.all(afterOrdinal, limit).map(denseInputFromRow)
  }

  /**
   * Load unique source-document identifiers without materializing chunk text.
   * @returns identifiers sorted by binary code-point order.
   */
  documentIds(): string[] {
    return this.database.prepare('SELECT document_id FROM documents ORDER BY document_id COLLATE BINARY')
      .all()
      .map(value => string((value as Record<string, unknown>)['document_id'], 'document id'))
  }

  /** Close the read-only database handle. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}

/**
 * Open and validate the fixed read-only SQLite schema.
 * @param path - verified SQLite payload path.
 * @param documentCount - manifest document count.
 * @param chunkCount - manifest chunk count.
 * @param analyzer - BM25 analyzer recorded by the manifest.
 * @returns a read-only query handle.
 */
export function openKnowledgeSqlite(
  path: string,
  documentCount: number,
  chunkCount: number,
  analyzer: KnowledgeBm25Analyzer,
): KnowledgeSqliteIndex {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    database.exec('PRAGMA query_only = ON')
    database.exec('PRAGMA foreign_keys = ON')
    const version = database.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
    if (version?.['user_version'] !== KNOWLEDGE_SQLITE_SCHEMA_VERSION) {
      throw new TypeError(`knowledge-local: SQLite schema version must be ${KNOWLEDGE_SQLITE_SCHEMA_VERSION}`)
    }
    const metadata = new Map(
      database.prepare('SELECT key, value FROM metadata').all().map((value) => {
        const row = value as Record<string, unknown>
        return [string(row['key'], 'metadata key'), string(row['value'], 'metadata value')] as const
      }),
    )
    if (
      metadata.size !== 4
      || metadata.get('schema_version') !== String(KNOWLEDGE_SQLITE_SCHEMA_VERSION)
      || metadata.get('analyzer') !== analyzer
      || metadata.get('document_count') !== String(documentCount)
      || metadata.get('chunk_count') !== String(chunkCount)
    ) {
      throw new TypeError('knowledge-local: SQLite metadata does not match the manifest')
    }
    const counts = database.prepare(`
      SELECT
        COUNT(*) AS chunk_count,
        COALESCE(MIN(ordinal), 0) AS minimum_ordinal,
        COALESCE(MAX(ordinal), -1) AS maximum_ordinal
      FROM chunks
    `).get() as Record<string, unknown>
    const documentRows = database.prepare(`
      SELECT
        document_id, source_version, valid_from, valid_from_ms,
        valid_until, valid_until_ms, supersedes_document_id
      FROM documents
      ORDER BY document_id COLLATE BINARY
    `).all()
    for (const value of documentRows) {
      const row = value as Record<string, unknown>
      const documentId = string(row['document_id'], 'document id')
      const sourceVersion = optionalString(row['source_version'], 'document source version')
      if (sourceVersion !== undefined && sourceVersion.trim().length === 0) {
        throw new TypeError('knowledge-local: SQLite document source version must be non-empty')
      }
      const validFrom = optionalString(row['valid_from'], 'document valid-from')
      const validFromMs = optionalInteger(row['valid_from_ms'], 'document valid-from milliseconds')
      const validUntil = optionalString(row['valid_until'], 'document valid-until')
      const validUntilMs = optionalInteger(row['valid_until_ms'], 'document valid-until milliseconds')
      if ((validFrom === undefined) !== (validFromMs === undefined) || (validUntil === undefined) !== (validUntilMs === undefined)) {
        throw new TypeError('knowledge-local: SQLite document validity fields are incomplete')
      }
      if (validFrom !== undefined) {
        const parsed = parseRfc3339Instant(validFrom, 'SQLite document valid-from')
        if (parsed.epochMs !== validFromMs || parsed.text !== validFrom) {
          throw new TypeError('knowledge-local: SQLite document valid-from fields disagree')
        }
      }
      if (validUntil !== undefined) {
        const parsed = parseRfc3339Instant(validUntil, 'SQLite document valid-until')
        if (parsed.epochMs !== validUntilMs || parsed.text !== validUntil) {
          throw new TypeError('knowledge-local: SQLite document valid-until fields disagree')
        }
      }
      if (validFromMs !== undefined && validUntilMs !== undefined && validFromMs >= validUntilMs) {
        throw new TypeError('knowledge-local: SQLite document validity range is invalid')
      }
      const supersedes = optionalString(row['supersedes_document_id'], 'superseded document id')
      if (supersedes !== undefined && supersedes.length === 0) {
        throw new TypeError('knowledge-local: SQLite superseded document id must be non-empty')
      }
      if (supersedes === documentId) throw new TypeError('knowledge-local: SQLite document cannot supersede itself')
    }
    const ftsCount = database.prepare('SELECT COUNT(*) AS count FROM bm25_fts').get() as Record<string, unknown>
    const documentsWithoutChunks = database.prepare(`
      SELECT COUNT(*) AS count
      FROM documents AS d
      LEFT JOIN chunks AS c ON c.document_id = d.document_id
      WHERE c.document_id IS NULL
    `).get() as Record<string, unknown>
    const foreignKeyViolation = database.prepare('PRAGMA foreign_key_check').get()
    const minimumOrdinal = safeInteger(counts['minimum_ordinal'], 'minimum ordinal')
    const maximumOrdinal = safeInteger(counts['maximum_ordinal'], 'maximum ordinal')
    if (
      integer(counts['chunk_count'], 'chunk count') !== chunkCount
      || documentRows.length !== documentCount
      || minimumOrdinal !== 0
      || maximumOrdinal !== chunkCount - 1
      || integer(ftsCount['count'], 'FTS row count') !== chunkCount
      || integer(documentsWithoutChunks['count'], 'documents without chunks') !== 0
      || foreignKeyViolation !== undefined
    ) {
      throw new TypeError('knowledge-local: SQLite document or chunk counts disagree with the manifest')
    }
    return new KnowledgeSqliteIndex(database, analyzer)
  } catch (error) {
    database.close()
    throw error
  }
}
