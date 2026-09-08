/** Deterministic Markdown-structure, paragraph, sentence, and tokenizer-length chunking. */

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
  readonly sectionPath?: string
  readonly text: string
  readonly source?: string
  readonly startToken: number
  readonly endToken: number
}

/** Token limits controlling deterministic chunk production. */
export interface ChunkingOptions {
  readonly maxTokens: number
  readonly overlapTokens: number
  /** Boundary selection used after the tokenizer establishes the hard limit. */
  readonly strategy?: ChunkingStrategy
}

/** Supported deterministic chunk-boundary strategies. */
export type ChunkingStrategy = 'token-window-v1' | 'markdown-structure-v1'

/** Default structure-aware chunking strategy. */
export const DEFAULT_CHUNKING_STRATEGY: ChunkingStrategy = 'markdown-structure-v1'

function codePointBoundaries(text: string, start: number, end: number): number[] {
  const boundaries = [start]
  for (let index = start; index < end;) {
    index += (text.codePointAt(index) as number) > 0xffff ? 2 : 1
    boundaries.push(index)
  }
  return boundaries
}

function boundaryIndex(boundaries: readonly number[], offset: number): number {
  let low = 0
  let high = boundaries.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = boundaries[middle] as number
    if (candidate === offset) return middle
    if (candidate < offset) low = middle + 1
    else high = middle - 1
  }
  /* v8 ignore next -- every caller supplies offsets produced from this boundary array. */
  throw new TypeError('knowledge-local: chunk boundary is not a Unicode code-point boundary')
}

function fitEnd(
  text: string,
  start: number,
  startBoundary: number,
  boundaries: readonly number[],
  maxTokens: number,
  tokenizer: ChunkTokenizer,
): number {
  const finalBoundary = boundaries.length - 1
  let low = startBoundary + 1
  let high = Math.min(finalBoundary, startBoundary + maxTokens)
  let best = boundaries[low] as number
  // Grow a local window before binary search so tokenizer work stays proportional to one chunk.
  if (tokenizer.countTokens(text.slice(start, boundaries[high])) <= maxTokens) {
    best = boundaries[high] as number
    while (high < finalBoundary) {
      const width = high - startBoundary
      const candidate = Math.min(finalBoundary, startBoundary + width * 2)
      if (tokenizer.countTokens(text.slice(start, boundaries[candidate])) > maxTokens) {
        low = high + 1
        high = candidate - 1
        break
      }
      best = boundaries[candidate] as number
      high = candidate
    }
    if (high === finalBoundary) return best
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = boundaries[middle] as number
    if (tokenizer.countTokens(text.slice(start, candidate)) <= maxTokens) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

function overlapStart(
  text: string,
  startBoundary: number,
  endBoundary: number,
  boundaries: readonly number[],
  overlapTokens: number,
  tokenizer: ChunkTokenizer,
): number {
  const end = boundaries[endBoundary] as number
  if (overlapTokens === 0) return end
  let low = startBoundary
  let high = endBoundary
  let best = end
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = boundaries[middle] as number
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

interface MarkdownStructure {
  readonly sectionEnds: readonly number[]
  readonly fenceRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>
  readonly headingPaths: ReadonlyArray<{ readonly offset: number; readonly path: string }>
}

function markdownStructure(text: string): MarkdownStructure {
  const sectionEnds: number[] = []
  const fenceRanges: Array<{ start: number; end: number }> = []
  const headingPaths: Array<{ offset: number; path: string }> = []
  const headings: string[] = []
  let fence: { marker: '`' | '~'; length: number; start: number } | undefined
  let offset = 0
  for (const line of text.matchAll(/.*(?:\n|$)/gu)) {
    const raw = line[0]
    if (raw.length === 0) break
    const content = raw.replace(/\r?\n$/u, '')
    const fenceMatch = /^[\t ]{0,3}(`{3,}|~{3,})/u.exec(content)
    if (fence !== undefined) {
      if (
        fenceMatch !== null
        && fenceMatch[1]?.[0] === fence.marker
        && fenceMatch[1].length >= fence.length
      ) {
        fenceRanges.push({ start: fence.start, end: offset + raw.length })
        fence = undefined
      }
      offset += raw.length
      continue
    }
    if (fenceMatch !== null) {
      fence = {
        marker: fenceMatch[1]?.[0] as '`' | '~',
        length: fenceMatch[1]?.length as number,
        start: offset,
      }
      offset += raw.length
      continue
    }
    const heading = /^[\t ]{0,3}(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/u.exec(content)
    if (heading !== null) {
      if (offset > 0) sectionEnds.push(offset)
      const level = heading[1]?.length as number
      headings.length = level - 1
      headings[level - 1] = heading[2] as string
      headingPaths.push({ offset, path: headings.filter(Boolean).join(' > ') })
    }
    offset += raw.length
  }
  if (fence !== undefined) fenceRanges.push({ start: fence.start, end: text.length })
  return { sectionEnds, fenceRanges, headingPaths }
}

function inFence(offset: number, ranges: MarkdownStructure['fenceRanges']): boolean {
  return ranges.some(range => offset > range.start && offset < range.end)
}

function sectionPathAt(offset: number, headings: MarkdownStructure['headingPaths']): string | undefined {
  let path: string | undefined
  for (const heading of headings) {
    if (heading.offset > offset) break
    path = heading.path
  }
  return path
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
  const boundaries = codePointBoundaries(document.text, 0, document.text.length)
  const strategy = options.strategy ?? DEFAULT_CHUNKING_STRATEGY
  const structure = strategy === 'markdown-structure-v1'
    ? markdownStructure(document.text)
    : { sectionEnds: [], fenceRanges: [], headingPaths: [] }
  const paragraphEnds = strategy === 'markdown-structure-v1'
    ? boundaryEnds(document.text, /\n[\t ]*\n+/gu)
      .map(end => skipWhitespaceBackward(document.text, 0, end))
      .filter(end => !inFence(end, structure.fenceRanges))
    : []
  const sentenceEnds = strategy === 'markdown-structure-v1'
    ? boundaryEnds(document.text, /[.!?。！？](?=\s|$)/gu)
      .filter(end => !inFence(end, structure.fenceRanges))
    : []
  const records: Omit<ChunkRecord, 'ordinal'>[] = []
  let start = skipWhitespaceForward(document.text, 0)
  let startBoundary = boundaryIndex(boundaries, start)
  let startToken = 0
  let previousEnd = start
  while (start < document.text.length) {
    const hardEnd = fitEnd(document.text, start, startBoundary, boundaries, options.maxTokens, tokenizer)
    const minimumBoundary = Math.max(previousEnd, start)
    const enclosingFence = structure.fenceRanges.find(range => start >= range.start && start < range.end)
    const enteringFence = structure.fenceRanges.find(range => range.start > start && range.start < hardEnd && range.end > hardEnd)
    const chosen = strategy === 'token-window-v1'
      ? hardEnd
      : enclosingFence !== undefined && enclosingFence.end <= hardEnd
        ? enclosingFence.end
        : preferredEnd(structure.sectionEnds, minimumBoundary, hardEnd)
          ?? enteringFence?.start
          ?? preferredEnd(paragraphEnds, minimumBoundary, hardEnd)
        ?? preferredEnd(sentenceEnds, minimumBoundary, hardEnd)
        ?? hardEnd
    const end = skipWhitespaceBackward(document.text, start, chosen)
    /* v8 ignore next -- validated non-whitespace starts and code-point boundaries make this an internal invariant. */
    if (end <= start) throw new TypeError('knowledge-local: tokenizer could not produce a non-empty chunk')
    // Transformers.js exposes token counts but not source offsets, so positions accumulate from bounded local slices.
    const endToken = startToken + Math.max(1, tokenizer.countTokens(document.text.slice(start, end)))
    const sectionPath = sectionPathAt(start, structure.headingPaths)
    records.push({
      id: KnowledgeChunkId(`${encodeURIComponent(document.id)}:${startToken}-${endToken}`),
      documentId: document.id,
      ...(document.title === undefined ? {} : { title: document.title }),
      ...(sectionPath === undefined ? {} : { sectionPath }),
      text: document.text.slice(start, end),
      ...(document.source === undefined ? {} : { source: document.source }),
      startToken,
      endToken,
    })
    if (end >= document.text.length) break
    let nextStart = overlapStart(
      document.text,
      startBoundary,
      boundaryIndex(boundaries, end),
      boundaries,
      options.overlapTokens,
      tokenizer,
    )
    nextStart = skipWhitespaceForward(document.text, nextStart)
    if (nextStart <= start) nextStart = skipWhitespaceForward(document.text, end)
    const overlapTokenCount = tokenizer.countTokens(document.text.slice(nextStart, end))
    previousEnd = end
    start = nextStart
    startBoundary = boundaryIndex(boundaries, start)
    startToken = Math.max(startToken + 1, endToken - overlapTokenCount)
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
      || left.startToken - right.startToken)
    .map((record, ordinal) => ({ ordinal, ...record }))
}
