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
import type { ChunkRecord } from './chunker.ts'

/** Fixed SQLite payload name in index format version 3. */
export const KNOWLEDGE_SQLITE_FILE = 'knowledge.sqlite'
/** Monotonic schema version stored in SQLite `user_version`. */
export const KNOWLEDGE_SQLITE_SCHEMA_VERSION = 2

interface ChunkRow {
  readonly ordinal: unknown
  readonly chunk_id: unknown
  readonly document_id: unknown
  readonly title: unknown
  readonly section_path: unknown
  readonly source: unknown
  readonly text: unknown
  readonly start_token: unknown
  readonly end_token: unknown
}

/** One ordinal-aligned text input read back for Dense encoding. */
export interface DenseInputRow {
  readonly ordinal: number
  readonly chunkId: string
  readonly documentId: string
  readonly text: string
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
  return {
    documentId: KnowledgeDocumentId(documentId),
    chunkId: KnowledgeChunkId(chunkId),
    ...(title === undefined ? {} : { title }),
    ...(sectionPath === undefined ? {} : { sectionPath }),
    text: string(row.text, 'chunk text'),
    ...(source === undefined ? {} : { source }),
    score: 0,
  }
}

function retrievalText(title: string | undefined, sectionPath: string | undefined, text: string): string {
  return [...new Set([title, sectionPath, text].filter((value): value is string => value !== undefined))].join('\n')
}

function denseInputFromRow(value: unknown): DenseInputRow {
  const row = value as Record<string, unknown>
  const title = optionalString(row['title'], 'chunk title')
  const sectionPath = optionalString(row['section_path'], 'chunk section path')
  return {
    ordinal: integer(row['ordinal'], 'chunk ordinal'),
    chunkId: string(row['chunk_id'], 'chunk id'),
    documentId: string(row['document_id'], 'document id'),
    text: retrievalText(title, sectionPath, string(row['text'], 'chunk text')),
  }
}

function transaction(database: DatabaseSync, operation: () => void): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    operation()
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/** Batched writer used only while an index is being constructed. */
export class KnowledgeSqliteWriter {
  private readonly database: DatabaseSync
  private readonly insertChunk: StatementSync
  private readonly insertFts: StatementSync
  private closed = false

  constructor(path: string, private readonly analyzer: KnowledgeBm25Analyzer) {
    const database = new DatabaseSync(path)
    try {
      database.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;
        PRAGMA user_version = ${KNOWLEDGE_SQLITE_SCHEMA_VERSION};
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE chunks (
          ordinal INTEGER PRIMARY KEY,
          chunk_id TEXT NOT NULL UNIQUE,
          document_id TEXT NOT NULL,
          title TEXT,
          section_path TEXT,
          source TEXT,
          text TEXT NOT NULL,
          start_token INTEGER NOT NULL,
          end_token INTEGER NOT NULL,
          CHECK (length(chunk_id) > 0),
          CHECK (length(document_id) > 0),
          CHECK (length(text) > 0),
          CHECK (start_token >= 0),
          CHECK (end_token > start_token)
        ) STRICT;
        CREATE VIRTUAL TABLE bm25_fts USING fts5(
          analyzed,
          detail='column',
          tokenize='unicode61 tokenchars _'
        );
      `)
      this.insertChunk = database.prepare(`
        INSERT INTO chunks(ordinal, chunk_id, document_id, title, section_path, source, text, start_token, end_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.insertFts = database.prepare('INSERT INTO bm25_fts(rowid, analyzed) VALUES (?, ?)')
    } catch (error) {
      database.close()
      throw error
    }
    this.database = database
  }

  /**
   * Insert one bounded batch atomically.
   * @param chunks - consecutive ordinal-aligned chunks.
   */
  insert(chunks: readonly ChunkRecord[]): void {
    transaction(this.database, () => {
      for (const chunk of chunks) {
        this.insertChunk.run(
          chunk.ordinal,
          chunk.id,
          chunk.documentId,
          chunk.title ?? null,
          chunk.sectionPath ?? null,
          chunk.source ?? null,
          chunk.text,
          chunk.startToken,
          chunk.endToken,
        )
        this.insertFts.run(
          chunk.ordinal,
          analyzeBm25(this.analyzer, retrievalText(chunk.title, chunk.sectionPath, chunk.text)).join(' '),
        )
      }
    })
  }

  /**
   * Record completed counts and compact the FTS index before publication.
   * @param documentCount - number of unique source documents.
   * @param chunkCount - number of stored chunks.
   */
  finalize(documentCount: number, chunkCount: number): void {
    const insertMetadata = this.database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)')
    transaction(this.database, () => {
      insertMetadata.run('schema_version', String(KNOWLEDGE_SQLITE_SCHEMA_VERSION))
      insertMetadata.run('analyzer', this.analyzer)
      insertMetadata.run('document_count', String(documentCount))
      insertMetadata.run('chunk_count', String(chunkCount))
    })
    this.database.exec("INSERT INTO bm25_fts(bm25_fts) VALUES ('optimize')")
  }

  /**
   * Read one bounded consecutive batch for Dense encoding.
   * @param afterOrdinal - exclusive lower ordinal bound.
   * @param limit - maximum rows to return.
   * @returns title-and-text model inputs ordered by ordinal.
   */
  denseInputs(afterOrdinal: number, limit: number): DenseInputRow[] {
    return this.database.prepare(`
      SELECT ordinal, chunk_id, document_id, title, section_path, text
      FROM chunks
      WHERE ordinal > ?
      ORDER BY ordinal
      LIMIT ?
    `).all(afterOrdinal, limit).map(denseInputFromRow)
  }

  /** Close the build connection before hashing the payload. */
  close(): void {
    if (!this.closed) {
      this.closed = true
      this.database.close()
    }
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
      SELECT ordinal, chunk_id, document_id, title, section_path, source, text, start_token, end_token
      FROM chunks WHERE ordinal = ?
    `)
    this.denseInputAfterOrdinal = database.prepare(`
      SELECT ordinal, chunk_id, document_id, title, section_path, text
      FROM chunks
      WHERE ordinal > ?
      ORDER BY ordinal
      LIMIT ?
    `)
    this.bm25Search = database.prepare(`
      SELECT c.ordinal AS ordinal, -bm25(bm25_fts) AS score
      FROM bm25_fts
      JOIN chunks AS c ON c.ordinal = bm25_fts.rowid
      WHERE bm25_fts MATCH ?
      ORDER BY bm25(bm25_fts), c.chunk_id COLLATE BINARY
      LIMIT ?
    `)
  }

  /**
   * Query the fixed FTS5 BM25 implementation.
   * @param query - natural-language query analyzed with the index analyzer.
   * @param limit - maximum candidates to return.
   * @returns ranked ordinal and score pairs.
   */
  searchBm25(query: string, limit: number): Bm25Match[] {
    const tokens = [...new Set(analyzeBm25(this.analyzer, query))]
    if (tokens.length === 0) return []
    const expression = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ')
    return this.bm25Search.all(expression, limit).map((value) => {
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
      SELECT ordinal, chunk_id, document_id, title, section_path, source, text, start_token, end_token
      FROM chunks ORDER BY ordinal
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
    return this.database.prepare('SELECT DISTINCT document_id FROM chunks ORDER BY document_id COLLATE BINARY')
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
        COUNT(DISTINCT document_id) AS document_count,
        COALESCE(MIN(ordinal), 0) AS minimum_ordinal,
        COALESCE(MAX(ordinal), -1) AS maximum_ordinal
      FROM chunks
    `).get() as Record<string, unknown>
    const ftsCount = database.prepare('SELECT COUNT(*) AS count FROM bm25_fts').get() as Record<string, unknown>
    const minimumOrdinal = safeInteger(counts['minimum_ordinal'], 'minimum ordinal')
    const maximumOrdinal = safeInteger(counts['maximum_ordinal'], 'maximum ordinal')
    if (
      integer(counts['chunk_count'], 'chunk count') !== chunkCount
      || integer(counts['document_count'], 'document count') !== documentCount
      || minimumOrdinal !== 0
      || maximumOrdinal !== chunkCount - 1
      || integer(ftsCount['count'], 'FTS row count') !== chunkCount
    ) {
      throw new TypeError('knowledge-local: SQLite document or chunk counts disagree with the manifest')
    }
    return new KnowledgeSqliteIndex(database, analyzer)
  } catch (error) {
    database.close()
    throw error
  }
}
