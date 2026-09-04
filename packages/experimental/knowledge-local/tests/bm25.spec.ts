import { describe, expect, it } from 'vitest'
import { analyzeEnglishV1, buildBm25Index, explainBm25, searchBm25 } from '@deepseek-ai/dsh-experimental-knowledge-local'

describe('english-v1', () => {
  it('normalizes case, compatibility characters, letters, and numbers', () => {
    expect(analyzeEnglishV1('Vitamin Ｄ-3, TEST_42!')).toEqual(['vitamin', 'd', '3', 'test', '42'])
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
})
