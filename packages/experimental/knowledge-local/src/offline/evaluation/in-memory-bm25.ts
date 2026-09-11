/** Legacy in-memory BM25 scorer retained only for offline diagnostics. */

import {
  analyzeBm25,
  ENGLISH_ANALYZER,
  type Bm25Match,
  type KnowledgeBm25Analyzer,
} from '../../bm25.ts'
import { compareCodePoints } from '../../ordering.ts'

/** One posting in ordinal order: `[documentOrdinal, termFrequency]`. */
type Bm25Posting = readonly [ordinal: number, termFrequency: number]

/** One indexed term and its document postings. */
interface Bm25Term {
  readonly term: string
  readonly documentFrequency: number
  readonly postings: readonly Bm25Posting[]
}

/** Serializable BM25 payload aligned with the chunk ordinal sequence. */
export interface Bm25Index {
  readonly version: 1
  readonly analyzer?: KnowledgeBm25Analyzer
  readonly documentLengths: readonly number[]
  readonly averageDocumentLength: number
  readonly terms: readonly Bm25Term[]
}

/** One term's contribution to a BM25 candidate score. */
interface Bm25TermContribution {
  readonly term: string
  readonly termFrequency: number
  readonly documentFrequency: number
  readonly documentLength: number
  readonly score: number
}

/** One ranked candidate with local-only scoring diagnostics. */
interface Bm25DiagnosticMatch extends Bm25Match {
  readonly contributions: readonly Bm25TermContribution[]
}

/** Query analysis and candidate-level BM25 diagnostics. */
export interface Bm25Diagnostics {
  readonly queryTokens: readonly string[]
  readonly matches: readonly Bm25DiagnosticMatch[]
}

/**
 * Build a deterministic in-memory BM25 payload for offline comparisons.
 * @param documents - retrieval texts in stable chunk order.
 * @param analyzer - lexical analyzer applied to documents and later queries.
 * @returns the ordinal-aligned BM25 index.
 */
export function buildBm25Index(
  documents: readonly string[],
  analyzer: KnowledgeBm25Analyzer = ENGLISH_ANALYZER,
): Bm25Index {
  const documentLengths: number[] = []
  const postings = new Map<string, Array<[number, number]>>()
  for (const [ordinal, document] of documents.entries()) {
    const tokens = analyzeBm25(analyzer, document)
    documentLengths.push(tokens.length)
    const frequencies = new Map<string, number>()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    for (const [term, frequency] of frequencies) {
      const termPostings = postings.get(term) ?? []
      termPostings.push([ordinal, frequency])
      postings.set(term, termPostings)
    }
  }
  const averageDocumentLength = documents.length === 0
    ? 0
    : documentLengths.reduce((sum, length) => sum + length, 0) / documents.length
  const terms = [...postings.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([term, termPostings]): Bm25Term => ({
      term,
      documentFrequency: termPostings.length,
      postings: termPostings,
    }))
  return {
    version: 1,
    ...(analyzer === ENGLISH_ANALYZER ? {} : { analyzer }),
    documentLengths,
    averageDocumentLength,
    terms,
  }
}

function scoreBm25(
  index: Bm25Index,
  query: string,
  chunkIds: readonly string[],
  limit: number,
  k1: number,
  b: number,
): Bm25Diagnostics {
  if (index.documentLengths.length !== chunkIds.length) {
    throw new TypeError('knowledge-local: BM25 document lengths do not match chunk ids')
  }
  const terms = new Map(index.terms.map(term => [term.term, term]))
  const scored = new Map<number, { score: number; contributions: Bm25TermContribution[] }>()
  const queryTokens = [...new Set(analyzeBm25(index.analyzer ?? ENGLISH_ANALYZER, query))]
  for (const queryTerm of queryTokens) {
    const indexed = terms.get(queryTerm)
    if (indexed === undefined) continue
    const documentCount = index.documentLengths.length
    const idf = Math.log(1 + (documentCount - indexed.documentFrequency + 0.5) / (indexed.documentFrequency + 0.5))
    for (const [ordinal, frequency] of indexed.postings) {
      const length = index.documentLengths[ordinal]
      if (length === undefined) throw new TypeError('knowledge-local: BM25 posting ordinal is out of range')
      const normalization = index.averageDocumentLength === 0 ? 1 : length / index.averageDocumentLength
      const contribution = idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * normalization))
      const current = scored.get(ordinal) ?? { score: 0, contributions: [] }
      current.score += contribution
      current.contributions.push({
        term: queryTerm,
        termFrequency: frequency,
        documentFrequency: indexed.documentFrequency,
        documentLength: length,
        score: contribution,
      })
      scored.set(ordinal, current)
    }
  }
  const matches = [...scored.entries()]
    .map(([ordinal, value]) => ({ ordinal, score: value.score, contributions: value.contributions }))
    .sort((left, right) => right.score - left.score
      || compareCodePoints(chunkIds[left.ordinal] as string, chunkIds[right.ordinal] as string))
    .slice(0, limit)
  return { queryTokens, matches }
}

/**
 * Score one query with the fixed offline Okapi BM25 formula.
 * @param index - immutable in-memory BM25 index.
 * @param query - natural-language query.
 * @param chunkIds - ordinal-aligned chunk identifiers used for deterministic ties.
 * @param limit - maximum matches to return.
 * @param k1 - term-frequency saturation parameter.
 * @param b - document-length normalization parameter.
 * @returns ranked ordinal and score pairs.
 */
export function searchBm25(
  index: Bm25Index,
  query: string,
  chunkIds: readonly string[],
  limit: number,
  k1: number,
  b: number,
): Bm25Match[] {
  return scoreBm25(index, query, chunkIds, limit, k1, b).matches.map(({ ordinal, score }) => ({ ordinal, score }))
}

/**
 * Explain the offline scorer's token analysis and per-term contributions.
 * @param index - immutable in-memory BM25 index.
 * @param query - natural-language query.
 * @param chunkIds - ordinal-aligned chunk identifiers used for deterministic ties.
 * @param limit - maximum matches to explain.
 * @param k1 - term-frequency saturation parameter.
 * @param b - document-length normalization parameter.
 * @returns analyzed query tokens and ranked per-term contributions.
 */
export function explainBm25(
  index: Bm25Index,
  query: string,
  chunkIds: readonly string[],
  limit: number,
  k1: number,
  b: number,
): Bm25Diagnostics {
  return scoreBm25(index, query, chunkIds, limit, k1, b)
}
