/** Shared validation for ordinal-aligned Dense inputs read from SQLite. */

import { retrievalText } from './retrieval-text.ts'

/** One ordinal-aligned text input read back for Dense encoding. */
export interface DenseInputRow {
  readonly ordinal: number
  readonly chunkId: string
  readonly documentId: string
  readonly text: string
}

/** Validate and project one Dense input query row. */
export function denseInputFromRow(value: unknown): DenseInputRow {
  const row = value as Record<string, unknown>
  const ordinal = row['ordinal']
  const chunkId = row['chunk_id']
  const documentId = row['document_id']
  const text = row['text']
  const title = row['title']
  const sectionPath = row['section_path']
  if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new TypeError('knowledge-local: SQLite chunk ordinal must be a non-negative safe integer')
  }
  if (typeof chunkId !== 'string' || chunkId.length === 0) {
    throw new TypeError('knowledge-local: SQLite chunk id must be a non-empty string')
  }
  if (typeof documentId !== 'string' || documentId.length === 0) {
    throw new TypeError('knowledge-local: SQLite document id must be a non-empty string')
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('knowledge-local: SQLite chunk text must be a non-empty string')
  }
  if (title !== null && typeof title !== 'string') {
    throw new TypeError('knowledge-local: SQLite chunk title must be text or null')
  }
  if (sectionPath !== null && typeof sectionPath !== 'string') {
    throw new TypeError('knowledge-local: SQLite chunk section path must be text or null')
  }
  return {
    ordinal,
    chunkId,
    documentId,
    text: retrievalText(title ?? undefined, sectionPath ?? undefined, text),
  }
}
