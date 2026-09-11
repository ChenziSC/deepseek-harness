/** Load a fixed dataset and assemble one reproducible retrieval evaluation report. */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { KnowledgeDocumentId, type KnowledgeRerank } from '@deepseek-ai/dsh-experimental-knowledge'
import {
  DEFAULT_ADAPTIVE_RERANK_MIN_SCORE_GAP_RATIO,
  DEFAULT_CANDIDATE_COUNT,
  DEFAULT_RERANKER_CANDIDATE_COUNT,
} from '../../config.ts'
import {
  parseMldrQueriesJsonl,
  parseSciFactQrelsTsv,
  parseSciFactQueriesJsonl,
  parseT2RankingQrelsTsv,
  parseT2RankingQueriesTsv,
  parseTrecQrelsTsv,
} from '../../corpus.ts'
import { DEFAULT_RRF_K } from '../../hybrid.ts'
import { DEFAULT_HNSW_EXPANSION_SEARCH } from '../../hnsw.ts'
import { loadKnowledgeIndex } from '../../index-format.ts'
import LocalKnowledgeProvider from '../../provider.ts'
import {
  BGE_RERANKER_DTYPE,
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  DEFAULT_RERANKER_BATCH_SIZE,
  DEFAULT_RERANKER_MAX_TOKENS,
} from '../../reranker.ts'
import { evaluateMatrix } from './matrix.ts'
import type {
  EvaluationMode,
  EvaluationProviderFactory,
  EvaluationQueryDetailSink,
  EvaluationReport,
} from './types.ts'

const gunzipAsync = promisify(gunzip)

async function readText(path: string): Promise<string> {
  const data = await readFile(path)
  return (path.endsWith('.gz') ? await gunzipAsync(data) : data).toString('utf8')
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
  readonly adaptiveRerankMinScoreGapRatio?: number
  readonly warmupQueries: number
  readonly dataset?: 'scifact' | 'mldr' | 't2ranking' | 'mlqa'
  readonly queryLimit?: number
  readonly modes?: readonly EvaluationMode[]
  readonly denseIndexes?: readonly ('exact' | 'hnsw')[]
  readonly rerankValues?: readonly KnowledgeRerank[]
  readonly hnswExpansionSearch?: number
  readonly onQueryDetail?: EvaluationQueryDetailSink
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
  const adaptiveRerankMinScoreGapRatio = options.adaptiveRerankMinScoreGapRatio
    ?? DEFAULT_ADAPTIVE_RERANK_MIN_SCORE_GAP_RATIO
  if (!Number.isSafeInteger(rerankerCandidateCount) || rerankerCandidateCount < 1) {
    throw new TypeError('knowledge-local: rerankerCandidateCount must be a positive safe integer')
  }
  if (
    !Number.isFinite(adaptiveRerankMinScoreGapRatio)
    || adaptiveRerankMinScoreGapRatio < 0
    || adaptiveRerankMinScoreGapRatio > 1
  ) throw new TypeError('knowledge-local: adaptiveRerankMinScoreGapRatio must be from 0 through 1')
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
  const rerankValues = options.rerankValues ?? ['off', 'auto', 'on']
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
        defaultRerank: 'off',
        allowedRetrieval: mode === 'auto' ? ['bm25', 'dense', 'hybrid'] : [mode],
        allowedDenseIndexes: [denseIndex],
        allowedRerank: rerank !== 'off',
        candidateCount,
        rerankerCandidateCount,
        adaptiveRerankMinScoreGapRatio,
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
      search: (query, maxResults) => context.knowledge.search({
        query,
        maxResults,
        strategy: {
          retrieval: mode,
          ...(mode === 'dense' || mode === 'hybrid' ? { denseIndex } : {}),
          rerank,
        },
      }),
      dispose: () => context.fiber.dispose(),
    }
  }
  const manifestText = await readFile(join(options.indexDir, 'manifest.json'))
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    dataset,
    platform: { os: platform(), release: release(), arch: arch(), node: process.version },
    corpusSha256: index.manifest.corpus.sha256,
    indexFingerprint: createHash('sha256').update(manifestText).digest('hex'),
    inputs: {
      queriesSha256: createHash('sha256').update(queryText).digest('hex'),
      qrelsSha256: createHash('sha256').update(qrelsText).digest('hex'),
    },
    models: {
      ...(denseManifest === undefined ? {} : { dense: {
        modelId: denseManifest.modelId,
        revision: denseManifest.revision,
        dtype: denseManifest.dtype,
      } }),
      ...(rerankValues.some(value => value !== 'off') ? { reranker: {
        modelId: BGE_RERANKER_MODEL_ID,
        revision: BGE_RERANKER_REVISION,
        dtype: BGE_RERANKER_DTYPE,
      } } : {}),
    },
    config: {
      candidateCount,
      rerankerCandidateCount,
      adaptiveRerankMinScoreGapRatio,
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
      options.onQueryDetail,
    ),
    build: {
      durationMs: index.manifest.build.durationMs,
      indexBytes: await directoryBytes(options.indexDir),
      payloadBytes: Object.fromEntries(index.manifest.payloads.map(payload => [payload.path, payload.bytes])),
    },
  }
}
