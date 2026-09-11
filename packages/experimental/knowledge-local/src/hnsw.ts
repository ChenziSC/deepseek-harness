/** Thin USearch adapter for persistent cosine HNSW indexes. */

import { Index, MetricKind, ScalarKind } from 'usearch'
import type { DenseMatch } from './dense.ts'

/** Fixed HNSW payload name in the current knowledge index format. */
export const HNSW_FILE = 'dense.usearch'
/** USearch version pinned by the package dependency. */
export const USEARCH_VERSION = '2.26.2'
/** Default HNSW graph connectivity. */
export const DEFAULT_HNSW_CONNECTIVITY = 16
/** Default HNSW build expansion. */
export const DEFAULT_HNSW_EXPANSION_ADD = 128
/** Default HNSW query expansion. */
export const DEFAULT_HNSW_EXPANSION_SEARCH = 1024

/** Parameters that determine a persisted HNSW graph. */
export interface HnswBuildOptions {
  readonly dimensions: number
  readonly connectivity: number
  readonly expansionAdd: number
}

/** Mutable HNSW graph used only during index construction. */
export class HnswBuilder {
  private readonly index: Index

  constructor(options: HnswBuildOptions) {
    this.index = new Index({
      dimensions: options.dimensions,
      metric: MetricKind.Cos,
      quantization: ScalarKind.F32,
      connectivity: options.connectivity,
      expansion_add: options.expansionAdd,
      expansion_search: DEFAULT_HNSW_EXPANSION_SEARCH,
      multi: false,
    })
  }

  /**
   * Add one consecutive row-major batch using ordinals as keys.
   * @param firstOrdinal - key assigned to the first vector in the batch.
   * @param vectors - consecutive row-major vectors.
   */
  add(firstOrdinal: number, vectors: Float32Array): void {
    const rows = vectors.length / this.index.dimensions()
    const keys = BigUint64Array.from({ length: rows }, (_, index) => BigInt(firstOrdinal + index))
    this.index.add(keys, vectors)
  }

  /**
   * Persist the completed graph.
   * @param path - destination file path.
   */
  save(path: string): void {
    this.index.save(path)
  }
}

/** Read-only HNSW search handle backed by one persisted file. */
export class HnswIndex {
  private readonly index: Index

  constructor(path: string, dimensions: number, expansionSearch: number) {
    this.index = new Index({
      dimensions,
      metric: MetricKind.Cos,
      quantization: ScalarKind.F32,
      connectivity: 0,
      expansion_add: 0,
      expansion_search: expansionSearch,
      multi: false,
    })
    this.index.view(path)
  }

  /**
   * Search one normalized query and validate every native result.
   * @param query - normalized query vector.
   * @param limit - maximum number of matches.
   * @param vectorCount - number of vectors represented by the index.
   * @returns valid matches ordered by USearch similarity.
   */
  search(query: Float32Array, limit: number, vectorCount: number): DenseMatch[] {
    const count = Math.min(limit, vectorCount)
    if (count === 0) return []
    const result = this.index.search(query, count, 0)
    if (result.keys.length !== result.distances.length || result.keys.length > count) {
      throw new TypeError('knowledge-local: USearch returned inconsistent result lengths')
    }
    return Array.from(result.keys, (key, position) => {
      const ordinal = Number(key)
      const distance = result.distances[position]
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= vectorCount) {
        throw new TypeError('knowledge-local: USearch returned an out-of-range ordinal')
      }
      if (distance === undefined || !Number.isFinite(distance)) {
        throw new TypeError('knowledge-local: USearch returned a non-finite distance')
      }
      return { ordinal, score: 1 - distance }
    })
  }
}
