/** Deterministic document-level evaluation for the fixed SciFact experiment matrix. */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import type { KnowledgeSearchResult } from '@deepseek-ai/dsh-experimental-knowledge'
import {
  parseSciFactQrelsTsv,
  parseSciFactQueriesJsonl,
  type CorpusDocument,
  type SciFactEvaluationQuery,
} from './corpus.ts'
import { DEFAULT_RRF_K } from './hybrid.ts'
import { loadKnowledgeIndex } from './index-format.ts'
import { DEFAULT_DENSE_MAX_TOKENS } from './model-runtime.ts'
import LocalKnowledgeProvider from './provider.ts'
import {
  BGE_RERANKER_DTYPE,
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  DEFAULT_RERANKER_BATCH_SIZE,
  DEFAULT_RERANKER_MAX_TOKENS,
} from './reranker.ts'

/** Retrieval modes included in the fixed evaluation matrix. */
export type EvaluationMode = 'bm25' | 'dense' | 'hybrid'

/** Aggregate quality measurements for one successful run. */
export interface EvaluationMetrics {
  readonly recallAt1: number
  readonly recallAt5: number
  readonly recallAt10: number
  readonly recallAt20: number
  readonly mrrAt10: number
  readonly ndcgAt10: number
  readonly successAt1: number
  readonly successAt5: number
  readonly successAt10: number
  readonly successAt20: number
}

/** One completed or failed evaluation configuration. */
export interface EvaluationRun {
  readonly mode: EvaluationMode
  readonly rerank: boolean
  readonly status: 'success' | 'failed'
  readonly queryCount: number
  readonly error?: string
  readonly metrics?: EvaluationMetrics
  readonly latencyMs?: { readonly p50: number; readonly p95: number }
}

/** Machine-readable result of the fixed six-run SciFact experiment. */
export interface EvaluationReport {
  readonly schemaVersion: 1
  readonly createdAt: string
  readonly platform: {
    readonly os: string
    readonly release: string
    readonly arch: string
    readonly node: string
  }
  readonly corpusSha256: string
  readonly indexFingerprint: string
  readonly models: {
    readonly dense: { readonly modelId: string; readonly revision: string; readonly dtype: 'q8' }
    readonly reranker: { readonly modelId: string; readonly revision: string; readonly dtype: 'q8' }
  }
  readonly config: {
    readonly candidateCount: 50
    readonly maxResults: number
    readonly warmupQueries: number
    readonly bm25K1: number
    readonly bm25B: number
    readonly rrfK: 60
    readonly chunkMaxTokens: number
    readonly chunkOverlapTokens: number
    readonly denseMaxTokens: number
    readonly rerankerBatchSize: number
    readonly rerankerMaxTokens: number
    readonly hybridExecution: 'sequential'
  }
  readonly runs: readonly EvaluationRun[]
  readonly build: { readonly durationMs: number; readonly indexBytes: number }
}

/** Search and disposal operations needed by one evaluation run. */
export interface EvaluationProvider {
  readonly search: (query: string, maxResults: number) => Promise<KnowledgeSearchResult>
  readonly dispose: () => Promise<void>
}

/** Factory for one immutable mode and reranking combination. */
export type EvaluationProviderFactory = (
  mode: EvaluationMode,
  rerank: boolean,
) => Promise<EvaluationProvider>

interface RankedDocuments {
  readonly query: SciFactEvaluationQuery
  readonly documentIds: readonly string[]
}

function mean(values: readonly number[]): number {
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

/**
 * Calculate document-level quality metrics for a complete query set.
 * @param ranked - query judgments and de-duplicated document rankings.
 * @returns arithmetic means across all queries.
 */
export function calculateMetrics(ranked: readonly RankedDocuments[]): EvaluationMetrics {
  if (ranked.length === 0) throw new TypeError('knowledge-local: evaluation requires at least one query')
  const perQuery = ranked.map(({ query, documentIds }) => {
    const judgments = new Map(query.relevantDocuments.map(item => [item.documentId as string, item.relevance]))
    const relevant = new Set(judgments.keys())
    return {
      recallAt1: recallAt(documentIds, relevant, 1),
      recallAt5: recallAt(documentIds, relevant, 5),
      recallAt10: recallAt(documentIds, relevant, 10),
      recallAt20: recallAt(documentIds, relevant, 20),
      mrrAt10: reciprocalRankAt10(documentIds, relevant),
      ndcgAt10: ndcgAt10(documentIds, judgments),
      successAt1: successAt(documentIds, relevant, 1),
      successAt5: successAt(documentIds, relevant, 5),
      successAt10: successAt(documentIds, relevant, 10),
      successAt20: successAt(documentIds, relevant, 20),
    }
  })
  return Object.fromEntries(
    Object.keys(perQuery[0] ?? {}).map(key => [
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
  return sorted[index] ?? Number.NaN
}

function foldDocuments(result: KnowledgeSearchResult, limit: number): string[] {
  const documents: string[] = []
  const seen = new Set<string>()
  for (const hit of result.hits) {
    const documentId = hit.documentId as string
    if (seen.has(documentId)) continue
    seen.add(documentId)
    documents.push(documentId)
    if (documents.length === limit) break
  }
  return documents
}

async function evaluateRun(
  provider: EvaluationProvider,
  queries: readonly SciFactEvaluationQuery[],
  maxResults: number,
  warmupQueries: number,
): Promise<{ metrics: EvaluationMetrics; latencyMs: { p50: number; p95: number } }> {
  for (let index = 0; index < warmupQueries; index += 1) {
    const query = queries[index % queries.length]
    if (query !== undefined) await provider.search(query.text, 50)
  }
  const ranked: RankedDocuments[] = []
  const latencies: number[] = []
  for (const query of queries) {
    const startedAt = performance.now()
    const result = await provider.search(query.text, 50)
    latencies.push(performance.now() - startedAt)
    ranked.push({ query, documentIds: foldDocuments(result, maxResults) })
  }
  return {
    metrics: calculateMetrics(ranked),
    latencyMs: { p50: nearestRank(latencies, 0.5), p95: nearestRank(latencies, 0.95) },
  }
}

/**
 * Run all three retrieval modes with and without reranking.
 * @param queries - validated SciFact queries in identifier order.
 * @param maxResults - document result depth, at least 20.
 * @param warmupQueries - number of unmeasured warmup searches.
 * @param createProvider - provider factory for each fixed run.
 * @returns six successful or failed run records in stable order.
 */
export async function evaluateMatrix(
  queries: readonly SciFactEvaluationQuery[],
  maxResults: number,
  warmupQueries: number,
  createProvider: EvaluationProviderFactory,
): Promise<EvaluationRun[]> {
  const runs: EvaluationRun[] = []
  for (const mode of ['bm25', 'dense', 'hybrid'] as const) {
    for (const rerank of [false, true]) {
      let provider: EvaluationProvider | undefined
      try {
        provider = await createProvider(mode, rerank)
        const result = await evaluateRun(provider, queries, maxResults, warmupQueries)
        runs.push({ mode, rerank, status: 'success', queryCount: queries.length, ...result })
      } catch (error) {
        runs.push({
          mode,
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
  return runs
}

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    bytes += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size
  }
  return bytes
}

/** Inputs for one complete local SciFact evaluation. */
export interface EvaluateSciFactOptions {
  readonly indexDir: string
  readonly queriesPath: string
  readonly qrelsPath: string
  readonly modelCacheDir: string
  readonly maxResults: number
  readonly warmupQueries: number
}

/**
 * Load one index and run the fixed six-combination SciFact evaluation.
 * @param options - explicit index, test split, cache, and report limits.
 * @returns complete report ready for JSON serialization.
 */
export async function evaluateSciFact(options: EvaluateSciFactOptions): Promise<EvaluationReport> {
  if (!Number.isSafeInteger(options.maxResults) || options.maxResults < 20 || options.maxResults > 50) {
    throw new TypeError('knowledge-local: maxResults must be an integer from 20 through 50')
  }
  if (!Number.isSafeInteger(options.warmupQueries) || options.warmupQueries < 0) {
    throw new TypeError('knowledge-local: warmupQueries must be a non-negative safe integer')
  }
  const index = await loadKnowledgeIndex(options.indexDir)
  if (index.manifest.dense === undefined) {
    throw new TypeError('knowledge-local: evaluation index must contain Dense embeddings')
  }
  const queryText = await readFile(options.queriesPath, 'utf8')
  const queries = parseSciFactQueriesJsonl(queryText, options.queriesPath)
  const documents: CorpusDocument[] = [...new Map(index.chunks.map(chunk => [
    chunk.documentId as string,
    { id: chunk.documentId, text: chunk.text },
  ])).values()]
  const evaluationQueries = parseSciFactQrelsTsv(
    await readFile(options.qrelsPath, 'utf8'),
    queries,
    documents,
    options.qrelsPath,
  )
  if (evaluationQueries.length === 0) throw new TypeError('knowledge-local: SciFact qrels contain no evaluation queries')
  const createProvider: EvaluationProviderFactory = async (mode, rerank) => {
    const context = new Context()
    try {
      await context.plugin(LocalKnowledgeProvider, {
        indexDir: options.indexDir,
        mode,
        rerank,
        candidateCount: 50,
        modelCacheDir: options.modelCacheDir,
      })
    } catch (error) {
      await context.fiber.dispose()
      throw error
    }
    return {
      search: (query, maxResults) => context.knowledge.search({ query, maxResults }),
      dispose: () => context.fiber.dispose(),
    }
  }
  const manifestText = await readFile(join(options.indexDir, 'manifest.json'))
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    platform: { os: platform(), release: release(), arch: arch(), node: process.version },
    corpusSha256: index.manifest.corpus.sha256,
    indexFingerprint: createHash('sha256').update(manifestText).digest('hex'),
    models: {
      dense: {
        modelId: index.manifest.dense.modelId,
        revision: index.manifest.dense.revision,
        dtype: index.manifest.dense.dtype,
      },
      reranker: {
        modelId: BGE_RERANKER_MODEL_ID,
        revision: BGE_RERANKER_REVISION,
        dtype: BGE_RERANKER_DTYPE,
      },
    },
    config: {
      candidateCount: 50,
      maxResults: options.maxResults,
      warmupQueries: options.warmupQueries,
      bm25K1: index.manifest.bm25.k1,
      bm25B: index.manifest.bm25.b,
      rrfK: DEFAULT_RRF_K,
      chunkMaxTokens: index.manifest.chunking.maxTokens,
      chunkOverlapTokens: index.manifest.chunking.overlapTokens,
      denseMaxTokens: DEFAULT_DENSE_MAX_TOKENS,
      rerankerBatchSize: DEFAULT_RERANKER_BATCH_SIZE,
      rerankerMaxTokens: DEFAULT_RERANKER_MAX_TOKENS,
      hybridExecution: 'sequential',
    },
    runs: await evaluateMatrix(evaluationQueries, options.maxResults, options.warmupQueries, createProvider),
    build: { durationMs: index.manifest.build.durationMs, indexBytes: await directoryBytes(options.indexDir) },
  }
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function tableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\s+/gu, ' ')
}

/**
 * Project one evaluation report into a concise Markdown table.
 * @param report - authoritative machine-readable report.
 * @returns Markdown derived without recomputing any metric.
 */
export function renderEvaluationReport(report: EvaluationReport): string {
  const lines = [
    '# SciFact RAG Evaluation',
    '',
    `Created: ${report.createdAt}`,
    '',
    '| Mode | Rerank | Status | Recall@1 | Recall@5 | Recall@10 | Recall@20 | MRR@10 | nDCG@10 | Success@1 | Success@5 | Success@10 | Success@20 | p50 ms | p95 ms |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const run of report.runs) {
    if (run.status === 'failed' || run.metrics === undefined || run.latencyMs === undefined) {
      lines.push(`| ${run.mode} | ${String(run.rerank)} | failed: ${tableCell(run.error ?? 'unknown error')} | — | — | — | — | — | — | — | — | — | — | — | — |`)
      continue
    }
    lines.push(`| ${run.mode} | ${String(run.rerank)} | success | ${percentage(run.metrics.recallAt1)} | ${percentage(run.metrics.recallAt5)} | ${percentage(run.metrics.recallAt10)} | ${percentage(run.metrics.recallAt20)} | ${percentage(run.metrics.mrrAt10)} | ${percentage(run.metrics.ndcgAt10)} | ${percentage(run.metrics.successAt1)} | ${percentage(run.metrics.successAt5)} | ${percentage(run.metrics.successAt10)} | ${percentage(run.metrics.successAt20)} | ${run.latencyMs.p50.toFixed(2)} | ${run.latencyMs.p95.toFixed(2)} |`)
  }
  lines.push('', `Index bytes: ${report.build.indexBytes}`, '')
  return `${lines.join('\n')}\n`
}
