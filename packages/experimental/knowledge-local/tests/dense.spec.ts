import { describe, expect, it } from 'vitest'
import {
  DENSE_DIMENSIONS,
  searchDense,
  validateDenseVectors,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

function unitVector(dimension: number): Float32Array {
  const vector = new Float32Array(DENSE_DIMENSIONS)
  vector[dimension] = 1
  return vector
}

describe('Dense exact retrieval', () => {
  it('matches a complete reference sort and resolves score ties by chunk id', () => {
    const vectors = new Float32Array(DENSE_DIMENSIONS * 4)
    vectors.set(unitVector(0), 0)
    vectors.set(unitVector(0), DENSE_DIMENSIONS)
    vectors.set(unitVector(1), DENSE_DIMENSIONS * 2)
    const negative = unitVector(0)
    negative[0] = -1
    vectors.set(negative, DENSE_DIMENSIONS * 3)
    const query = unitVector(0)
    const chunkIds = ['chunk-z', 'chunk-a', 'chunk-b', 'chunk-c']

    const matches = searchDense(
      vectors,
      query,
      chunkIds,
      DENSE_DIMENSIONS,
      4,
    )
    const reference = [0, 1, 2, 3]
      .map(ordinal => ({
        ordinal,
        score: vectors.slice(ordinal * DENSE_DIMENSIONS, (ordinal + 1) * DENSE_DIMENSIONS)
          .reduce((sum, value, dimension) => Math.fround(sum + Math.fround(value * (query[dimension] ?? 0))), 0),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score
        const leftId = chunkIds[left.ordinal] ?? ''
        const rightId = chunkIds[right.ordinal] ?? ''
        return leftId === rightId ? 0 : leftId < rightId ? -1 : 1
      })

    expect(matches).toEqual(reference)
    expect(matches).toEqual([
      { ordinal: 1, score: 1 },
      { ordinal: 0, score: 1 },
      { ordinal: 2, score: 0 },
      { ordinal: 3, score: -1 },
    ])
    expect(searchDense(vectors, query, undefined, DENSE_DIMENSIONS, 2).map(match => match.ordinal)).toEqual([0, 1])
  })

  it('rejects invalid vectors and observes cancellation', () => {
    const invalid = unitVector(0)
    invalid[0] = Number.NaN
    expect(() => {
      validateDenseVectors(invalid, 1, DENSE_DIMENSIONS, 'fixture')
    }).toThrow('non-finite')

    const controller = new AbortController()
    controller.abort()
    expect(() => searchDense(unitVector(0), unitVector(0), ['chunk'], DENSE_DIMENSIONS, 1, controller.signal))
      .toThrow('cancelled')
  })

  it('rejects invalid dimensions, lengths, normalization, and scores', () => {
    expect(() => { validateDenseVectors(new Float32Array(), -1, 1, 'fixture') }).toThrow('row count is invalid')
    expect(() => { validateDenseVectors(new Float32Array(), 0, 0, 'fixture') }).toThrow('dimensions are invalid')
    expect(() => { validateDenseVectors(new Float32Array(), 1, 1, 'fixture') }).toThrow('do not match its data length')
    expect(() => { validateDenseVectors(new Float32Array([0]), 1, 1, 'fixture') }).toThrow('not L2-normalized')
    expect(() => searchDense(unitVector(0), unitVector(0), ['chunk'], DENSE_DIMENSIONS, 0))
      .toThrow('dense limit must be positive')
    expect(() => searchDense(unitVector(0), unitVector(0), ['chunk'], 0, 1))
      .toThrow('dense dimensions are invalid')
    expect(() => searchDense(new Float32Array(DENSE_DIMENSIONS + 1), unitVector(0), undefined, DENSE_DIMENSIONS, 1))
      .toThrow('dense index dimensions do not match its data length')
    expect(() => searchDense(unitVector(0), unitVector(0), [], DENSE_DIMENSIONS, 1))
      .toThrow('dense index dimensions do not match its data length')

    const invalidIndex = unitVector(0)
    invalidIndex[1] = Number.NaN
    expect(() => searchDense(invalidIndex, unitVector(0), ['chunk'], DENSE_DIMENSIONS, 1))
      .toThrow('dense index contains a non-finite value')
  })

  it('checks cancellation after scanning', () => {
    let reads = 0
    const signal = {
      get aborted() {
        reads += 1
        return reads === 2
      },
    } as AbortSignal
    expect(() => searchDense(unitVector(0), unitVector(0), ['chunk'], DENSE_DIMENSIONS, 1, signal))
      .toThrow('cancelled')
  })
})
