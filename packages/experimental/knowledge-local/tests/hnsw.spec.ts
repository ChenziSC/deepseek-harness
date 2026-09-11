import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Index } from 'usearch'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HnswBuilder, HnswIndex } from '../src/hnsw.ts'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('USearch HNSW adapter', () => {
  it('preserves ordinal keys across save and read-only view', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-hnsw-'))
    directories.push(directory)
    const path = join(directory, 'dense.usearch')
    const builder = new HnswBuilder({ dimensions: 4, connectivity: 16, expansionAdd: 128 })
    builder.add(0, new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
    ]))
    builder.save(path)

    const index = new HnswIndex(path, 4, 64)
    const matches = index.search(new Float32Array([1, 0, 0, 0]), 3, 3)
    expect(matches[0]?.ordinal).toBe(0)
    expect(new Set(matches.map(match => match.ordinal))).toEqual(new Set([0, 1, 2]))
    expect(index.search(new Float32Array([1, 0, 0, 0]), 3, 0)).toEqual([])
  })

  it('rejects inconsistent native search results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-hnsw-invalid-'))
    directories.push(directory)
    const path = join(directory, 'dense.usearch')
    const builder = new HnswBuilder({ dimensions: 2, connectivity: 16, expansionAdd: 128 })
    builder.add(0, new Float32Array([1, 0]))
    builder.save(path)
    const index = new HnswIndex(path, 2, 64)
    const native = vi.spyOn(Index.prototype, 'search')
    const query = new Float32Array([1, 0])

    native.mockReturnValueOnce({ keys: BigUint64Array.from([0n]), distances: new Float32Array() } as never)
    expect(() => index.search(query, 1, 1)).toThrow('inconsistent result lengths')
    native.mockReturnValueOnce({ keys: BigUint64Array.from([0n, 1n]), distances: new Float32Array([0, 0]) } as never)
    expect(() => index.search(query, 1, 2)).toThrow('inconsistent result lengths')
    native.mockReturnValueOnce({ keys: [BigInt(Number.MAX_SAFE_INTEGER) + 1n], distances: [0] } as never)
    expect(() => index.search(query, 1, 2)).toThrow('out-of-range ordinal')
    native.mockReturnValueOnce({ keys: [-1n], distances: [0] } as never)
    expect(() => index.search(query, 1, 2)).toThrow('out-of-range ordinal')
    native.mockReturnValueOnce({ keys: [2n], distances: [0] } as never)
    expect(() => index.search(query, 1, 2)).toThrow('out-of-range ordinal')
    native.mockReturnValueOnce({ keys: [0n], distances: [undefined] } as never)
    expect(() => index.search(query, 1, 2)).toThrow('non-finite distance')
    native.mockReturnValueOnce({ keys: [0n], distances: [Number.NaN] } as never)
    expect(() => index.search(query, 1, 2)).toThrow('non-finite distance')
  })
})
