/** Build-index command adaptation for `dsh-knowledge`. */

import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { DEFAULT_EXACT_SCAN_MAX_ELEMENTS } from '../build/dense-payload.ts'
import type {
  BuildDenseIndexOptions,
  DenseIndexBuildPlan,
  DenseIndexMode,
  DenseVectorBuildStats,
  KnowledgeIndexBuildStats,
} from '../build/types.ts'
import { DENSE_DIMENSIONS } from '../dense.ts'
import {
  DEFAULT_HNSW_CONNECTIVITY,
  DEFAULT_HNSW_EXPANSION_ADD,
} from '../hnsw.ts'
import { buildKnowledgeIndex } from '../index-builder.ts'
import type { KnowledgeIndexManifest } from '../index-format.ts'
import {
  BGE_DENSE_DTYPE,
  BGE_DENSE_MODEL_FILE,
  BGE_QUERY_PREFIX,
  DEFAULT_DENSE_MAX_TOKENS,
  loadDenseEncoder,
} from '../model-runtime.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION, loadBgeChunkTokenizer } from '../tokenizer.ts'
import {
  CORPUS_CHUNKING_OPTIONS,
  chunkingStrategy,
  corpusFormat,
  numberOption,
  required,
  type CliInput,
  type CliOutput,
} from './options.ts'

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

async function confirmDenseIndex(
  plan: DenseIndexBuildPlan,
  stdin: CliInput,
  stdout: CliOutput,
  stderr: CliOutput,
): Promise<DenseIndexMode> {
  stdout.write(`${JSON.stringify({ event: 'dense-index-plan', ...plan })}\n`)
  stderr.write([
    `Dense build plan: ${plan.documentCount} documents, ${plan.chunkCount} chunks, ${plan.dimensions} dimensions.`,
    `Recommendation: ${plan.recommendedIndex} (${plan.scanElements.toLocaleString('en-US')} scan elements; threshold ${plan.exactScanMaxElements.toLocaleString('en-US')}).`,
    `Estimated payloads: Exact ${formatBytes(plan.estimatedExactBytes)}, HNSW ${formatBytes(plan.estimatedHnswBytes)}, Both ${formatBytes(plan.estimatedBothBytes)}.`,
    `Choose [Enter=${plan.recommendedIndex}, e=exact, h=hnsw, b=both, c=cancel]: `,
  ].join('\n'))
  const lines = createInterface({ input: stdin, crlfDelay: Infinity })
  try {
    const answer = await new Promise<string | undefined>((resolve) => {
      lines.once('line', resolve)
      lines.once('close', () => {
        resolve(undefined)
      })
    })
    const choice = answer?.trim().toLowerCase() ?? 'c'
    if (choice === '') return plan.recommendedIndex
    if (choice === 'e' || choice === 'exact') return 'exact'
    if (choice === 'h' || choice === 'hnsw') return 'hnsw'
    if (choice === 'b' || choice === 'both') return 'both'
    if (choice === 'c' || choice === 'cancel') throw new TypeError('Dense index build was cancelled')
    throw new TypeError('Dense index choice must be exact, hnsw, both, or cancel')
  } finally {
    lines.close()
  }
}

/** Build one immutable BM25 or BM25-plus-Dense index. */
export async function runIndex(
  argv: readonly string[],
  stdin: CliInput,
  stdout: CliOutput,
  stderr: CliOutput,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      ...CORPUS_CHUNKING_OPTIONS,
      components: { type: 'string', default: 'bm25' },
      'sqlite-batch-size': { type: 'string', default: '500' },
      'derived-cache-dir': { type: 'string' },
      analyzer: { type: 'string', default: 'mixed-zh-en-v1' },
      'dense-model-id': { type: 'string', default: BGE_M3_MODEL_ID },
      'dense-model-revision': { type: 'string', default: BGE_M3_REVISION },
      'dense-max-tokens': { type: 'string', default: String(DEFAULT_DENSE_MAX_TOKENS) },
      'embedding-batch-size': { type: 'string', default: '32' },
      'vector-cache-dir': { type: 'string' },
      'import-vectors-from': { type: 'string' },
      'dense-index': { type: 'string', default: 'auto' },
      'exact-scan-max-elements': { type: 'string', default: String(DEFAULT_EXACT_SCAN_MAX_ELEMENTS) },
      connectivity: { type: 'string', default: String(DEFAULT_HNSW_CONNECTIVITY) },
      'expansion-add': { type: 'string', default: String(DEFAULT_HNSW_EXPANSION_ADD) },
    },
  })
  if (values.components !== 'bm25' && values.components !== 'bm25,dense') {
    throw new TypeError('--components must be bm25 or bm25,dense')
  }
  const format = corpusFormat(values['corpus-format'])
  if (values.analyzer !== 'english-v1' && values.analyzer !== 'mixed-zh-en-v1') {
    throw new TypeError('--analyzer must be english-v1 or mixed-zh-en-v1')
  }
  const strategy = chunkingStrategy(values['chunking-strategy'])
  if (
    values['dense-index'] !== 'auto'
    && values['dense-index'] !== 'exact'
    && values['dense-index'] !== 'hnsw'
    && values['dense-index'] !== 'both'
  ) {
    throw new TypeError('--dense-index must be auto, exact, hnsw, or both')
  }
  const corpusPath = required(values.corpus, 'corpus')
  const outputDir = required(values.output, 'output')
  const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
  const denseEnabled = values.components === 'bm25,dense'
  if (!denseEnabled && (values['vector-cache-dir'] !== undefined || values['import-vectors-from'] !== undefined)) {
    throw new TypeError('--vector-cache-dir and --import-vectors-from require --components bm25,dense')
  }
  if (values['import-vectors-from'] !== undefined && values['vector-cache-dir'] === undefined) {
    throw new TypeError('--import-vectors-from requires --vector-cache-dir')
  }
  const denseModelId = denseEnabled ? required(values['dense-model-id'], 'dense-model-id') : BGE_M3_MODEL_ID
  const denseModelRevision = denseEnabled
    ? required(values['dense-model-revision'], 'dense-model-revision')
    : BGE_M3_REVISION
  const maxTokens = numberOption(values['max-tokens'], 'max-tokens')
  const overlapTokens = numberOption(values['overlap-tokens'], 'overlap-tokens')
  const tokenizer = await loadBgeChunkTokenizer({
    cacheDir: modelCacheDir,
    localFilesOnly: true,
    modelId: denseModelId,
    revision: denseModelRevision,
  })
  let encoder: Awaited<ReturnType<typeof loadDenseEncoder>> | undefined
  let modelLoadMs = 0
  let modelEmbeddingMs = 0
  const getEncoder = async () => {
    if (encoder === undefined) {
      const startedAt = performance.now()
      encoder = await loadDenseEncoder({
        cacheDir: modelCacheDir,
        localFilesOnly: true,
        modelId: denseModelId,
        revision: denseModelRevision,
        dtype: BGE_DENSE_DTYPE,
        modelFile: BGE_DENSE_MODEL_FILE,
        dimensions: DENSE_DIMENSIONS,
        maxTokens: numberOption(values['dense-max-tokens'], 'dense-max-tokens'),
        queryPrefix: BGE_QUERY_PREFIX,
      })
      modelLoadMs = performance.now() - startedAt
    }
    return encoder
  }
  let vectorBuildStats: DenseVectorBuildStats | undefined
  let indexBuildStats: KnowledgeIndexBuildStats | undefined
  const dense: BuildDenseIndexOptions | undefined = !denseEnabled
    ? undefined
    : {
      encoder: {
        async embedDocuments(texts) {
          const value = await getEncoder()
          const startedAt = performance.now()
          try {
            return await value.embedDocuments(texts)
          } finally {
            modelEmbeddingMs += performance.now() - startedAt
          }
        },
      },
      batchSize: numberOption(values['embedding-batch-size'], 'embedding-batch-size'),
      modelId: denseModelId,
      revision: denseModelRevision,
      dtype: BGE_DENSE_DTYPE,
      modelFile: BGE_DENSE_MODEL_FILE,
      dimensions: DENSE_DIMENSIONS,
      maxTokens: numberOption(values['dense-max-tokens'], 'dense-max-tokens'),
      queryPrefix: BGE_QUERY_PREFIX,
      denseIndex: values['dense-index'],
      exactScanMaxElements: numberOption(values['exact-scan-max-elements'], 'exact-scan-max-elements'),
      connectivity: numberOption(values.connectivity, 'connectivity'),
      expansionAdd: numberOption(values['expansion-add'], 'expansion-add'),
      ...(values['vector-cache-dir'] === undefined
        ? {}
        : { vectorCacheDir: required(values['vector-cache-dir'], 'vector-cache-dir') }),
      ...(values['import-vectors-from'] === undefined
        ? {}
        : { importVectorsFrom: required(values['import-vectors-from'], 'import-vectors-from') }),
      onVectorBuildStats(stats) {
        vectorBuildStats = stats
      },
      ...(values['dense-index'] === 'auto' && stdin.isTTY === true && stdout.isTTY === true
        ? { selectIndex: (plan: DenseIndexBuildPlan) => confirmDenseIndex(plan, stdin, stdout, stderr) }
        : {}),
    }
  let manifest: KnowledgeIndexManifest
  try {
    manifest = await buildKnowledgeIndex({
      corpusPath,
      corpusSource: corpusPath,
      corpusFormat: format,
      outputDir,
      analyzer: values.analyzer,
      tokenizer,
      chunking: {
        maxTokens,
        overlapTokens,
        strategy,
      },
      sqliteBatchSize: numberOption(values['sqlite-batch-size'], 'sqlite-batch-size'),
      tokenizerModelId: denseModelId,
      tokenizerRevision: denseModelRevision,
      ...(values['derived-cache-dir'] === undefined
        ? {}
        : { derivedCacheDir: required(values['derived-cache-dir'], 'derived-cache-dir') }),
      onBuildStats(stats) {
        indexBuildStats = stats
      },
      ...(dense === undefined ? {} : { dense }),
    })
  } finally {
    await encoder?.dispose()
  }
  stdout.write(`${JSON.stringify({
    manifest: join(outputDir, 'manifest.json'),
    corpusSha256: manifest.corpus.sha256,
    documentCount: manifest.corpus.documentCount,
    chunkCount: manifest.corpus.chunkCount,
    durationMs: manifest.build.durationMs,
    payloadBytes: manifest.payloads.reduce((sum, payload) => sum + payload.bytes, 0),
    ...(indexBuildStats === undefined ? {} : { documentBuild: indexBuildStats }),
    ...(manifest.dense === undefined ? {} : {
      denseIndex: manifest.dense.resolvedIndex,
      recommendedDenseIndex: manifest.dense.recommendedIndex,
    }),
    ...(vectorBuildStats === undefined ? {} : {
      denseBuild: {
        ...vectorBuildStats,
        timingsMs: { ...vectorBuildStats.timingsMs, embedding: modelEmbeddingMs, modelLoad: modelLoadMs },
      },
    }),
  })}\n`)
  return 0
}
