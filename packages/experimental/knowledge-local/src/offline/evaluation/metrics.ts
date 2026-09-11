/** Deterministic document-level quality and latency metrics. */

import type { SciFactEvaluationQuery } from '../../corpus.ts'
import type { EvaluationMetrics, RankedDocuments } from './types.ts'

/** Return the arithmetic mean of one non-empty metric sample. */
export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function recallAt(documents: readonly string[], relevant: ReadonlySet<string>, cutoff: number): number {
  let matches = 0
  for (const document of documents.slice(0, cutoff)) if (relevant.has(document)) matches += 1
  return matches / relevant.size
}

function successAt(documents: readonly string[], relevant: ReadonlySet<string>, cutoff: number): number {
  return documents.slice(0, cutoff).some(document => relevant.has(document)) ? 1 : 0
}

function reciprocalRankAt10(documents: readonly string[], relevant: ReadonlySet<string>): number {
  const index = documents.slice(0, 10).findIndex(document => relevant.has(document))
  return index < 0 ? 0 : 1 / (index + 1)
}

function dcg(relevances: readonly number[]): number {
  return relevances.reduce((sum, relevance, index) => sum + (2 ** relevance - 1) / Math.log2(index + 2), 0)
}

function ndcgAt10(documents: readonly string[], judgments: ReadonlyMap<string, number>): number {
  const actual = documents.slice(0, 10).map(document => judgments.get(document) ?? 0)
  const ideal = [...judgments.values()].sort((left, right) => right - left).slice(0, 10)
  const idealDcg = dcg(ideal)
  return idealDcg === 0 ? 0 : dcg(actual) / idealDcg
}

export function calculateQueryMetrics(query: SciFactEvaluationQuery, documentIds: readonly string[]): EvaluationMetrics {
  const judgments = new Map(query.relevantDocuments.map(item => [item.documentId as string, item.relevance]))
  const relevant = new Set(judgments.keys())
  return {
    recallAt1: recallAt(documentIds, relevant, 1),
    recallAt5: recallAt(documentIds, relevant, 5),
    recallAt10: recallAt(documentIds, relevant, 10),
    recallAt20: recallAt(documentIds, relevant, 20),
    recallAt100: recallAt(documentIds, relevant, 100),
    mrrAt10: reciprocalRankAt10(documentIds, relevant),
    ndcgAt10: ndcgAt10(documentIds, judgments),
    successAt1: successAt(documentIds, relevant, 1),
    successAt5: successAt(documentIds, relevant, 5),
    successAt10: successAt(documentIds, relevant, 10),
    successAt20: successAt(documentIds, relevant, 20),
    successAt100: successAt(documentIds, relevant, 100),
  }
}

/**
 * Calculate document-level quality metrics for a complete query set.
 * @param ranked - query judgments and de-duplicated document rankings.
 * @returns arithmetic means across all queries.
 */
export function calculateMetrics(ranked: readonly RankedDocuments[]): EvaluationMetrics {
  if (ranked.length === 0) throw new TypeError('knowledge-local: evaluation requires at least one query')
  const perQuery = ranked.map(({ query, documentIds }) => calculateQueryMetrics(query, documentIds))
  return Object.fromEntries(
    Object.keys(perQuery[0] as EvaluationMetrics).map(key => [
      key,
      mean(perQuery.map(value => value[key as keyof EvaluationMetrics])),
    ]),
  ) as unknown as EvaluationMetrics
}

/**
 * Select one nearest-rank percentile from a non-empty sample.
 * @param values - finite measurements.
 * @param percentile - fraction in the inclusive range from zero through one.
 * @returns the nearest-rank sample value.
 */
export function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new TypeError('knowledge-local: percentile requires at least one value')
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return sorted[index] as number
}
