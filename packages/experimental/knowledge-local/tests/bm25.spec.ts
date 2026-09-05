import { describe, expect, it } from 'vitest'
import {
  analyzeEnglishV1,
  analyzeMixedZhEnV1,
  buildBm25Index,
  compareCodePoints,
  explainBm25,
  searchBm25,
  type Bm25Index,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

describe('english-v1', () => {
  it('normalizes case, compatibility characters, letters, and numbers', () => {
    expect(analyzeEnglishV1('Vitamin Ｄ-3, TEST_42!')).toEqual(['vitamin', 'd', '3', 'test', '42'])
    expect(analyzeEnglishV1('---')).toEqual([])
  })

  it('compares Unicode code points and prefix lengths', () => {
    expect(compareCodePoints('a', 'b')).toBeLessThan(0)
    expect(compareCodePoints('a', 'aa')).toBeLessThan(0)
    expect(compareCodePoints('same', 'same')).toBe(0)
  })
})

describe('mixed-zh-en-v1', () => {
  it('encodes Latin words, numbers, underscores, Han unigrams, and Han bigrams', () => {
    expect(analyzeMixedZhEnV1('API＿v２ 中文 A.P.I.')).toEqual([
      'w_api_v2',
      'c1_4e2d',
      'c2_4e2d_6587',
      'c1_6587',
      'w_a',
      'w_p',
      'w_i',
    ])
  })

  it('uses punctuation as a boundary and emits ASCII-safe terms', () => {
    const terms = analyzeMixedZhEnV1('Café—检索，实验！')
    expect(terms).toEqual([
      'w_cafxe9_',
      'c1_68c0',
      'c2_68c0_7d22',
      'c1_7d22',
      'c1_5b9e',
      'c2_5b9e_9a8c',
      'c1_9a8c',
    ])
    expect(terms.every(term => /^[\x00-\x7F]+$/u.test(term))).toBe(true)
    expect(analyzeMixedZhEnV1('---')).toEqual([])
  })
})

describe('BM25', () => {
  it('uses the specified formula and deterministic chunk-id tie breaking', () => {
    const index = buildBm25Index(['alpha alpha beta', 'alpha gamma', 'delta'])
    const results = searchBm25(index, 'alpha alpha', ['chunk-b', 'chunk-a', 'chunk-c'], 3, 1.2, 0.75)

    expect(results.map(result => result.ordinal)).toEqual([0, 1])
    expect(results[0]?.score).toBeCloseTo(0.5665797174)
    expect(results[1]?.score).toBeCloseTo(0.4700036292)
  })

  it('returns an empty result when no query term occurs', () => {
    const index = buildBm25Index(['alpha'])
    expect(searchBm25(index, 'missing', ['chunk-a'], 5, 1.2, 0.75)).toEqual([])
    expect(buildBm25Index([])).toEqual({
      version: 1,
      documentLengths: [],
      averageDocumentLength: 0,
      terms: [],
    })
  })

  it('exposes local diagnostics without applying repeated query terms twice', () => {
    const index = buildBm25Index(['alpha alpha beta', 'alpha gamma', 'delta'])
    const diagnostics = explainBm25(index, 'alpha alpha missing', ['chunk-b', 'chunk-a', 'chunk-c'], 3, 1.2, 0.75)

    expect(diagnostics.queryTokens).toEqual(['alpha', 'missing'])
    expect(diagnostics.matches[0]?.contributions).toEqual([{
      term: 'alpha',
      termFrequency: 2,
      documentFrequency: 2,
      documentLength: 3,
      score: diagnostics.matches[0]?.score,
    }])
  })

  it('sorts exact score ties by Unicode code point order', () => {
    const index = buildBm25Index(['alpha', 'alpha'])
    const results = searchBm25(index, 'alpha', ['chunk-b', 'chunk-a'], 2, 1.2, 0.75)
    expect(results.map(result => result.ordinal)).toEqual([1, 0])
  })

  it('rejects inconsistent ordinal data', () => {
    const index = buildBm25Index(['alpha'])
    expect(() => searchBm25(index, 'alpha', [], 1, 1.2, 0.75))
      .toThrow('document lengths do not match chunk ids')

    const invalid: Bm25Index = {
      version: 1,
      documentLengths: [1],
      averageDocumentLength: 1,
      terms: [{ term: 'alpha', documentFrequency: 1, postings: [[1, 1]] }],
    }
    expect(() => searchBm25(invalid, 'alpha', ['chunk'], 1, 1.2, 0.75))
      .toThrow('posting ordinal is out of range')
  })

  it('uses neutral length normalization for a zero-length index row', () => {
    const index: Bm25Index = {
      version: 1,
      documentLengths: [0],
      averageDocumentLength: 0,
      terms: [{ term: 'alpha', documentFrequency: 1, postings: [[0, 1]] }],
    }
    expect(searchBm25(index, 'alpha', ['chunk'], 1, 1.2, 0.75)[0]?.score).toBeGreaterThan(0)
  })
})
