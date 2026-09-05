/** Deterministic lexical analysis and the legacy in-memory BM25 scorer. */

/** Stable identifier of the first English analyzer revision. */
export const ENGLISH_ANALYZER = 'english-v1'
/** Stable identifier of the mixed Chinese and English analyzer revision. */
export const MIXED_ZH_EN_ANALYZER = 'mixed-zh-en-v1'
/** Analyzer revisions supported by version-two indexes. */
export type KnowledgeBm25Analyzer = typeof ENGLISH_ANALYZER | typeof MIXED_ZH_EN_ANALYZER

/** One posting in ordinal order: `[documentOrdinal, termFrequency]`. */
export type Bm25Posting = readonly [ordinal: number, termFrequency: number]

/** One indexed term and its document postings. */
export interface Bm25Term {
  readonly term: string
  readonly documentFrequency: number
  readonly postings: readonly Bm25Posting[]
}

/** Serializable BM25 payload aligned with the chunk ordinal sequence. */
export interface Bm25Index {
  readonly version: 1
  readonly documentLengths: readonly number[]
  readonly averageDocumentLength: number
  readonly terms: readonly Bm25Term[]
}

/** One scored ordinal before projection to a knowledge hit. */
export interface Bm25Match {
  readonly ordinal: number
  readonly score: number
}

/** One term's contribution to a BM25 candidate score. */
export interface Bm25TermContribution {
  readonly term: string
  readonly termFrequency: number
  readonly documentFrequency: number
  readonly documentLength: number
  readonly score: number
}

/** One ranked candidate with local-only scoring diagnostics. */
export interface Bm25DiagnosticMatch extends Bm25Match {
  readonly contributions: readonly Bm25TermContribution[]
}

/** Query analysis and candidate-level BM25 diagnostics. */
export interface Bm25Diagnostics {
  readonly queryTokens: readonly string[]
  readonly matches: readonly Bm25DiagnosticMatch[]
}

/**
 * Normalize and tokenize English baseline input.
 * @param text - source or query text.
 * @returns normalized lowercase letter-or-number tokens.
 */
export function analyzeEnglishV1(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function encodeWord(value: string): string {
  let encoded = 'w_'
  for (const character of value) {
    encoded += /^[a-z0-9_]$/u.test(character)
      ? character
      : `x${(character.codePointAt(0) as number).toString(16)}_`
  }
  return encoded
}

function encodeHan(characters: readonly string[]): string {
  return `c${characters.length}_${characters
    .map(character => (character.codePointAt(0) as number).toString(16))
    .join('_')}`
}

/**
 * Analyze mixed Chinese and English text into ASCII-safe FTS5 terms.
 * @param text - source or query text.
 * @returns encoded Latin word terms plus Han unigrams and adjacent bigrams.
 */
export function analyzeMixedZhEnV1(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const terms: string[] = []
  let word = ''
  let han: string[] = []
  const flushWord = (): void => {
    if (word.length > 0) terms.push(encodeWord(word))
    word = ''
  }
  const flushHan = (): void => {
    for (let index = 0; index < han.length; index += 1) {
      terms.push(encodeHan([han[index] as string]))
      if (index + 1 < han.length) terms.push(encodeHan([han[index] as string, han[index + 1] as string]))
    }
    han = []
  }
  for (const character of normalized) {
    if (/^[\p{Script=Latin}\p{N}_]$/u.test(character)) {
      flushHan()
      word += character
    } else if (/^\p{Script=Han}$/u.test(character)) {
      flushWord()
      han.push(character)
    } else {
      flushWord()
      flushHan()
    }
  }
  flushWord()
  flushHan()
  return terms
}

/**
 * Run the analyzer declared by an immutable index.
 * @param analyzer - recorded analyzer revision.
 * @param text - source or query text.
 * @returns deterministic FTS5 terms.
 */
export function analyzeBm25(analyzer: KnowledgeBm25Analyzer, text: string): string[] {
  return analyzer === ENGLISH_ANALYZER ? analyzeEnglishV1(text) : analyzeMixedZhEnV1(text)
}

/**
 * Compare strings by Unicode code points rather than locale.
 * @param left - first string.
 * @param right - second string.
 * @returns a negative, zero, or positive ordering value.
 */
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  const count = Math.min(a.length, b.length)
  for (let index = 0; index < count; index += 1) {
    const difference = ((a[index] as string).codePointAt(0) as number) - ((b[index] as string).codePointAt(0) as number)
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

/**
 * Build a deterministic BM25 payload from already ordered retrieval texts.
 * @param documents - retrieval texts in stable chunk order.
 * @returns the ordinal-aligned BM25 index.
 */
export function buildBm25Index(documents: readonly string[]): Bm25Index {
  const documentLengths: number[] = []
  const postings = new Map<string, Array<[number, number]>>()
  for (const [ordinal, document] of documents.entries()) {
    const tokens = analyzeEnglishV1(document)
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
  return { version: 1, documentLengths, averageDocumentLength, terms }
}

/** Score one query with the fixed Okapi BM25 formula. Repeated query terms count once. */
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
  const queryTokens = [...new Set(analyzeEnglishV1(query))]
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
 * Score one query with the fixed Okapi BM25 formula. Repeated query terms count once.
 * @param index - immutable BM25 index.
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
 * Explain BM25 token analysis and per-term contributions for local evaluation.
 * @param index - immutable BM25 index.
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
