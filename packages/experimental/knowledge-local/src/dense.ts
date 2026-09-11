/** Exact dense-vector validation and retrieval. */

import { KnowledgeError } from '@deepseek-ai/dsh-experimental-knowledge'
import { compareCodePoints } from './ordering.ts'

/** Embedding width of the second-phase BGE-M3 default. */
export const DENSE_DIMENSIONS = 1024
/** Maximum accepted deviation from unit L2 norm. */
const DENSE_NORMALIZATION_TOLERANCE = 1e-4

/** One dense retrieval match before projection to a knowledge hit. */
export interface DenseMatch {
  readonly ordinal: number
  readonly score: number
}

function vectorNorm(vectors: Float32Array, offset: number, dimensions: number): number {
  let squaredNorm = 0
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    const value = vectors[offset + dimension] as number
    if (!Number.isFinite(value)) return Number.NaN
    squaredNorm += value * value
  }
  return Math.sqrt(squaredNorm)
}

/**
 * Validate one row-major matrix of normalized float32 embeddings.
 * @param vectors - row-major embedding values.
 * @param rowCount - expected number of rows.
 * @param dimensions - expected values per row.
 * @param label - value name included in validation errors.
 */
export function validateDenseVectors(
  vectors: Float32Array,
  rowCount: number,
  dimensions: number,
  label: string,
): void {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new TypeError(`${label} row count is invalid`)
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new TypeError(`${label} dimensions are invalid`)
  if (vectors.length !== rowCount * dimensions) throw new TypeError(`${label} dimensions do not match its data length`)
  for (let row = 0; row < rowCount; row += 1) {
    const norm = vectorNorm(vectors, row * dimensions, dimensions)
    if (!Number.isFinite(norm)) throw new TypeError(`${label} contains a non-finite value`)
    if (Math.abs(norm - 1) > DENSE_NORMALIZATION_TOLERANCE) {
      throw new TypeError(`${label} row ${row} is not L2-normalized`)
    }
  }
}

function dotProduct(
  vectors: Float32Array,
  vectorOffset: number,
  query: Float32Array,
  dimensions: number,
): number {
  let score = 0
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    score = Math.fround(score + Math.fround(
      (vectors[vectorOffset + dimension] as number) * (query[dimension] as number),
    ))
  }
  return score
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new KnowledgeError('Knowledge search was cancelled.', 'KNOWLEDGE_CANCELLED')
  }
}

/**
 * Rank every indexed embedding by exact float32 dot product.
 * @param vectors - validated row-major document embeddings.
 * @param query - one normalized query embedding.
 * @param chunkIds - optional row-aligned chunk identifiers used for deterministic ties.
 * @param dimensions - values per embedding.
 * @param limit - maximum matches to return.
 * @param signal - optional cooperative cancellation signal.
 * @param eligibleOrdinals - optional row-aligned eligibility mask.
 * @returns exact matches ordered by descending score and chunk identifier.
 */
export function searchDense(
  vectors: Float32Array,
  query: Float32Array,
  chunkIds: readonly string[] | undefined,
  dimensions: number,
  limit: number,
  signal?: AbortSignal,
  eligibleOrdinals?: Uint8Array,
): DenseMatch[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('knowledge-local: dense limit must be positive')
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new TypeError('knowledge-local: dense dimensions are invalid')
  }
  if (vectors.length % dimensions !== 0) {
    throw new TypeError('knowledge-local: dense index dimensions do not match its data length')
  }
  const rowCount = vectors.length / dimensions
  if (chunkIds !== undefined && chunkIds.length !== rowCount) {
    throw new TypeError('knowledge-local: dense index dimensions do not match its data length')
  }
  if (eligibleOrdinals !== undefined && eligibleOrdinals.length !== rowCount) {
    throw new TypeError('knowledge-local: dense eligibility mask does not match its row count')
  }
  validateDenseVectors(query, 1, dimensions, 'knowledge-local: dense query')
  const matches: DenseMatch[] = []
  for (let ordinal = 0; ordinal < rowCount; ordinal += 1) {
    if (ordinal % 256 === 0) throwIfCancelled(signal)
    if (eligibleOrdinals?.[ordinal] === 0) continue
    const score = dotProduct(vectors, ordinal * dimensions, query, dimensions)
    if (!Number.isFinite(score)) throw new TypeError('knowledge-local: dense index contains a non-finite value')
    matches.push({
      ordinal,
      score,
    })
  }
  throwIfCancelled(signal)
  return matches
    .sort((left, right) => right.score - left.score
      || (chunkIds === undefined
        ? left.ordinal - right.ordinal
        : compareCodePoints(chunkIds[left.ordinal] as string, chunkIds[right.ordinal] as string)))
    .slice(0, limit)
}
