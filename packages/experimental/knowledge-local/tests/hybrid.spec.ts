import { describe, expect, it, vi } from 'vitest'
import { fuseRrf } from '../src/hybrid.ts'
import { searchHybrid } from '../src/hybrid.ts'

describe('Hybrid Reciprocal Rank Fusion', () => {
  it('fuses dual-route and single-route candidates with one-based ranks', () => {
    const matches = fuseRrf(
      [
        { ordinal: 0, score: 9 },
        { ordinal: 1, score: 8 },
        { ordinal: 2, score: 7 },
      ],
      [
        { ordinal: 1, score: 0.9 },
        { ordinal: 3, score: 0.8 },
        { ordinal: 0, score: 0.7 },
      ],
      ['chunk-a', 'chunk-b', 'chunk-c', 'chunk-d'],
      60,
      4,
    )

    expect(matches.map(match => match.ordinal)).toEqual([1, 0, 3, 2])
    expect(matches[0]?.score).toBeCloseTo(1 / 62 + 1 / 61)
    expect(matches[2]?.score).toBeCloseTo(1 / 62)
  })

  it('resolves complete ties by chunk id and remains deterministic', () => {
    const run = () => fuseRrf(
      [{ ordinal: 0, score: 10 }],
      [{ ordinal: 1, score: 1 }],
      ['chunk-z', 'chunk-a'],
      60,
      2,
    )

    expect(run()).toEqual([
      { ordinal: 1, score: 1 / 61 },
      { ordinal: 0, score: 1 / 61 },
    ])
    expect(run()).toEqual(run())

    expect(fuseRrf(
      [{ ordinal: 0, score: 1 }],
      [{ ordinal: 1, score: 1 }],
      [],
      60,
      2,
    ).map(match => match.ordinal)).toEqual([0, 1])

    expect(fuseRrf(
      [{ ordinal: 1, score: 1 }],
      [{ ordinal: 0, score: 1 }],
      undefined,
      60,
      2,
    ).map(match => match.ordinal)).toEqual([0, 1])
  })

  it('fails without partial results when either retrieval route fails', async () => {
    const denseAfterBm25Failure = vi.fn(() => Promise.resolve([]))
    await expect(searchHybrid(
      () => { throw new Error('BM25 failed') },
      denseAfterBm25Failure,
      [],
      60,
      50,
    )).rejects.toThrow('BM25 failed')
    expect(denseAfterBm25Failure).not.toHaveBeenCalled()

    await expect(searchHybrid(
      () => [{ ordinal: 0, score: 1 }],
      () => Promise.reject(new Error('Dense failed')),
      ['chunk'],
      60,
      50,
    )).rejects.toThrow('Dense failed')
  })

  it('returns fused candidates after both routes succeed', async () => {
    await expect(searchHybrid(
      () => [{ ordinal: 0, score: 2 }],
      () => Promise.resolve([{ ordinal: 0, score: 1 }]),
      ['chunk'],
      60,
      1,
    )).resolves.toEqual([{ ordinal: 0, score: 2 / 61 }])
  })
})
