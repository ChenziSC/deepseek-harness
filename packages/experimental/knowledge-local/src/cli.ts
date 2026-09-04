/** Argument handling for the experimental `dsh-knowledge` command. */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildKnowledgeIndex, type BuildDenseIndexOptions } from './index-builder.ts'
import type { KnowledgeIndexManifest } from './index-format.ts'
import { evaluateSciFact, renderEvaluationReport } from './evaluation.ts'
import {
  BGE_DENSE_DTYPE,
  DEFAULT_DENSE_MAX_TOKENS,
  loadDenseEncoder,
} from './model-runtime.ts'
import { prepareSciFact } from './prepare.ts'
import {
  BGE_SMALL_EN_MODEL_ID,
  BGE_SMALL_EN_REVISION,
  loadBgeChunkTokenizer,
} from './tokenizer.ts'

const HELP = `Usage: dsh-knowledge <command> [options]

Commands:
  prepare   Prepare the SciFact dataset and local models
  index     Build an immutable local index
  evaluate  Run the six fixed retrieval evaluations`

function required(value: string | undefined, option: string): string {
  if (value === undefined || value.trim().length === 0) throw new TypeError(`--${option} is required`)
  return value
}

function numberOption(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`--${option} must be a finite number`)
  return parsed
}

async function runIndex(argv: readonly string[], stdout: Pick<NodeJS.WriteStream, 'write'>): Promise<number> {
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
      'bm25-k1': { type: 'string', default: '1.2' },
      'bm25-b': { type: 'string', default: '0.75' },
      'dense-model-id': { type: 'string', default: BGE_SMALL_EN_MODEL_ID },
      'dense-model-revision': { type: 'string', default: BGE_SMALL_EN_REVISION },
      'dense-max-tokens': { type: 'string', default: String(DEFAULT_DENSE_MAX_TOKENS) },
      'embedding-batch-size': { type: 'string', default: '32' },
    },
  })
  if (values.components !== 'bm25' && values.components !== 'bm25,dense') {
    throw new TypeError('--components must be bm25 or bm25,dense')
  }
  if (values['corpus-format'] !== 'generic' && values['corpus-format'] !== 'scifact') {
    throw new TypeError('--corpus-format must be generic or scifact')
  }
  const corpusPath = required(values.corpus, 'corpus')
  const outputDir = required(values.output, 'output')
  const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
  const denseEnabled = values.components === 'bm25,dense'
  const denseModelId = denseEnabled ? required(values['dense-model-id'], 'dense-model-id') : BGE_SMALL_EN_MODEL_ID
  const denseModelRevision = denseEnabled
    ? required(values['dense-model-revision'], 'dense-model-revision')
    : BGE_SMALL_EN_REVISION
  const tokenizer = await loadBgeChunkTokenizer({
    cacheDir: modelCacheDir,
    localFilesOnly: true,
    modelId: denseModelId,
    revision: denseModelRevision,
  })
  const encoder = denseEnabled
    ? await loadDenseEncoder({
      cacheDir: modelCacheDir,
      localFilesOnly: true,
      modelId: denseModelId,
      revision: denseModelRevision,
      dtype: BGE_DENSE_DTYPE,
      maxTokens: numberOption(values['dense-max-tokens'], DEFAULT_DENSE_MAX_TOKENS, 'dense-max-tokens'),
    })
    : undefined
  const dense: BuildDenseIndexOptions | undefined = encoder === undefined
    ? undefined
    : {
      encoder,
      batchSize: numberOption(values['embedding-batch-size'], 32, 'embedding-batch-size'),
      modelId: denseModelId,
      revision: denseModelRevision,
      dtype: BGE_DENSE_DTYPE,
    }
  let manifest: KnowledgeIndexManifest
  try {
    manifest = await buildKnowledgeIndex({
      corpusText: await readFile(corpusPath, 'utf8'),
      corpusSource: corpusPath,
      corpusFormat: values['corpus-format'],
      outputDir,
      tokenizer,
      chunking: {
        maxTokens: numberOption(values['max-tokens'], 384, 'max-tokens'),
        overlapTokens: numberOption(values['overlap-tokens'], 64, 'overlap-tokens'),
      },
      bm25K1: numberOption(values['bm25-k1'], 1.2, 'bm25-k1'),
      bm25B: numberOption(values['bm25-b'], 0.75, 'bm25-b'),
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
    },
  })
  if (positionals.length !== 1 || positionals[0] !== 'scifact') {
    throw new TypeError('prepare requires the positional dataset name scifact')
  }
  const result = await prepareSciFact(
    required(values['data-dir'], 'data-dir'),
    required(values['model-cache-dir'], 'model-cache-dir'),
  )
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
      'warmup-queries': { type: 'string', default: '10' },
      output: { type: 'string' },
    },
  })
  const indexDir = required(values.index, 'index')
  const queriesPath = required(values.queries, 'queries')
  const qrelsPath = required(values.qrels, 'qrels')
  const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
  const outputDir = required(values.output, 'output')
  await prepareReportDirectory(outputDir)
  const report = await evaluateSciFact({
    indexDir,
    queriesPath,
    qrelsPath,
    modelCacheDir,
    maxResults: numberOption(values['max-results'], 20, 'max-results'),
    warmupQueries: numberOption(values['warmup-queries'], 10, 'warmup-queries'),
  })
  const jsonPath = join(outputDir, 'report.json')
  const markdownPath = join(outputDir, 'report.md')
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  await writeFile(markdownPath, renderEvaluationReport(report), { flag: 'wx' })
  const failedRuns = report.runs.filter(run => run.status === 'failed').length
  stdout.write(`${JSON.stringify({ report: jsonPath, markdown: markdownPath, failedRuns })}\n`)
  return failedRuns === 0 ? 0 : 2
}

/**
 * Execute the CLI and return its process exit code.
 * @param argv - arguments after the executable name.
 * @param stdout - destination for help and successful summaries.
 * @param stderr - destination for validation and execution failures.
 * @returns zero on success or two for invalid or failed commands.
 */
export async function runCli(
  argv: readonly string[],
  stdout: Pick<NodeJS.WriteStream, 'write'>,
  stderr: Pick<NodeJS.WriteStream, 'write'>,
): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      stdout.write(`${HELP}\n`)
      return 0
    }
    const [command, ...options] = argv
    if (command === 'prepare') return await runPrepare(options, stdout)
    if (command === 'index') return await runIndex(options, stdout)
    if (command === 'evaluate') return await runEvaluate(options, stdout)
    stderr.write(`dsh-knowledge: unknown command "${command}"\n`)
    return 2
  } catch (error) {
    stderr.write(`dsh-knowledge: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}
