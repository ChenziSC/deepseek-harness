/** Derive cached chunks and write the searchable SQLite payload. */

import { performance } from 'node:perf_hooks'
import type { DatabaseSync } from 'node:sqlite'
import { analyzeBm25, type KnowledgeBm25Analyzer } from '../bm25.ts'
import { chunkDocuments, DEFAULT_CHUNKING_STRATEGY, type ChunkingOptions } from '../chunker.ts'
import type { CorpusDocument } from '../corpus.ts'
import {
  BM25_PREPROCESS_IMPLEMENTATION_VERSION,
  DOCUMENT_DERIVATION_IMPLEMENTATION_VERSION,
  DocumentDerivationCache,
  documentDerivationCacheKey,
  type DerivedDocument,
  type DocumentDerivationCacheConfig,
} from '../document-derivation-cache.ts'
import type { BuildBm25IndexOptions, KnowledgeIndexBuildStats } from './types.ts'
import { retrievalText } from '../retrieval-text.ts'
import {
  KnowledgeSqliteWriter,
  type PreparedChunkRecord,
} from '../sqlite-writer.ts'
import type { ChunkTokenizer } from '../tokenizer.ts'
import type { StagedCorpus } from './stage.ts'

interface SourceDocumentRow {
  readonly id: string
  readonly title: string | null
  readonly source: string | null
  readonly source_version: string | null
  readonly valid_from: string | null
  readonly valid_from_ms: number | null
  readonly valid_until: string | null
  readonly valid_until_ms: number | null
  readonly supersedes: string | null
  readonly text: string
}

interface MutableKnowledgeIndexBuildStats {
  cacheQueryCount: number
  cacheHitDocumentCount: number
  recomputedDocumentCount: number
  reusedChunkCount: number
  newChunkCount: number
  timingsMs: {
    derivedCacheLookup: number
    chunking: number
    bm25Preprocess: number
    derivedCacheWrite: number
    sqliteWrite: number
  }
}

/** Completed chunk payload and its document-level reuse measurements. */
export interface ChunkPayloadResult {
  readonly chunkCount: number
  readonly stats: KnowledgeIndexBuildStats
}

function sourceDocument(row: unknown): CorpusDocument {
  const value = row as SourceDocumentRow
  return {
    id: value.id as CorpusDocument['id'],
    text: value.text,
    ...(value.title === null ? {} : { title: value.title }),
    ...(value.source === null ? {} : { source: value.source }),
    ...(value.source_version === null ? {} : { sourceVersion: value.source_version }),
    ...(value.valid_from === null ? {} : { validFrom: value.valid_from, validFromMs: value.valid_from_ms as number }),
    ...(value.valid_until === null ? {} : { validUntil: value.valid_until, validUntilMs: value.valid_until_ms as number }),
    ...(value.supersedes === null ? {} : { supersedes: value.supersedes as CorpusDocument['id'] }),
  }
}

function derivedDocument(
  document: CorpusDocument,
  tokenizer: ChunkTokenizer,
  chunking: ChunkingOptions,
  analyzer: KnowledgeBm25Analyzer,
  stats: MutableKnowledgeIndexBuildStats,
): DerivedDocument {
  const chunkingStartedAt = performance.now()
  const chunks = chunkDocuments([document], tokenizer, chunking)
  stats.timingsMs.chunking += performance.now() - chunkingStartedAt
  const bm25StartedAt = performance.now()
  const derived = chunks.map((chunk) => {
    const denseText = retrievalText(document.title, chunk.sectionPath, chunk.text)
    return {
      id: chunk.id,
      ...(chunk.sectionPath === undefined ? {} : { sectionPath: chunk.sectionPath }),
      text: chunk.text,
      startToken: chunk.startToken,
      endToken: chunk.endToken,
      denseText,
      bm25Text: analyzeBm25(analyzer, denseText).join(' '),
    }
  })
  stats.timingsMs.bm25Preprocess += performance.now() - bm25StartedAt
  return {
    documentId: document.id,
    ...(document.title === undefined ? {} : { title: document.title }),
    chunks: derived,
  }
}

function writeDocumentBatch(
  documents: readonly CorpusDocument[],
  writer: KnowledgeSqliteWriter,
  tokenizer: ChunkTokenizer,
  chunking: ChunkingOptions,
  analyzer: KnowledgeBm25Analyzer,
  batchSize: number,
  cache: DocumentDerivationCache | undefined,
  cacheConfig: DocumentDerivationCacheConfig,
  firstOrdinal: number,
  stats: MutableKnowledgeIndexBuildStats,
): number {
  const keys = cache === undefined
    ? []
    : documents.map(document => documentDerivationCacheKey(cacheConfig, document))
  const lookupStartedAt = performance.now()
  const hits: Map<string, DerivedDocument> = cache?.getMany(
    documents.map((document, index) => ({ key: keys[index] as string, document })),
  ) ?? new Map<string, DerivedDocument>()
  stats.timingsMs.derivedCacheLookup += cache === undefined ? 0 : performance.now() - lookupStartedAt
  stats.cacheQueryCount += cache === undefined ? 0 : documents.length
  const derived: DerivedDocument[] = []
  const cacheEntries: Array<{ key: string; document: DerivedDocument }> = []
  for (const [index, document] of documents.entries()) {
    const key = keys[index]
    const hit = key === undefined ? undefined : hits.get(key)
    if (hit !== undefined) {
      stats.cacheHitDocumentCount += 1
      stats.reusedChunkCount += hit.chunks.length
      derived.push(hit)
      continue
    }
    const value = derivedDocument(document, tokenizer, chunking, analyzer, stats)
    stats.recomputedDocumentCount += 1
    stats.newChunkCount += value.chunks.length
    derived.push(value)
    if (key !== undefined) cacheEntries.push({ key, document: value })
  }
  if (cacheEntries.length > 0) {
    const writeStartedAt = performance.now()
    cache?.putMany(cacheEntries)
    stats.timingsMs.derivedCacheWrite += performance.now() - writeStartedAt
  }
  const sqliteStartedAt = performance.now()
  writer.insertDocuments(documents)
  const prepared: PreparedChunkRecord[] = []
  let ordinal = firstOrdinal
  for (const [index, value] of derived.entries()) {
    const document = documents[index] as CorpusDocument
    for (const chunk of value.chunks) {
      prepared.push({
        chunk: {
          ordinal,
          id: chunk.id,
          documentId: document.id,
          ...(document.title === undefined ? {} : { title: document.title }),
          ...(chunk.sectionPath === undefined ? {} : { sectionPath: chunk.sectionPath }),
          text: chunk.text,
          ...(document.source === undefined ? {} : { source: document.source }),
          startToken: chunk.startToken,
          endToken: chunk.endToken,
        },
        bm25Text: chunk.bm25Text,
      })
      ordinal += 1
      if (prepared.length === batchSize) {
        writer.insertPrepared(prepared)
        prepared.length = 0
      }
    }
  }
  if (prepared.length > 0) writer.insertPrepared(prepared)
  stats.timingsMs.sqliteWrite += performance.now() - sqliteStartedAt
  return ordinal
}

function writeChunks(
  sourceDatabase: DatabaseSync,
  writer: KnowledgeSqliteWriter,
  tokenizer: ChunkTokenizer,
  chunking: ChunkingOptions,
  analyzer: KnowledgeBm25Analyzer,
  batchSize: number,
  cache: DocumentDerivationCache | undefined,
  cacheConfig: DocumentDerivationCacheConfig,
): { readonly chunkCount: number; readonly stats: MutableKnowledgeIndexBuildStats } {
  const select = sourceDatabase.prepare(`
    SELECT
      id, title, source, source_version, valid_from, valid_from_ms,
      valid_until, valid_until_ms, supersedes, text
    FROM source_documents
    ORDER BY id COLLATE BINARY
  `)
  const documentBatch: CorpusDocument[] = []
  const stats: MutableKnowledgeIndexBuildStats = {
    cacheQueryCount: 0,
    cacheHitDocumentCount: 0,
    recomputedDocumentCount: 0,
    reusedChunkCount: 0,
    newChunkCount: 0,
    timingsMs: {
      derivedCacheLookup: 0,
      chunking: 0,
      bm25Preprocess: 0,
      derivedCacheWrite: 0,
      sqliteWrite: 0,
    },
  }
  let ordinal = 0
  for (const row of select.iterate()) {
    documentBatch.push(sourceDocument(row))
    if (documentBatch.length === batchSize) {
      ordinal = writeDocumentBatch(
        documentBatch, writer, tokenizer, chunking, analyzer, batchSize, cache, cacheConfig, ordinal, stats,
      )
      documentBatch.length = 0
    }
  }
  if (documentBatch.length > 0) {
    ordinal = writeDocumentBatch(
      documentBatch, writer, tokenizer, chunking, analyzer, batchSize, cache, cacheConfig, ordinal, stats,
    )
  }
  return { chunkCount: ordinal, stats }
}

function documentCacheConfig(
  options: BuildBm25IndexOptions,
  analyzer: KnowledgeBm25Analyzer,
  tokenizerModelId: string,
  tokenizerRevision: string,
): DocumentDerivationCacheConfig {
  return {
    tokenizerModelId,
    tokenizerRevision,
    chunkingStrategy: options.chunking.strategy ?? DEFAULT_CHUNKING_STRATEGY,
    maxTokens: options.chunking.maxTokens,
    overlapTokens: options.chunking.overlapTokens,
    analyzer,
    bm25ImplementationVersion: BM25_PREPROCESS_IMPLEMENTATION_VERSION,
    implementationVersion: DOCUMENT_DERIVATION_IMPLEMENTATION_VERSION,
  }
}

/**
 * Write documents and derived chunks, then finalize the target SQLite payload.
 * @param options - source chunking and optional derivation-cache settings.
 * @param staged - open temporary source database.
 * @param writer - target index writer owned by the caller.
 * @param analyzer - recorded BM25 analyzer.
 * @param sqliteBatchSize - bounded document and chunk write batch.
 * @param corpusStagingMs - elapsed source staging time included in statistics.
 * @param tokenizerModelId - exact tokenizer identity recorded in cache keys.
 * @param tokenizerRevision - exact tokenizer revision recorded in cache keys.
 * @returns completed chunk count and build statistics.
 */
export async function writeChunkPayload(
  options: BuildBm25IndexOptions,
  staged: StagedCorpus,
  writer: KnowledgeSqliteWriter,
  analyzer: KnowledgeBm25Analyzer,
  sqliteBatchSize: number,
  corpusStagingMs: number,
  tokenizerModelId: string,
  tokenizerRevision: string,
): Promise<ChunkPayloadResult> {
  const derivationConfig = documentCacheConfig(options, analyzer, tokenizerModelId, tokenizerRevision)
  const documentCache = options.derivedCacheDir === undefined
    ? undefined
    : await DocumentDerivationCache.open(options.derivedCacheDir, derivationConfig)
  try {
    const chunkResult = writeChunks(
      staged.database,
      writer,
      options.tokenizer,
      options.chunking,
      analyzer,
      sqliteBatchSize,
      documentCache,
      derivationConfig,
    )
    const finalizeStartedAt = performance.now()
    writer.finalize(staged.documentCount, chunkResult.chunkCount)
    const sqliteFinalizeMs = performance.now() - finalizeStartedAt
    return {
      chunkCount: chunkResult.chunkCount,
      stats: {
        cacheEnabled: documentCache !== undefined,
        cacheQueryCount: chunkResult.stats.cacheQueryCount,
        cacheHitDocumentCount: chunkResult.stats.cacheHitDocumentCount,
        recomputedDocumentCount: chunkResult.stats.recomputedDocumentCount,
        reusedChunkCount: chunkResult.stats.reusedChunkCount,
        newChunkCount: chunkResult.stats.newChunkCount,
        timingsMs: {
          corpusStaging: corpusStagingMs,
          ...chunkResult.stats.timingsMs,
          sqliteFinalize: sqliteFinalizeMs,
        },
      },
    }
  } finally {
    documentCache?.close()
  }
}
