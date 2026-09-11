/** Deterministic lexical analysis for the SQLite FTS5 index. */

/** Stable identifier of the first English analyzer revision. */
export const ENGLISH_ANALYZER = 'english-v1'
/** Stable identifier of the mixed Chinese and English analyzer revision. */
export const MIXED_ZH_EN_ANALYZER = 'mixed-zh-en-v1'
/** Analyzer revisions supported by version-two indexes. */
export type KnowledgeBm25Analyzer = typeof ENGLISH_ANALYZER | typeof MIXED_ZH_EN_ANALYZER

/** One scored ordinal before projection to a knowledge hit. */
export interface Bm25Match {
  readonly ordinal: number
  readonly score: number
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
