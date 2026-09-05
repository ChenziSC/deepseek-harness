/** Deterministic document-level evaluation for supported retrieval datasets. */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import {
  KnowledgeDocumentId,
  type KnowledgeSearchResult,
} from '@deepseek-ai/dsh-experimental-knowledge'
import {
  parseSciFactQrelsTsv,
  parseSciFactQueriesJsonl,
  parseMldrQueriesJsonl,
  parseTrecQrelsTsv,
  parseT2RankingQrelsTsv,
  parseT2RankingQueriesTsv,
  type SciFactEvaluationQuery,
} from './corpus.ts'
import { DEFAULT_RRF_K } from './hybrid.ts'
import { DEFAULT_HNSW_EXPANSION_SEARCH } from './hnsw.ts'
import { loadKnowledgeIndex } from './index-format.ts'
import LocalKnowledgeProvider from './provider.ts'
import { DEFAULT_CANDIDATE_COUNT, DEFAULT_RERANKER_CANDIDATE_COUNT } from './config.ts'
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
  readonly recallAt100: number
  readonly mrrAt10: number
  readonly ndcgAt10: number
  readonly successAt1: number
  readonly successAt5: number
  readonly successAt10: number
  readonly successAt20: number
  readonly successAt100: number
}

/** One completed or failed evaluation configuration. */
export interface EvaluationRun {
  readonly mode: EvaluationMode
  readonly denseIndex?: 'exact' | 'hnsw'
  readonly rerank: boolean
  readonly status: 'success' | 'failed'
  readonly queryCount: number
  readonly error?: string
  readonly metrics?: EvaluationMetrics
  readonly latencyMs?: { readonly p50: number; readonly p95: number }
  readonly approximation?: { readonly recallAt10: number; readonly recallAt100: number }
}

/** Machine-readable result of one fixed dataset evaluation matrix. */
export interface EvaluationReport {
  readonly schemaVersion: 1
  readonly createdAt: string
  readonly dataset: 'scifact' | 'mldr' | 't2ranking' | 'mlqa'
  readonly platform: {
    readonly os: string
    readonly release: string
    readonly arch: string
    readonly node: string
  }
  readonly corpusSha256: string
  readonly indexFingerprint: string
  readonly models: {
    readonly dense?: { readonly modelId: string; readonly revision: string; readonly dtype: 'q8' }
    readonly reranker?: { readonly modelId: string; readonly revision: string; readonly dtype: 'q8' }
  }
  readonly config: {
    readonly candidateCount: number
    readonly rerankerCandidateCount: number
    readonly maxResults: number
    readonly warmupQueries: number
    readonly queryLimit?: number
    readonly modes: readonly EvaluationMode[]
    readonly denseIndexes: readonly ('exact' | 'hnsw')[]
    readonly rerankValues: readonly boolean[]
    readonly bm25Implementation: 'sqlite-fts5'
    readonly rrfK: 60
    readonly chunkMaxTokens: number
    readonly chunkOverlapTokens: number
    readonly denseMaxTokens?: number
    readonly hnswExpansionSearch?: number
    readonly rerankerBatchSize: number
    readonly rerankerMaxTokens: number
    readonly hybridExecution: 'sequential'
  }
  readonly runs: readonly EvaluationRun[]
  readonly build: {
    readonly durationMs: number
    readonly indexBytes: number
    readonly payloadBytes: Readonly<Record<string, number>>
  }
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
  denseIndex: 'exact' | 'hnsw',
) => Promise<EvaluationProvider>

interface RankedDocuments {
  readonly query: SciFactEvaluationQuery
  readonly documentIds: readonly string[]
}

const gunzipAsync = promisify(gunzip)

async function readText(path: string): Promise<string> {
  const data = await readFile(path)
  return (path.endsWith('.gz') ? await gunzipAsync(data) : data).toString('utf8')
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
      recallAt100: recallAt(documentIds, relevant, 100),
      mrrAt10: reciprocalRankAt10(documentIds, relevant),
      ndcgAt10: ndcgAt10(documentIds, judgments),
      successAt1: successAt(documentIds, relevant, 1),
      successAt5: successAt(documentIds, relevant, 5),
      successAt10: successAt(documentIds, relevant, 10),
      successAt20: successAt(documentIds, relevant, 20),
      successAt100: successAt(documentIds, relevant, 100),
    }
  })
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
): Promise<{
  metrics: EvaluationMetrics
  latencyMs: { p50: number; p95: number }
  ranked: readonly RankedDocuments[]
}> {
  for (let index = 0; index < warmupQueries; index += 1) {
    const query = queries[index % queries.length]
    if (query !== undefined) await provider.search(query.text, maxResults)
  }
  const ranked: RankedDocuments[] = []
  const latencies: number[] = []
  for (const query of queries) {
    const startedAt = performance.now()
    const result = await provider.search(query.text, maxResults)
    latencies.push(performance.now() - startedAt)
    ranked.push({ query, documentIds: foldDocuments(result, maxResults) })
  }
  return {
    metrics: calculateMetrics(ranked),
    latencyMs: { p50: nearestRank(latencies, 0.5), p95: nearestRank(latencies, 0.95) },
    ranked,
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
 * @param rerankValues - reranking states to execute.
 * @returns successful or failed run records in stable order.
 */
export async function evaluateMatrix(
  queries: readonly SciFactEvaluationQuery[],
  maxResults: number,
  warmupQueries: number,
  createProvider: EvaluationProviderFactory,
  denseIndexes: readonly ('exact' | 'hnsw')[] = ['exact'],
  modes: readonly EvaluationMode[] = ['bm25', 'dense', 'hybrid'],
  rerankValues: readonly boolean[] = [false, true],
): Promise<EvaluationRun[]> {
  const runs: EvaluationRun[] = []
  const exactRankings = new Map<string, readonly RankedDocuments[]>()
  for (const mode of modes) {
    const indexes = mode === 'bm25' ? ['exact' as const] : denseIndexes
    for (const denseIndex of indexes) for (const rerank of rerankValues) {
      let provider: EvaluationProvider | undefined
      try {
        provider = await createProvider(mode, rerank, denseIndex)
        const result = await evaluateRun(provider, queries, maxResults, warmupQueries)
        const comparisonKey = `${mode}:${String(rerank)}`
        const approximation = denseIndex === 'hnsw' && exactRankings.has(comparisonKey)
          ? {
            recallAt10: approximationRecall(exactRankings.get(comparisonKey) as readonly RankedDocuments[], result.ranked, 10),
            recallAt100: approximationRecall(exactRankings.get(comparisonKey) as readonly RankedDocuments[], result.ranked, 100),
          }
          : undefined
        if (mode !== 'bm25' && denseIndex === 'exact') exactRankings.set(comparisonKey, result.ranked)
        runs.push({
          mode,
          ...(mode === 'bm25' ? {} : { denseIndex }),
          rerank,
          status: 'success',
          queryCount: queries.length,
          metrics: result.metrics,
          latencyMs: result.latencyMs,
          ...(approximation === undefined ? {} : { approximation }),
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

/** Inputs for one complete local retrieval-dataset evaluation. */
export interface EvaluateDatasetOptions {
  readonly indexDir: string
  readonly queriesPath: string
  readonly qrelsPath: string
  readonly modelCacheDir: string
  readonly maxResults: number
  readonly candidateCount?: number
  readonly rerankerCandidateCount?: number
  readonly warmupQueries: number
  readonly dataset?: 'scifact' | 'mldr' | 't2ranking' | 'mlqa'
  readonly queryLimit?: number
  readonly modes?: readonly EvaluationMode[]
  readonly denseIndexes?: readonly ('exact' | 'hnsw')[]
  readonly rerankValues?: readonly boolean[]
  readonly hnswExpansionSearch?: number
}

/**
 * Load one index and run a reproducible dataset evaluation matrix.
 * @param options - explicit index, test split, cache, and report limits.
 * @returns complete report ready for JSON serialization.
 */
export async function evaluateDataset(options: EvaluateDatasetOptions): Promise<EvaluationReport> {
  if (!Number.isSafeInteger(options.maxResults) || options.maxResults < 20 || options.maxResults > 100) {
    throw new TypeError('knowledge-local: maxResults must be an integer from 20 through 100')
  }
  const candidateCount = options.candidateCount ?? Math.max(DEFAULT_CANDIDATE_COUNT, options.maxResults)
  if (!Number.isSafeInteger(candidateCount) || candidateCount < options.maxResults) {
    throw new TypeError('knowledge-local: candidateCount must be a safe integer no smaller than maxResults')
  }
  const rerankerCandidateCount = Math.min(
    options.rerankerCandidateCount ?? DEFAULT_RERANKER_CANDIDATE_COUNT,
    candidateCount,
  )
  if (!Number.isSafeInteger(rerankerCandidateCount) || rerankerCandidateCount < 1) {
    throw new TypeError('knowledge-local: rerankerCandidateCount must be a positive safe integer')
  }
  if (!Number.isSafeInteger(options.warmupQueries) || options.warmupQueries < 0) {
    throw new TypeError('knowledge-local: warmupQueries must be a non-negative safe integer')
  }
  if (options.queryLimit !== undefined && (!Number.isSafeInteger(options.queryLimit) || options.queryLimit < 1)) {
    throw new TypeError('knowledge-local: queryLimit must be a positive safe integer')
  }
  const hnswExpansionSearch = options.hnswExpansionSearch ?? DEFAULT_HNSW_EXPANSION_SEARCH
  if (!Number.isSafeInteger(hnswExpansionSearch) || hnswExpansionSearch < 1) {
    throw new TypeError('knowledge-local: hnswExpansionSearch must be a positive safe integer')
  }
  const modes = options.modes ?? ['bm25', 'dense', 'hybrid']
  const rerankValues = options.rerankValues ?? [false, true]
  if (modes.length === 0) throw new TypeError('knowledge-local: modes must not be empty')
  if (options.denseIndexes?.length === 0 && modes.some(mode => mode !== 'bm25')) {
    throw new TypeError('knowledge-local: denseIndexes must not be empty when Dense retrieval is evaluated')
  }
  if (rerankValues.length === 0) throw new TypeError('knowledge-local: rerankValues must not be empty')
  const index = await loadKnowledgeIndex(options.indexDir)
  const denseRequired = modes.some(mode => mode !== 'bm25')
  const denseIndexes = denseRequired
    ? options.denseIndexes ?? [
      ...(index.dense === undefined ? [] : ['exact' as const]),
      ...(index.hnsw === undefined ? [] : ['hnsw' as const]),
    ]
    : []
  const denseManifest = index.manifest.dense
  let queryText: string
  let documentIds: string[]
  try {
    if (denseRequired && denseManifest === undefined) {
      throw new TypeError('knowledge-local: evaluation index must contain Dense embeddings')
    }
    queryText = await readText(options.queriesPath)
    documentIds = index.sqlite.documentIds()
  } finally {
    index.sqlite.close()
  }
  const dataset = options.dataset ?? 'scifact'
  const queries = dataset === 'scifact' || dataset === 'mlqa'
    ? parseSciFactQueriesJsonl(queryText, options.queriesPath)
    : dataset === 'mldr'
      ? parseMldrQueriesJsonl(queryText, options.queriesPath)
      : parseT2RankingQueriesTsv(queryText, options.queriesPath)
  const qrelsText = await readText(options.qrelsPath)
  const allEvaluationQueries = dataset === 'scifact' || dataset === 'mlqa'
    ? parseSciFactQrelsTsv(
      qrelsText,
      queries,
      documentIds.map(id => ({ id: KnowledgeDocumentId(id), text: 'indexed' })),
      options.qrelsPath,
    )
    : dataset === 'mldr'
      ? parseTrecQrelsTsv(qrelsText, queries, new Set(documentIds), options.qrelsPath)
      : parseT2RankingQrelsTsv(qrelsText, queries, new Set(documentIds), options.qrelsPath)
  if (allEvaluationQueries.length === 0) throw new TypeError(`knowledge-local: ${dataset} qrels contain no evaluation queries`)
  const evaluationQueries = options.queryLimit === undefined
    ? allEvaluationQueries
    : allEvaluationQueries.slice(0, options.queryLimit)
  const createProvider: EvaluationProviderFactory = async (mode, rerank, denseIndex) => {
    const context = new Context()
    try {
      await context.plugin(LocalKnowledgeProvider, {
        indexDir: options.indexDir,
        defaultRetrieval: mode,
        defaultDenseIndex: denseIndex,
        defaultRerank: rerank ? 'on' : 'off',
        allowedRetrieval: [mode],
        allowedDenseIndexes: [denseIndex],
        allowedRerank: rerank,
        candidateCount,
        rerankerCandidateCount,
        modelCacheDir: options.modelCacheDir,
        ...(denseManifest === undefined ? {} : {
          denseModelId: denseManifest.modelId,
          denseModelRevision: denseManifest.revision,
          denseModelFile: denseManifest.modelFile,
          denseDimensions: denseManifest.dimensions,
          denseQueryPrefix: denseManifest.queryPrefix,
          denseMaxTokens: denseManifest.maxTokens,
        }),
        hnswExpansionSearch,
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
    dataset,
    platform: { os: platform(), release: release(), arch: arch(), node: process.version },
    corpusSha256: index.manifest.corpus.sha256,
    indexFingerprint: createHash('sha256').update(manifestText).digest('hex'),
    models: {
      ...(denseManifest === undefined ? {} : { dense: {
        modelId: denseManifest.modelId,
        revision: denseManifest.revision,
        dtype: denseManifest.dtype,
      } }),
      ...(rerankValues.includes(true) ? { reranker: {
        modelId: BGE_RERANKER_MODEL_ID,
        revision: BGE_RERANKER_REVISION,
        dtype: BGE_RERANKER_DTYPE,
      } } : {}),
    },
    config: {
      candidateCount,
      rerankerCandidateCount,
      maxResults: options.maxResults,
      warmupQueries: options.warmupQueries,
      ...(options.queryLimit === undefined ? {} : { queryLimit: options.queryLimit }),
      modes,
      denseIndexes,
      rerankValues,
      bm25Implementation: index.manifest.bm25.implementation,
      rrfK: DEFAULT_RRF_K,
      chunkMaxTokens: index.manifest.chunking.maxTokens,
      chunkOverlapTokens: index.manifest.chunking.overlapTokens,
      ...(denseManifest === undefined ? {} : {
        denseMaxTokens: denseManifest.maxTokens,
        hnswExpansionSearch,
      }),
      rerankerBatchSize: DEFAULT_RERANKER_BATCH_SIZE,
      rerankerMaxTokens: DEFAULT_RERANKER_MAX_TOKENS,
      hybridExecution: 'sequential',
    },
    runs: await evaluateMatrix(
      evaluationQueries,
      options.maxResults,
      options.warmupQueries,
      createProvider,
      denseIndexes,
      modes,
      rerankValues,
    ),
    build: {
      durationMs: index.manifest.build.durationMs,
      indexBytes: await directoryBytes(options.indexDir),
      payloadBytes: Object.fromEntries(index.manifest.payloads.map(payload => [payload.path, payload.bytes])),
    },
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
    `# ${report.dataset} RAG Evaluation`,
    '',
    `Created: ${report.createdAt}`,
    '',
    '| Mode | Dense index | Rerank | Status | Recall@1 | Recall@5 | Recall@10 | Recall@20 | Recall@100 | MRR@10 | nDCG@10 | Success@1 | Success@5 | Success@10 | Success@20 | Success@100 | ANN recall@10 | ANN recall@100 | p50 ms | p95 ms |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const run of report.runs) {
    if (run.status === 'failed' || run.metrics === undefined || run.latencyMs === undefined) {
      lines.push(`| ${run.mode} | ${run.denseIndex ?? '—'} | ${String(run.rerank)} | failed: ${tableCell(run.error ?? 'unknown error')} | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |`)
      continue
    }
    lines.push(`| ${run.mode} | ${run.denseIndex ?? '—'} | ${String(run.rerank)} | success | ${percentage(run.metrics.recallAt1)} | ${percentage(run.metrics.recallAt5)} | ${percentage(run.metrics.recallAt10)} | ${percentage(run.metrics.recallAt20)} | ${percentage(run.metrics.recallAt100)} | ${percentage(run.metrics.mrrAt10)} | ${percentage(run.metrics.ndcgAt10)} | ${percentage(run.metrics.successAt1)} | ${percentage(run.metrics.successAt5)} | ${percentage(run.metrics.successAt10)} | ${percentage(run.metrics.successAt20)} | ${percentage(run.metrics.successAt100)} | ${run.approximation === undefined ? '—' : percentage(run.approximation.recallAt10)} | ${run.approximation === undefined ? '—' : percentage(run.approximation.recallAt100)} | ${run.latencyMs.p50.toFixed(2)} | ${run.latencyMs.p95.toFixed(2)} |`)
  }
  lines.push('', `Index bytes: ${report.build.indexBytes}`)
  for (const [path, bytes] of Object.entries(report.build.payloadBytes)) lines.push(`- ${path}: ${bytes}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}
