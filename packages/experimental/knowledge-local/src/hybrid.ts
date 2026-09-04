/** Deterministic Reciprocal Rank Fusion for BM25 and Dense candidates. */

import type { Bm25Match } from './bm25.ts'
import { compareCodePoints } from './bm25.ts'
import type { DenseMatch } from './dense.ts'

/** Default Reciprocal Rank Fusion constant. */
export const DEFAULT_RRF_K = 60

/** One fused retrieval match before projection to a knowledge hit. */
export interface HybridMatch {
  readonly ordinal: number
  readonly score: number
}

interface FusedCandidate extends HybridMatch {
  readonly bestRank: number
}

function addRanks(
  candidates: Map<number, FusedCandidate>,
  matches: readonly (Bm25Match | DenseMatch)[],
  rrfK: number,
): void {
  for (const [index, match] of matches.entries()) {
    const rank = index + 1
    const current = candidates.get(match.ordinal)
    candidates.set(match.ordinal, {
      ordinal: match.ordinal,
      score: (current?.score ?? 0) + 1 / (rrfK + rank),
      bestRank: Math.min(current?.bestRank ?? rank, rank),
    })
  }
}

/**
 * Fuse two ranked candidate lists using Reciprocal Rank Fusion.
 * @param bm25Matches - BM25 candidates in rank order.
 * @param denseMatches - Dense candidates in rank order.
 * @param chunkIds - ordinal-aligned chunk identifiers used for deterministic ties.
 * @param rrfK - positive Reciprocal Rank Fusion constant.
 * @param limit - maximum fused candidates to return.
 * @returns fused matches ordered by score, best input rank, and chunk identifier.
 */
export function fuseRrf(
  bm25Matches: readonly Bm25Match[],
  denseMatches: readonly DenseMatch[],
  chunkIds: readonly string[],
  rrfK: number,
  limit: number,
): HybridMatch[] {
  const candidates = new Map<number, FusedCandidate>()
  addRanks(candidates, bm25Matches, rrfK)
  addRanks(candidates, denseMatches, rrfK)
  return [...candidates.values()]
    .sort((left, right) => right.score - left.score
      || left.bestRank - right.bestRank
      || compareCodePoints(chunkIds[left.ordinal] ?? '', chunkIds[right.ordinal] ?? ''))
    .slice(0, limit)
    .map(({ ordinal, score }) => ({ ordinal, score }))
}

/**
 * Run BM25 then Dense retrieval and fuse only after both routes succeed.
 * @param searchBm25Candidates - synchronous BM25 candidate operation.
 * @param searchDenseCandidates - Dense candidate operation started after BM25 completes.
 * @param chunkIds - ordinal-aligned chunk identifiers used for deterministic ties.
 * @param rrfK - positive Reciprocal Rank Fusion constant.
 * @param limit - maximum fused candidates to return.
 * @returns fused candidates after both retrieval routes complete.
 */
export async function searchHybrid(
  searchBm25Candidates: () => readonly Bm25Match[],
  searchDenseCandidates: () => Promise<readonly DenseMatch[]>,
  chunkIds: readonly string[],
  rrfK: number,
  limit: number,
): Promise<HybridMatch[]> {
  const bm25Matches = searchBm25Candidates()
  const denseMatches = await searchDenseCandidates()
  return fuseRrf(bm25Matches, denseMatches, chunkIds, rrfK, limit)
}
