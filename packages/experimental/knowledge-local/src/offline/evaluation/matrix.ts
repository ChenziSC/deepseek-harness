/** Execute fixed retrieval evaluation matrices and collect per-query evidence. */

import { performance } from 'node:perf_hooks'
import type {
  KnowledgeRerank,
  KnowledgeSearchResult,
  ResolvedKnowledgeRetrieval,
} from '@deepseek-ai/dsh-experimental-knowledge'
import type { SciFactEvaluationQuery } from '../../corpus.ts'
import { calculateMetrics, calculateQueryMetrics, mean, nearestRank } from './metrics.ts'
import type {
  EvaluationProvider,
  EvaluationProviderFactory,
  EvaluationQueryDetail,
  EvaluationQueryDetailSink,
  EvaluationRankedDocument,
  EvaluationMode,
  EvaluationMetrics,
  EvaluationRun,
  RankedDocuments,
} from './types.ts'

function foldDocuments(result: KnowledgeSearchResult, limit: number): EvaluationRankedDocument[] {
  const documents: EvaluationRankedDocument[] = []
  const seen = new Set<string>()
  for (const hit of result.hits) {
    const documentId = hit.documentId as string
    if (seen.has(documentId)) continue
    seen.add(documentId)
    documents.push({ documentId, score: hit.score })
    if (documents.length === limit) break
  }
  return documents
}

function recallTopScoreGapRatio(result: KnowledgeSearchResult): number | undefined {
  if (result.strategy.rerank || result.hits.length < 2) return undefined
  const first = result.hits[0]?.score as number
  const second = result.hits[1]?.score as number
  const scale = Math.max(Math.abs(first), Math.abs(second), Number.EPSILON)
  return (first - second) / scale
}

async function evaluateRun(
  provider: EvaluationProvider,
  queries: readonly SciFactEvaluationQuery[],
  maxResults: number,
  warmupQueries: number,
  requestedStrategy: EvaluationQueryDetail['requestedStrategy'],
  onQueryDetail?: EvaluationQueryDetailSink,
): Promise<{
  metrics: EvaluationMetrics
  latencyMs: { p50: number; p95: number }
  ranked: readonly RankedDocuments[]
  rerankAppliedRate: number
  resolvedRetrievalCounts: Readonly<Record<ResolvedKnowledgeRetrieval, number>>
}> {
  for (let index = 0; index < warmupQueries; index += 1) {
    const query = queries[index % queries.length]
    if (query !== undefined) await provider.search(query.text, maxResults)
  }
  const ranked: RankedDocuments[] = []
  const latencies: number[] = []
  let rerankApplied = 0
  const resolvedRetrievalCounts: Record<ResolvedKnowledgeRetrieval, number> = { bm25: 0, dense: 0, hybrid: 0 }
  for (const query of queries) {
    const startedAt = performance.now()
    let result: KnowledgeSearchResult
    try {
      result = await provider.search(query.text, maxResults)
    } catch (error) {
      await onQueryDetail?.({
        schemaVersion: 1,
        queryId: query.id,
        queryText: query.text,
        requestedStrategy,
        relevantDocuments: query.relevantDocuments.map(item => ({
          documentId: item.documentId as string,
          relevance: item.relevance,
        })),
        status: 'failed',
        latencyMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const latencyMs = performance.now() - startedAt
    if (result.strategy.rerank) rerankApplied += 1
    resolvedRetrievalCounts[result.strategy.retrieval] += 1
    const rankedDocuments = foldDocuments(result, maxResults)
    const documentIds = rankedDocuments.map(document => document.documentId)
    const metrics = calculateQueryMetrics(query, documentIds)
    const scoreGapRatio = recallTopScoreGapRatio(result)
    latencies.push(latencyMs)
    ranked.push({ query, documentIds })
    await onQueryDetail?.({
      schemaVersion: 1,
      queryId: query.id,
      queryText: query.text,
      requestedStrategy,
      relevantDocuments: query.relevantDocuments.map(item => ({
        documentId: item.documentId as string,
        relevance: item.relevance,
      })),
      status: 'success',
      latencyMs,
      resolvedStrategy: result.strategy,
      ...(scoreGapRatio === undefined ? {} : { recallTopScoreGapRatio: scoreGapRatio }),
      rankedDocuments,
      metrics,
    })
  }
  return {
    metrics: calculateMetrics(ranked),
    latencyMs: { p50: nearestRank(latencies, 0.5), p95: nearestRank(latencies, 0.95) },
    ranked,
    rerankAppliedRate: rerankApplied / queries.length,
    resolvedRetrievalCounts,
  }
}

function approximationRecall(
  exact: readonly RankedDocuments[],
  approximate: readonly RankedDocuments[],
  cutoff: number,
): number {
  return mean(exact.map((ranking, index) => {
    const expected = new Set(ranking.documentIds.slice(0, cutoff))
    if (expected.size === 0) return 1
    const actual = (approximate[index] as RankedDocuments).documentIds.slice(0, cutoff)
    return actual.filter(documentId => expected.has(documentId)).length / expected.size
  }))
}

/**
 * Run the requested retrieval, Dense index, and reranking combinations.
 * @param queries - validated SciFact queries in identifier order.
 * @param maxResults - document result depth, at least 20.
 * @param warmupQueries - number of unmeasured warmup searches.
 * @param createProvider - provider factory for each fixed run.
 * @param denseIndexes - Dense implementations to compare.
 * @param modes - recall modes to execute.
 * @param rerankValues - reranking preferences to execute.
 * @param onQueryDetail - optional sink for measured per-query records.
 * @returns successful or failed run records in stable order.
 */
export async function evaluateMatrix(
  queries: readonly SciFactEvaluationQuery[],
  maxResults: number,
  warmupQueries: number,
  createProvider: EvaluationProviderFactory,
  denseIndexes: readonly ('exact' | 'hnsw')[] = ['exact'],
  modes: readonly EvaluationMode[] = ['bm25', 'dense', 'hybrid'],
  rerankValues: readonly KnowledgeRerank[] = ['off', 'auto', 'on'],
  onQueryDetail?: EvaluationQueryDetailSink,
): Promise<EvaluationRun[]> {
  const runs: EvaluationRun[] = []
  const rankings = new Map<string, readonly RankedDocuments[]>()
  for (const mode of modes) {
    const indexes = mode === 'bm25' ? ['exact' as const] : denseIndexes
    for (const denseIndex of indexes) for (const rerank of rerankValues) {
      const requestedStrategy: EvaluationQueryDetail['requestedStrategy'] = {
        retrieval: mode,
        ...(mode === 'bm25' ? {} : { denseIndex }),
        rerank,
      }
      let provider: EvaluationProvider | undefined
      try {
        provider = await createProvider(mode, rerank, denseIndex)
        const result = await evaluateRun(
          provider,
          queries,
          maxResults,
          warmupQueries,
          requestedStrategy,
          onQueryDetail,
        )
        if (mode !== 'bm25') rankings.set(`${mode}:${rerank}:${denseIndex}`, result.ranked)
        runs.push({
          mode,
          ...(mode === 'bm25' ? {} : { denseIndex }),
          rerank,
          status: 'success',
          queryCount: queries.length,
          metrics: result.metrics,
          latencyMs: result.latencyMs,
          rerankAppliedRate: result.rerankAppliedRate,
          resolvedRetrievalCounts: result.resolvedRetrievalCounts,
        })
      } catch (error) {
        runs.push({
          mode,
          ...(mode === 'bm25' ? {} : { denseIndex }),
          rerank,
          status: 'failed',
          queryCount: queries.length,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        await provider?.dispose()
      }
    }
  }
  return runs.map((run) => {
    if (run.status !== 'success' || run.denseIndex !== 'hnsw') return run
    const exact = rankings.get(`${run.mode}:${run.rerank}:exact`)
    const approximate = rankings.get(`${run.mode}:${run.rerank}:hnsw`)
    if (exact === undefined || approximate === undefined) return run
    return {
      ...run,
      approximation: {
        recallAt10: approximationRecall(exact, approximate, 10),
        recallAt100: approximationRecall(exact, approximate, 100),
      },
    }
  })
}
