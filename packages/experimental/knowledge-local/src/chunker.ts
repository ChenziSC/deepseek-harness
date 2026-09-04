/** Deterministic paragraph, sentence, and tokenizer-length chunking. */

import {
  KnowledgeChunkId,
  type KnowledgeChunkId as KnowledgeChunkIdType,
  type KnowledgeDocumentId,
} from '@deepseek-ai/dsh-experimental-knowledge'
import { compareCodePoints } from './bm25.ts'
import type { CorpusDocument } from './corpus.ts'
import type { ChunkTokenizer } from './tokenizer.ts'

/** One immutable chunk before retrieval scores are attached. */
export interface ChunkRecord {
  readonly ordinal: number
  readonly id: KnowledgeChunkIdType
  readonly documentId: KnowledgeDocumentId
  readonly title?: string
  readonly text: string
  readonly source?: string
  readonly startToken: number
  readonly endToken: number
}

/** Token limits controlling deterministic chunk production. */
export interface ChunkingOptions {
  readonly maxTokens: number
  readonly overlapTokens: number
}

function codePointBoundaries(text: string, start: number, end: number): number[] {
  const boundaries = [start]
  for (let index = start; index < end;) {
    const point = text.codePointAt(index)
    index += point !== undefined && point > 0xffff ? 2 : 1
    boundaries.push(index)
  }
  return boundaries
}

function fitEnd(text: string, start: number, maxTokens: number, tokenizer: ChunkTokenizer): number {
  const boundaries = codePointBoundaries(text, start, text.length)
  let low = 1
  let high = boundaries.length - 1
  let best = boundaries[1] ?? text.length
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = boundaries[middle] ?? text.length
    if (tokenizer.countTokens(text.slice(start, candidate)) <= maxTokens) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

function overlapStart(text: string, start: number, end: number, overlapTokens: number, tokenizer: ChunkTokenizer): number {
  if (overlapTokens === 0) return end
  const boundaries = codePointBoundaries(text, start, end)
  let low = 0
  let high = boundaries.length - 1
  let best = end
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = boundaries[middle] ?? end
    if (tokenizer.countTokens(text.slice(candidate, end)) <= overlapTokens) {
      best = candidate
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  return best
}

function boundaryEnds(text: string, pattern: RegExp): number[] {
  const ends: number[] = []
  for (const match of text.matchAll(pattern)) ends.push(match.index + match[0].length)
  return ends
}

function preferredEnd(candidates: readonly number[], minimum: number, maximum: number): number | undefined {
  let selected: number | undefined
  for (const candidate of candidates) {
    if (candidate > minimum && candidate <= maximum) selected = candidate
    if (candidate > maximum) break
  }
  return selected
}

function skipWhitespaceForward(text: string, offset: number): number {
  let current = offset
  while (current < text.length) {
    const match = /^\s/u.exec(text.slice(current))
    if (match === null) break
    current += match[0].length
  }
  return current
}

function skipWhitespaceBackward(text: string, start: number, end: number): number {
  let current = end
  while (current > start) {
    const previous = Array.from(text.slice(start, current)).at(-1)
    if (previous === undefined || !/^\s$/u.test(previous)) break
    current -= previous.length
  }
  return current
}

function chunkDocument(document: CorpusDocument, tokenizer: ChunkTokenizer, options: ChunkingOptions): Omit<ChunkRecord, 'ordinal'>[] {
  const paragraphEnds = boundaryEnds(document.text, /\n[\t ]*\n+/gu).map(end => skipWhitespaceBackward(document.text, 0, end))
  const sentenceEnds = boundaryEnds(document.text, /[.!?。！？](?=\s|$)/gu)
  const records: Omit<ChunkRecord, 'ordinal'>[] = []
  let start = skipWhitespaceForward(document.text, 0)
  let previousEnd = start
  while (start < document.text.length) {
    const hardEnd = fitEnd(document.text, start, options.maxTokens, tokenizer)
    const chosen = preferredEnd(paragraphEnds, previousEnd, hardEnd)
      ?? preferredEnd(sentenceEnds, previousEnd, hardEnd)
      ?? hardEnd
    const end = skipWhitespaceBackward(document.text, start, chosen)
    if (end <= start) throw new TypeError('knowledge-local: tokenizer could not produce a non-empty chunk')
    const startToken = tokenizer.countTokens(document.text.slice(0, start))
    const endToken = tokenizer.countTokens(document.text.slice(0, end))
    records.push({
      id: KnowledgeChunkId(`${encodeURIComponent(document.id)}:${startToken}-${endToken}`),
      documentId: document.id,
      ...(document.title === undefined ? {} : { title: document.title }),
      text: document.text.slice(start, end),
      ...(document.source === undefined ? {} : { source: document.source }),
      startToken,
      endToken,
    })
    if (end >= document.text.length) break
    let nextStart = overlapStart(document.text, start, end, options.overlapTokens, tokenizer)
    nextStart = skipWhitespaceForward(document.text, nextStart)
    if (nextStart <= start) nextStart = skipWhitespaceForward(document.text, end)
    previousEnd = end
    start = nextStart
  }
  return records
}

/**
 * Split validated documents and assign stable global ordinals.
 * @param documents - validated source documents.
 * @param tokenizer - tokenizer used for limits and overlap.
 * @param options - chunk and overlap token limits.
 * @returns chunks ordered by document id and token range.
 */
export function chunkDocuments(
  documents: readonly CorpusDocument[],
  tokenizer: ChunkTokenizer,
  options: ChunkingOptions,
): ChunkRecord[] {
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) {
    throw new TypeError('knowledge-local: maxTokens must be a positive safe integer')
  }
  if (!Number.isSafeInteger(options.overlapTokens) || options.overlapTokens < 0 || options.overlapTokens >= options.maxTokens) {
    throw new TypeError('knowledge-local: overlapTokens must be a non-negative safe integer below maxTokens')
  }
  const ordered = [...documents].sort((left, right) => compareCodePoints(left.id, right.id))
  return ordered
    .flatMap(document => chunkDocument(document, tokenizer, options))
    .sort((left, right) => compareCodePoints(left.documentId, right.documentId)
      || left.startToken - right.startToken
      || left.endToken - right.endToken)
    .map((record, ordinal) => ({ ordinal, ...record }))
}
