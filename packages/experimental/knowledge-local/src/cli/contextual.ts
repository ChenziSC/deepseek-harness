/** Offline contextual-prefix commands kept separate from product index construction. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'
import { createGunzip } from 'node:zlib'
import { chunkDocuments } from '../chunker.ts'
import { CorpusFormatError, parseCorpusDocumentLine, type CorpusDocument } from '../corpus.ts'
import { prepareEmptyDirectory } from '../filesystem.ts'
import { loadBgeChunkTokenizer } from '../tokenizer.ts'
import {
  contextualPrefixArtifactSha256,
  parseContextualPrefixPlanArtifact,
  renderContextualPrefixArtifact,
  type ContextualPrefixPlanArtifact,
  type ContextualPrefixRecordsArtifact,
} from '../offline/contextual-prefix/contextual-prefix-artifacts.ts'
import { ContextualPrefixCache } from '../offline/contextual-prefix/contextual-prefix-cache.ts'
import { executeContextualPrefixPlan } from '../offline/contextual-prefix/contextual-prefix-generation.ts'
import { createOpenAiContextualPrefixGenerator } from '../offline/contextual-prefix/contextual-prefix-openai.ts'
import {
  planContextualPrefixes,
  type ContextualPrefixBudgetAction,
  type ContextualPrefixTarget,
} from '../offline/contextual-prefix/contextual-prefix.ts'
import { scanContextualPrefixCorpus } from '../offline/contextual-prefix/contextual-prefix-statistics.ts'
import {
  PLANNING_CORPUS_OPTIONS,
  chunkingStrategy,
  corpusFormat,
  integerOption,
  numberOption,
  required,
  type CliOutput,
} from './options.ts'

const CONTEXTUAL_PREFIX_PLAN_FILE = 'contextual-prefix-plan.json'
const CONTEXTUAL_PREFIX_RECORDS_FILE = 'contextual-prefix-records.json'
const CONTEXTUAL_PREFIX_STATISTICS_FILE = 'contextual-prefix-statistics.json'

const CONTEXTUAL_PLANNING_OPTIONS = {
  target: { type: 'string' },
  'max-candidate-ratio': { type: 'string' },
  'max-prefix-tokens': { type: 'string' },
  'context-window-tokens': { type: 'string' },
  'max-chunks-per-request': { type: 'string' },
  'prompt-version': { type: 'string' },
} as const

function contextualTarget(value: string | undefined): ContextualPrefixTarget {
  if ((['dense', 'bm25-and-dense'] as const).includes(value as ContextualPrefixTarget)) return value as ContextualPrefixTarget
  throw new TypeError('--target must be dense or bm25-and-dense')
}

function budgetAction(value: string | undefined): ContextualPrefixBudgetAction {
  if ((['fail', 'deterministic-fallback'] as const).includes(value as ContextualPrefixBudgetAction)) {
    return value as ContextualPrefixBudgetAction
  }
  throw new TypeError('--budget-action must be fail or deterministic-fallback')
}

function corpusInput(path: string): Readable {
  const stream = createReadStream(path)
  return path.endsWith('.gz') ? stream.pipe(createGunzip()) : stream
}

async function loadPlanningCorpus(
  path: string,
  format: 'generic' | 'scifact' | 'mldr' | 't2ranking',
): Promise<{ readonly documents: readonly CorpusDocument[]; readonly sha256: string }> {
  const digest = createHash('sha256')
  const stream = corpusInput(path)
  stream.on('data', chunk => digest.update(chunk as Buffer))
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const documents: CorpusDocument[] = []
  const ids = new Set<string>()
  let line = 0
  try {
    for await (const text of lines) {
      line += 1
      if (text.trim().length === 0 || (format === 't2ranking' && line === 1 && text === 'pid\ttext')) continue
      const document = parseCorpusDocumentLine(text, format, path, line)
      if (ids.has(document.id)) throw new CorpusFormatError(path, line, `duplicate document id ${JSON.stringify(document.id)}`)
      ids.add(document.id)
      documents.push(document)
    }
  } finally {
    lines.close()
  }
  return { documents, sha256: digest.digest('hex') }
}

interface ContextualCorpusValues {
  readonly corpus?: string
  readonly 'corpus-format'?: string
  readonly output?: string
  readonly 'model-cache-dir'?: string
  readonly 'tokenizer-model-id'?: string
  readonly 'tokenizer-revision'?: string
}

async function contextualCorpusSettings(values: ContextualCorpusValues) {
  const corpusPath = required(values.corpus, 'corpus')
  const format = corpusFormat(values['corpus-format'])
  const outputDir = required(values.output, 'output')
  const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
  const tokenizerModelId = required(values['tokenizer-model-id'], 'tokenizer-model-id')
  const tokenizerRevision = required(values['tokenizer-revision'], 'tokenizer-revision')
  const tokenizer = await loadBgeChunkTokenizer({
    cacheDir: modelCacheDir,
    localFilesOnly: true,
    modelId: tokenizerModelId,
    revision: tokenizerRevision,
  })
  return { corpusPath, format, outputDir, tokenizerModelId, tokenizerRevision, tokenizer }
}

export async function runContextualPlan(argv: readonly string[], stdout: CliOutput): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      ...PLANNING_CORPUS_OPTIONS,
      ...CONTEXTUAL_PLANNING_OPTIONS,
      'max-input-tokens': { type: 'string' },
      'max-output-tokens': { type: 'string' },
      'budget-action': { type: 'string' },
    },
  })
  const { corpusPath, format, outputDir, tokenizerModelId, tokenizerRevision, tokenizer } = await contextualCorpusSettings(values)
  const maxTokens = integerOption(values['max-tokens'], 'max-tokens', 1)
  const overlapTokens = integerOption(values['overlap-tokens'], 'overlap-tokens', 0)
  const strategy = chunkingStrategy(values['chunking-strategy'])
  const corpus = await loadPlanningCorpus(corpusPath, format)
  const chunks = chunkDocuments(corpus.documents, tokenizer, { maxTokens, overlapTokens, strategy })
  const plan = planContextualPrefixes(corpus.documents, chunks, tokenizer, {
    detector: 'strict-v1',
    target: contextualTarget(values.target),
    maxCandidateRatio: numberOption(values['max-candidate-ratio'], 'max-candidate-ratio'),
    maxInputTokens: integerOption(values['max-input-tokens'], 'max-input-tokens', 1),
    maxOutputTokens: integerOption(values['max-output-tokens'], 'max-output-tokens', 1),
    maxPrefixTokens: integerOption(values['max-prefix-tokens'], 'max-prefix-tokens', 1),
    contextWindowTokens: integerOption(values['context-window-tokens'], 'context-window-tokens', 1),
    maxChunksPerRequest: integerOption(values['max-chunks-per-request'], 'max-chunks-per-request', 1),
    budgetAction: budgetAction(values['budget-action']),
    promptVersion: required(values['prompt-version'], 'prompt-version'),
  })
  const artifact: ContextualPrefixPlanArtifact = {
    schemaVersion: 1,
    corpus: { sha256: corpus.sha256, format, documentCount: corpus.documents.length },
    chunking: { tokenizerModelId, tokenizerRevision, maxTokens, overlapTokens, strategy },
    plan,
  }
  await prepareEmptyDirectory(outputDir, `knowledge-local: report output directory is not empty: ${outputDir}`)
  const path = join(outputDir, CONTEXTUAL_PREFIX_PLAN_FILE)
  const text = renderContextualPrefixArtifact(artifact)
  await writeFile(path, text, { flag: 'wx' })
  stdout.write(`${JSON.stringify({
    plan: path,
    planSha256: contextualPrefixArtifactSha256(text),
    documentCount: artifact.corpus.documentCount,
    chunkCount: plan.totalChunkCount,
    detectedCandidateCount: plan.detectedCandidateCount,
    selectedCandidateCount: plan.selectedCandidateCount,
    fallbackCandidateCount: plan.fallbackCandidateCount,
    requestCount: plan.batches.length,
    estimatedInputTokens: plan.estimatedInputTokens,
    maximumOutputTokens: plan.maximumOutputTokens,
  })}\n`)
  return 0
}

export async function runContextualGenerate(argv: readonly string[], stdout: CliOutput): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      plan: { type: 'string' },
      output: { type: 'string' },
      'cache-dir': { type: 'string' },
      'model-cache-dir': { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string', default: 'OPENAI_API_KEY' },
      'model-id': { type: 'string' },
      revision: { type: 'string' },
      'reasoning-effort': { type: 'string' },
      'max-input-tokens': { type: 'string' },
      'max-output-tokens': { type: 'string' },
      'max-retries': { type: 'string', default: '1' },
      'budget-action': { type: 'string' },
    },
  })
  const planPath = required(values.plan, 'plan')
  const outputDir = required(values.output, 'output')
  const cacheDir = required(values['cache-dir'], 'cache-dir')
  const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
  const planText = await readFile(planPath, 'utf8')
  const artifact = parseContextualPrefixPlanArtifact(planText)
  const reasoningEffort = values['reasoning-effort']
  if (!['none', 'minimal', 'low', 'medium', 'high'].includes(reasoningEffort ?? '')) {
    throw new TypeError('--reasoning-effort must be none, minimal, low, medium, or high')
  }
  const resolvedReasoningEffort = reasoningEffort as 'none' | 'minimal' | 'low' | 'medium' | 'high'
  const apiKeyEnvironment = required(values['api-key-env'], 'api-key-env')
  const apiKey = required(process.env[apiKeyEnvironment], apiKeyEnvironment)
  const tokenizer = await loadBgeChunkTokenizer({
    cacheDir: modelCacheDir,
    localFilesOnly: true,
    modelId: artifact.chunking.tokenizerModelId,
    revision: artifact.chunking.tokenizerRevision,
  })
  const generator = createOpenAiContextualPrefixGenerator({
    apiKey,
    baseUrl: required(values['base-url'], 'base-url'),
    modelId: required(values['model-id'], 'model-id'),
    revision: required(values.revision, 'revision'),
    reasoningEffort: resolvedReasoningEffort,
    tokenizer,
  })
  await prepareEmptyDirectory(outputDir, `knowledge-local: report output directory is not empty: ${outputDir}`)
  const cache = await ContextualPrefixCache.open(cacheDir)
  let execution: Awaited<ReturnType<typeof executeContextualPrefixPlan>>
  try {
    execution = await executeContextualPrefixPlan(artifact.plan, generator, cache, {
      maxInputTokens: integerOption(values['max-input-tokens'], 'max-input-tokens', 1),
      maxOutputTokens: integerOption(values['max-output-tokens'], 'max-output-tokens', 1),
      maxRetries: integerOption(values['max-retries'], 'max-retries', 0),
      budgetAction: budgetAction(values['budget-action']),
      tokenizer,
    })
  } finally {
    cache.close()
  }
  const records: ContextualPrefixRecordsArtifact = {
    schemaVersion: 1,
    planSha256: contextualPrefixArtifactSha256(planText),
    generator: {
      modelId: generator.modelId,
      revision: generator.revision,
      parameters: generator.parameters,
    },
    execution,
  }
  const path = join(outputDir, CONTEXTUAL_PREFIX_RECORDS_FILE)
  await writeFile(path, renderContextualPrefixArtifact(records), { flag: 'wx' })
  stdout.write(`${JSON.stringify({ records: path, ...execution, values: undefined })}\n`)
  return 0
}

export async function runContextualStatistics(argv: readonly string[], stdout: CliOutput): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      ...PLANNING_CORPUS_OPTIONS,
      ...CONTEXTUAL_PLANNING_OPTIONS,
      'diagnostic-sample-limit': { type: 'string', default: '20' },
      'sample-modulus': { type: 'string', default: '1' },
    },
  })
  const { corpusPath, format, outputDir, tokenizer } = await contextualCorpusSettings(values)
  const report = await scanContextualPrefixCorpus({
    corpusPath,
    corpusFormat: format,
    tokenizer,
    chunking: {
      maxTokens: integerOption(values['max-tokens'], 'max-tokens', 1),
      overlapTokens: integerOption(values['overlap-tokens'], 'overlap-tokens', 0),
      strategy: chunkingStrategy(values['chunking-strategy']),
    },
    planning: {
      detector: 'strict-v1',
      target: contextualTarget(values.target),
      maxCandidateRatio: numberOption(values['max-candidate-ratio'], 'max-candidate-ratio'),
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      maxOutputTokens: Number.MAX_SAFE_INTEGER,
      maxPrefixTokens: integerOption(values['max-prefix-tokens'], 'max-prefix-tokens', 1),
      contextWindowTokens: integerOption(values['context-window-tokens'], 'context-window-tokens', 1),
      maxChunksPerRequest: integerOption(values['max-chunks-per-request'], 'max-chunks-per-request', 1),
      budgetAction: 'fail',
      promptVersion: required(values['prompt-version'], 'prompt-version'),
    },
    diagnosticSampleLimit: integerOption(values['diagnostic-sample-limit'], 'diagnostic-sample-limit', 0),
    sampleModulus: integerOption(values['sample-modulus'], 'sample-modulus', 1),
  })
  await prepareEmptyDirectory(outputDir, `knowledge-local: report output directory is not empty: ${outputDir}`)
  const path = join(outputDir, CONTEXTUAL_PREFIX_STATISTICS_FILE)
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  stdout.write(`${JSON.stringify({ report: path, ...report, diagnostics: undefined })}\n`)
  return 0
}
