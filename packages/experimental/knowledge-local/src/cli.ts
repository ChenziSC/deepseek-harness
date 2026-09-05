/** Argument handling for the experimental `dsh-knowledge` command. */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import {
  buildKnowledgeIndex,
  type BuildDenseIndexOptions,
  type DenseIndexBuildPlan,
  type DenseIndexMode,
} from './index-builder.ts'
import { verifyKnowledgeIndex, type KnowledgeIndexManifest } from './index-format.ts'
import { evaluateDataset, renderEvaluationReport } from './evaluation.ts'
import {
  BGE_DENSE_DTYPE,
  BGE_DENSE_MODEL_FILE,
  BGE_QUERY_PREFIX,
  DEFAULT_DENSE_MAX_TOKENS,
  loadDenseEncoder,
} from './model-runtime.ts'
import { prepareMldr, prepareMlqaEngZho, prepareSciFact, prepareT2Ranking } from './prepare.ts'
import { DENSE_DIMENSIONS } from './dense.ts'
import {
  DEFAULT_HNSW_CONNECTIVITY,
  DEFAULT_HNSW_EXPANSION_ADD,
  DEFAULT_HNSW_EXPANSION_SEARCH,
} from './hnsw.ts'
import { DEFAULT_EXACT_SCAN_MAX_ELEMENTS } from './index-builder.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION, loadBgeChunkTokenizer } from './tokenizer.ts'
import { DEFAULT_CANDIDATE_COUNT, DEFAULT_RERANKER_CANDIDATE_COUNT } from './config.ts'

const HELP = `Usage: dsh-knowledge <command> [options]

Commands:
  prepare   Prepare a fixed benchmark dataset
  index     Build an immutable local index
  evaluate  Run the fixed retrieval evaluations
  verify    Recompute and validate every index payload hash`

function required(value: string | undefined, option: string): string {
  if (value === undefined || value.trim().length === 0) throw new TypeError(`--${option} is required`)
  return value
}

function numberOption(value: string | undefined, option: string): number {
  const parsed = Number(required(value, option))
  if (!Number.isFinite(parsed)) throw new TypeError(`--${option} must be a finite number`)
  return parsed
}

function listOption<T extends string>(value: string, option: string, allowed: readonly T[]): T[] {
  const items = value.split(',')
  if (items.some(item => !allowed.includes(item as T))) {
    throw new TypeError(`--${option} must be a comma-separated subset of ${allowed.join(',')}`)
  }
  return [...new Set(items as T[])]
}

interface CliInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean
}

interface CliOutput extends Pick<NodeJS.WriteStream, 'write'> {
  readonly isTTY?: boolean
}

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

async function runIndex(
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
      corpus: { type: 'string' },
      'corpus-format': { type: 'string', default: 'generic' },
      output: { type: 'string' },
      'model-cache-dir': { type: 'string' },
      components: { type: 'string', default: 'bm25' },
      'max-tokens': { type: 'string', default: '384' },
      'overlap-tokens': { type: 'string', default: '64' },
      'sqlite-batch-size': { type: 'string', default: '500' },
      analyzer: { type: 'string', default: 'mixed-zh-en-v1' },
      'dense-model-id': { type: 'string', default: BGE_M3_MODEL_ID },
      'dense-model-revision': { type: 'string', default: BGE_M3_REVISION },
      'dense-max-tokens': { type: 'string', default: String(DEFAULT_DENSE_MAX_TOKENS) },
      'embedding-batch-size': { type: 'string', default: '32' },
      'dense-index': { type: 'string', default: 'auto' },
      'exact-scan-max-elements': { type: 'string', default: String(DEFAULT_EXACT_SCAN_MAX_ELEMENTS) },
      connectivity: { type: 'string', default: String(DEFAULT_HNSW_CONNECTIVITY) },
      'expansion-add': { type: 'string', default: String(DEFAULT_HNSW_EXPANSION_ADD) },
    },
  })
  if (values.components !== 'bm25' && values.components !== 'bm25,dense') {
    throw new TypeError('--components must be bm25 or bm25,dense')
  }
  if (
    values['corpus-format'] !== 'generic'
    && values['corpus-format'] !== 'scifact'
    && values['corpus-format'] !== 'mldr'
    && values['corpus-format'] !== 't2ranking'
  ) {
    throw new TypeError('--corpus-format must be generic, scifact, mldr, or t2ranking')
  }
  if (values.analyzer !== 'english-v1' && values.analyzer !== 'mixed-zh-en-v1') {
    throw new TypeError('--analyzer must be english-v1 or mixed-zh-en-v1')
  }
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
  const denseModelId = denseEnabled ? required(values['dense-model-id'], 'dense-model-id') : BGE_M3_MODEL_ID
  const denseModelRevision = denseEnabled
    ? required(values['dense-model-revision'], 'dense-model-revision')
    : BGE_M3_REVISION
  const tokenizer = await loadBgeChunkTokenizer({
    cacheDir: modelCacheDir,
    localFilesOnly: true,
    modelId: denseModelId,
    revision: denseModelRevision,
  })
  let encoder: Awaited<ReturnType<typeof loadDenseEncoder>> | undefined
  const getEncoder = async () => {
    encoder ??= await loadDenseEncoder({
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
    return encoder
  }
  const dense: BuildDenseIndexOptions | undefined = !denseEnabled
    ? undefined
    : {
      encoder: { embedDocuments: texts => getEncoder().then(value => value.embedDocuments(texts)) },
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
      ...(values['dense-index'] === 'auto' && stdin.isTTY === true && stdout.isTTY === true
        ? { selectIndex: (plan: DenseIndexBuildPlan) => confirmDenseIndex(plan, stdin, stdout, stderr) }
        : {}),
    }
  let manifest: KnowledgeIndexManifest
  try {
    manifest = await buildKnowledgeIndex({
      corpusPath,
      corpusSource: corpusPath,
      corpusFormat: values['corpus-format'],
      outputDir,
      analyzer: values.analyzer,
      tokenizer,
      chunking: {
        maxTokens: numberOption(values['max-tokens'], 'max-tokens'),
        overlapTokens: numberOption(values['overlap-tokens'], 'overlap-tokens'),
      },
      sqliteBatchSize: numberOption(values['sqlite-batch-size'], 'sqlite-batch-size'),
      tokenizerModelId: denseModelId,
      tokenizerRevision: denseModelRevision,
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
    ...(manifest.dense === undefined ? {} : {
      denseIndex: manifest.dense.resolvedIndex,
      recommendedDenseIndex: manifest.dense.recommendedIndex,
    }),
  })}\n`)
  return 0
}

async function runPrepare(argv: readonly string[], stdout: Pick<NodeJS.WriteStream, 'write'>): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      'data-dir': { type: 'string' },
      'model-cache-dir': { type: 'string' },
      language: { type: 'string' },
      'hf-endpoint': { type: 'string', default: process.env['HF_ENDPOINT'] ?? 'https://huggingface.co' },
    },
  })
  if (positionals.length !== 1) throw new TypeError('prepare requires one dataset name')
  const dataset = positionals[0]
  const dataDir = required(values['data-dir'], 'data-dir')
  const result = dataset === 'scifact'
    ? await prepareSciFact(dataDir, required(values['model-cache-dir'], 'model-cache-dir'))
    : dataset === 'mldr'
      ? values.language === 'en' || values.language === 'zh'
        ? await prepareMldr(dataDir, values.language, values['hf-endpoint'])
        : (() => { throw new TypeError('prepare mldr requires --language en or zh') })()
      : dataset === 't2ranking'
        ? await prepareT2Ranking(dataDir, values['hf-endpoint'])
        : dataset === 'mlqa-eng-zho'
          ? await prepareMlqaEngZho(dataDir, values['hf-endpoint'])
          : (() => { throw new TypeError('prepare dataset must be scifact, mldr, t2ranking, or mlqa-eng-zho') })()
  stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}

async function prepareReportDirectory(outputDir: string): Promise<void> {
  try {
    if ((await readdir(outputDir)).length > 0) {
      throw new TypeError(`knowledge-local: report output directory is not empty: ${outputDir}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(outputDir, { recursive: true })
  }
}

async function runEvaluate(argv: readonly string[], stdout: Pick<NodeJS.WriteStream, 'write'>): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      index: { type: 'string' },
      queries: { type: 'string' },
      qrels: { type: 'string' },
      'model-cache-dir': { type: 'string' },
      'max-results': { type: 'string', default: '20' },
      'candidate-count': { type: 'string', default: String(DEFAULT_CANDIDATE_COUNT) },
      'reranker-candidate-count': { type: 'string', default: String(DEFAULT_RERANKER_CANDIDATE_COUNT) },
      'warmup-queries': { type: 'string', default: '10' },
      output: { type: 'string' },
      dataset: { type: 'string', default: 'scifact' },
      'query-limit': { type: 'string' },
      modes: { type: 'string', default: 'bm25,dense,hybrid' },
      'dense-indexes': { type: 'string' },
      rerank: { type: 'string', default: 'off,on' },
      'expansion-search': { type: 'string', default: String(DEFAULT_HNSW_EXPANSION_SEARCH) },
    },
  })
  const indexDir = required(values.index, 'index')
  const queriesPath = required(values.queries, 'queries')
  const qrelsPath = required(values.qrels, 'qrels')
  const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
  const outputDir = required(values.output, 'output')
  if (values.dataset !== 'scifact' && values.dataset !== 'mldr' && values.dataset !== 't2ranking' && values.dataset !== 'mlqa') {
    throw new TypeError('--dataset must be scifact, mldr, t2ranking, or mlqa')
  }
  await prepareReportDirectory(outputDir)
  const report = await evaluateDataset({
    indexDir,
    queriesPath,
    qrelsPath,
    modelCacheDir,
    maxResults: numberOption(values['max-results'], 'max-results'),
    candidateCount: numberOption(values['candidate-count'], 'candidate-count'),
    rerankerCandidateCount: numberOption(values['reranker-candidate-count'], 'reranker-candidate-count'),
    warmupQueries: numberOption(values['warmup-queries'], 'warmup-queries'),
    dataset: values.dataset,
    ...(values['query-limit'] === undefined
      ? {}
      : { queryLimit: numberOption(values['query-limit'], 'query-limit') }),
    modes: listOption(values.modes, 'modes', ['bm25', 'dense', 'hybrid'] as const),
    ...(values['dense-indexes'] === undefined
      ? {}
      : { denseIndexes: listOption(values['dense-indexes'], 'dense-indexes', ['exact', 'hnsw'] as const) }),
    rerankValues: listOption(values.rerank, 'rerank', ['off', 'on'] as const).map(value => value === 'on'),
    hnswExpansionSearch: numberOption(values['expansion-search'], 'expansion-search'),
  })
  const jsonPath = join(outputDir, 'report.json')
  const markdownPath = join(outputDir, 'report.md')
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  await writeFile(markdownPath, renderEvaluationReport(report), { flag: 'wx' })
  const failedRuns = report.runs.filter(run => run.status === 'failed').length
  stdout.write(`${JSON.stringify({ report: jsonPath, markdown: markdownPath, failedRuns })}\n`)
  return failedRuns === 0 ? 0 : 2
}

async function runVerify(argv: readonly string[], stdout: Pick<NodeJS.WriteStream, 'write'>): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: { index: { type: 'string' } },
  })
  const indexDir = required(values.index, 'index')
  const manifest = await verifyKnowledgeIndex(indexDir)
  stdout.write(`${JSON.stringify({
    index: indexDir,
    payloads: manifest.payloads.map(payload => ({ path: payload.path, bytes: payload.bytes, sha256: payload.sha256 })),
  })}\n`)
  return 0
}

/**
 * Execute the CLI and return its process exit code.
 * @param argv - arguments after the executable name.
 * @param stdout - destination for help and successful summaries.
 * @param stderr - destination for validation and execution failures.
 * @param stdin - source for interactive Dense index selection.
 * @returns zero on success or two for invalid or failed commands.
 */
export async function runCli(
  argv: readonly string[],
  stdout: CliOutput,
  stderr: CliOutput,
  stdin: CliInput = process.stdin,
): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      stdout.write(`${HELP}\n`)
      return 0
    }
    const [command, ...options] = argv
    if (command === 'prepare') return await runPrepare(options, stdout)
    if (command === 'index') return await runIndex(options, stdin, stdout, stderr)
    if (command === 'evaluate') return await runEvaluate(options, stdout)
    if (command === 'verify') return await runVerify(options, stdout)
    stderr.write(`dsh-knowledge: unknown command "${command}"\n`)
    return 2
  } catch (error) {
    stderr.write(`dsh-knowledge: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}
