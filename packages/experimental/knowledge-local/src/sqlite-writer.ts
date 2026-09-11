/** SQLite writer used only while an immutable knowledge index is constructed. */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { analyzeBm25, type KnowledgeBm25Analyzer } from './bm25.ts'
import type { ChunkRecord } from './chunker.ts'
import type { CorpusDocument } from './corpus.ts'
import { retrievalText } from './retrieval-text.ts'
import { KNOWLEDGE_SQLITE_SCHEMA_VERSION } from './sqlite-index.ts'
import { denseInputFromRow, type DenseInputRow } from './sqlite-rows.ts'
import { inImmediateTransaction } from './storage/cache-primitives.ts'

/** One chunk paired with BM25 text already analyzed by the configured revision. */
export interface PreparedChunkRecord {
  readonly chunk: ChunkRecord
  readonly bm25Text: string
}

/** Batched writer used only while an index is being constructed. */
export class KnowledgeSqliteWriter {
  private readonly database: DatabaseSync
  private readonly insertDocument: StatementSync
  private readonly insertChunk: StatementSync
  private readonly insertFts: StatementSync
  private closed = false

  constructor(path: string, private readonly analyzer: KnowledgeBm25Analyzer) {
    const database = new DatabaseSync(path)
    try {
      database.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA user_version = ${KNOWLEDGE_SQLITE_SCHEMA_VERSION};
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE documents (
          document_id TEXT PRIMARY KEY,
          title TEXT,
          source TEXT,
          source_version TEXT,
          valid_from TEXT,
          valid_from_ms INTEGER,
          valid_until TEXT,
          valid_until_ms INTEGER,
          supersedes_document_id TEXT,
          CHECK (length(document_id) > 0),
          CHECK (source_version IS NULL OR length(source_version) > 0),
          CHECK ((valid_from IS NULL) = (valid_from_ms IS NULL)),
          CHECK ((valid_until IS NULL) = (valid_until_ms IS NULL)),
          CHECK (valid_from_ms IS NULL OR valid_until_ms IS NULL OR valid_from_ms < valid_until_ms),
          CHECK (supersedes_document_id IS NULL OR length(supersedes_document_id) > 0),
          CHECK (supersedes_document_id IS NULL OR supersedes_document_id <> document_id)
        ) STRICT;
        CREATE TABLE chunks (
          ordinal INTEGER PRIMARY KEY,
          chunk_id TEXT NOT NULL UNIQUE,
          document_id TEXT NOT NULL REFERENCES documents(document_id),
          section_path TEXT,
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
      this.insertDocument = database.prepare(`
        INSERT INTO documents(
          document_id, title, source, source_version, valid_from, valid_from_ms,
          valid_until, valid_until_ms, supersedes_document_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.insertChunk = database.prepare(`
        INSERT INTO chunks(
          ordinal, chunk_id, document_id, section_path, text, start_token, end_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      this.insertFts = database.prepare('INSERT INTO bm25_fts(rowid, analyzed) VALUES (?, ?)')
    } catch (error) {
      database.close()
      throw error
    }
    this.database = database
  }

  /**
   * Insert one bounded source-document batch atomically.
   * @param documents - validated documents referenced by subsequent chunk batches.
   */
  insertDocuments(documents: readonly CorpusDocument[]): void {
    inImmediateTransaction(this.database, () => {
      for (const document of documents) {
        this.insertDocument.run(
          document.id,
          document.title ?? null,
          document.source ?? null,
          document.sourceVersion ?? null,
          document.validFrom ?? null,
          document.validFromMs ?? null,
          document.validUntil ?? null,
          document.validUntilMs ?? null,
          document.supersedes ?? null,
        )
      }
    })
  }

  /**
   * Insert one bounded batch atomically.
   * @param chunks - consecutive ordinal-aligned chunks.
   */
  insert(chunks: readonly ChunkRecord[]): void {
    this.insertPrepared(chunks.map(chunk => ({
      chunk,
      bm25Text: analyzeBm25(this.analyzer, retrievalText(chunk.title, chunk.sectionPath, chunk.text)).join(' '),
    })))
  }

  /**
   * Insert chunks whose BM25 preprocessing has already completed.
   * @param entries - consecutive ordinal-aligned chunks and exact FTS text.
   */
  insertPrepared(entries: readonly PreparedChunkRecord[]): void {
    inImmediateTransaction(this.database, () => {
      for (const { chunk, bm25Text } of entries) {
        this.insertChunk.run(
          chunk.ordinal,
          chunk.id,
          chunk.documentId,
          chunk.sectionPath ?? null,
          chunk.text,
          chunk.startToken,
          chunk.endToken,
        )
        this.insertFts.run(chunk.ordinal, bm25Text)
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
    inImmediateTransaction(this.database, () => {
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
      SELECT c.ordinal, c.chunk_id, c.document_id, d.title, c.section_path, c.text
      FROM chunks AS c
      JOIN documents AS d ON d.document_id = c.document_id
      WHERE c.ordinal > ?
      ORDER BY c.ordinal
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
