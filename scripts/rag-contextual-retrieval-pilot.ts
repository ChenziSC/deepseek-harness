#!/usr/bin/env node
/** Run the isolated phase-six contextual-retrieval pilot against a fixed sample. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { CREDENTIALS_FILENAME, parseCredentialsDocument } from '../packages/credentials/credentials-local/src/index.ts'
import { resolveDshHome } from '../packages/util/home-paths/src/index.ts'
import { loadDenseEncoder } from '../packages/experimental/knowledge-local/src/model-runtime.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION, loadBgeChunkTokenizer } from '../packages/experimental/knowledge-local/src/tokenizer.ts'
import {
  contextualPilotTextMaps,
  evaluateContextualPilot,
  generateContextPrefixRun,
  parseContextualPilotSamples,
  renderContextPrefixPrompt,
  type ContextPrefixGeneration,
  type ContextPrefixGenerator,
  type ContextPrefixInput,
  type ContextPrefixRecord,
  type ContextualPilotEvaluation,
  type ContextualPilotMetrics,
  type ContextualPilotRetrieval,
} from '../packages/experimental/knowledge-local/scripts/contextual-retrieval-pilot.ts'
import { positiveInteger, required } from './rag-contextual-common.ts'

interface ChatCompletionResponse {
  readonly choices?: unknown
  readonly usage?: unknown
}

interface ResponsesResponse {
  readonly output_text?: unknown
  readonly output?: unknown
  readonly usage?: unknown
}

async function resolveApiKey(name: string, credentialsFile: string | undefined): Promise<string> {
  const inherited = process.env[name]
  if (inherited !== undefined && inherited.length > 0) return inherited
  const filename = credentialsFile ?? join(resolveDshHome(), CREDENTIALS_FILENAME)
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TypeError(`contextual pilot is missing ${name}`)
    throw error
  }
  const value = parseCredentialsDocument(text, filename).refs.get(name)
  if (value === undefined || value.length === 0) throw new TypeError(`contextual pilot is missing ${name}`)
  return value
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseCompletion(value: ChatCompletionResponse): {
  readonly output: string
  readonly inputTokens: number
  readonly outputTokens: number
} {
  if (!Array.isArray(value.choices) || value.choices.length !== 1) {
    throw new TypeError('contextual pilot response must contain one choice')
  }
  const choice = (value.choices as unknown[])[0]
  if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
    throw new TypeError('contextual pilot response choice must be an object')
  }
  const message = (choice as Record<string, unknown>)['message']
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    throw new TypeError('contextual pilot response message must be an object')
  }
  const output = (message as Record<string, unknown>)['content']
  if (typeof output !== 'string') throw new TypeError('contextual pilot response content must be text')
  if (typeof value.usage !== 'object' || value.usage === null || Array.isArray(value.usage)) {
    throw new TypeError('contextual pilot response must contain usage')
  }
  const usage = value.usage as Record<string, unknown>
  const inputTokens = usage['prompt_tokens']
  const outputTokens = usage['completion_tokens']
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) {
    throw new TypeError('contextual pilot prompt token count is invalid')
  }
  if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) {
    throw new TypeError('contextual pilot completion token count is invalid')
  }
  return { output, inputTokens: inputTokens as number, outputTokens: outputTokens as number }
}

function parseResponsesOutput(value: ResponsesResponse): {
  readonly output: string
  readonly inputTokens: number
  readonly outputTokens: number
} {
  let output: unknown = value.output_text
  if (typeof output !== 'string' && Array.isArray(value.output)) {
    const parts: string[] = []
    for (const item of value.output as unknown[]) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
      const content = (item as Record<string, unknown>)['content']
      if (!Array.isArray(content)) continue
      for (const part of content as unknown[]) {
        if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
        const partRecord = part as Record<string, unknown>
        if (partRecord['type'] === 'output_text' && typeof partRecord['text'] === 'string') parts.push(partRecord['text'])
      }
    }
    output = parts.join('')
  }
  if (typeof output !== 'string') throw new TypeError('contextual pilot response output must be text')
  if (typeof value.usage !== 'object' || value.usage === null || Array.isArray(value.usage)) {
    throw new TypeError('contextual pilot response must contain usage')
  }
  const usage = value.usage as Record<string, unknown>
  const inputTokens = usage['input_tokens']
  const outputTokens = usage['output_tokens']
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) {
    throw new TypeError('contextual pilot input token count is invalid')
  }
  if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) {
    throw new TypeError('contextual pilot output token count is invalid')
  }
  return { output, inputTokens: inputTokens as number, outputTokens: outputTokens as number }
}

function openAiGenerator(options: {
  readonly apiKey: string
  readonly baseUrl: string
  readonly modelId: string
  readonly revision: string
  readonly temperature: number
  readonly api: 'chat-completions' | 'responses'
}): ContextPrefixGenerator {
  const endpoint = new URL(
    options.api === 'responses' ? 'responses' : 'chat/completions',
    `${options.baseUrl.replace(/\/+$/u, '')}/`,
  ).toString()
  return {
    modelId: options.modelId,
    revision: options.revision,
    parameters: {
      api: options.api,
      ...(options.api === 'responses' ? { reasoningEffort: 'low' } : { temperature: options.temperature }),
      responseFormat: 'json_object',
      maxTokens: 400,
    },
    async generate(input: ContextPrefixInput): Promise<ContextPrefixGeneration> {
      const startedAt = performance.now()
      const prompt = renderContextPrefixPrompt(input)
      const body = options.api === 'responses'
        ? {
          model: options.modelId,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
          reasoning: { effort: 'low' },
          max_output_tokens: 400,
          text: {
            format: {
              type: 'json_schema',
              name: 'context_prefix',
              strict: true,
              schema: {
                type: 'object',
                properties: { context: { type: 'string' } },
                required: ['context'],
                additionalProperties: false,
              },
            },
          },
        }
        : {
          model: options.modelId,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature,
          max_tokens: 160,
          response_format: { type: 'json_object' },
          stream: false,
        }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`contextual pilot request failed with HTTP ${response.status}: ${await response.text()}`)
      const value = await response.json() as ChatCompletionResponse | ResponsesResponse
      const parsed = options.api === 'responses'
        ? parseResponsesOutput(value)
        : parseCompletion(value)
      return { ...parsed, latencyMs: performance.now() - startedAt }
    },
  }
}

function aggregateMean(evaluation: ContextualPilotEvaluation, field: keyof Omit<ContextualPilotMetrics, 'queryCount'>): number {
  const retrievals: readonly ContextualPilotRetrieval[] = ['bm25', 'dense', 'hybrid']
  return retrievals.reduce((sum, retrieval) => sum + evaluation.metrics[retrieval][field], 0) / retrievals.length
}

function generationSummary(records: readonly ContextPrefixRecord[]) {
  const success = records.filter(record => record.status === 'success').length
  return {
    recordCount: records.length,
    successCount: success,
    fallbackCount: records.length - success,
    successRate: records.length === 0 ? 0 : success / records.length,
    inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
    outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
    latencyMs: records.reduce((sum, record) => sum + record.latencyMs, 0),
    failureTypes: Object.fromEntries([...new Set(records.flatMap(record => record.failureType ?? []))]
      .sort()
      .map(type => [type, records.filter(record => record.failureType === type).length])),
  }
}

function stableMetrics(evaluation: ContextualPilotEvaluation): unknown {
  return { metrics: evaluation.metrics, byAmbiguity: evaluation.byAmbiguity }
}

const { values } = parseArgs({
  strict: true,
  allowPositionals: false,
  options: {
    samples: { type: 'string' },
    output: { type: 'string' },
    summary: { type: 'string' },
    'model-cache-dir': { type: 'string' },
    'api-key-env': { type: 'string', default: 'DEEPSEEK_API_KEY' },
    'credentials-file': { type: 'string' },
    'base-url': { type: 'string', default: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com' },
    api: { type: 'string', default: 'chat-completions' },
    model: { type: 'string', default: 'deepseek-chat' },
    'model-revision': { type: 'string' },
    runs: { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '4' },
    'candidate-count': { type: 'string', default: '50' },
    temperature: { type: 'string', default: '0' },
  },
})

const samplesPath = required(values.samples, 'samples')
const outputDir = required(values.output, 'output')
const summaryPath = required(values.summary, 'summary')
const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
const apiKeyName = required(values['api-key-env'], 'api-key-env')
const apiKey = await resolveApiKey(apiKeyName, values['credentials-file'])
const runCount = positiveInteger(values.runs, 'runs')
if (runCount < 3) throw new TypeError('--runs must be at least 3')
const concurrency = positiveInteger(values.concurrency, 'concurrency')
const candidateCount = positiveInteger(values['candidate-count'], 'candidate-count')
if (candidateCount < 10) throw new TypeError('--candidate-count must be at least 10')
const temperature = Number(required(values.temperature, 'temperature'))
if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
  throw new TypeError('--temperature must be from 0 through 2')
}
if (values.api !== 'chat-completions' && values.api !== 'responses') {
  throw new TypeError('--api must be chat-completions or responses')
}

const source = await readFile(samplesPath, 'utf8')
const samples = parseContextualPilotSamples(source, samplesPath)
const tokenizer = await loadBgeChunkTokenizer({ cacheDir: modelCacheDir, localFilesOnly: true })
const encoder = await loadDenseEncoder({ cacheDir: modelCacheDir, localFilesOnly: true })
const queryVectors = new Map<string, Float32Array>()
const cachedEncoder = {
  dimensions: encoder.dimensions,
  embedDocuments: (texts: readonly string[]) => encoder.embedDocuments(texts),
  async embedQuery(query: string): Promise<Float32Array> {
    const cached = queryVectors.get(query)
    if (cached !== undefined) return cached
    const vector = await encoder.embedQuery(query)
    queryVectors.set(query, vector)
    return vector
  },
}
const maps = contextualPilotTextMaps(samples)
const baselineIndexTokens = [...maps.baseline.values()].reduce((sum, text) => sum + tokenizer.countTokens(text), 0)
await mkdir(outputDir, { recursive: false })

try {
  const baseline = await evaluateContextualPilot(
    samples,
    'baseline',
    maps.baseline,
    baselineIndexTokens,
    tokenizer,
    cachedEncoder,
    candidateCount,
  )
  const baselineRepeat = await evaluateContextualPilot(
    samples,
    'baseline-repeat',
    maps.baseline,
    baselineIndexTokens,
    tokenizer,
    cachedEncoder,
    candidateCount,
  )
  const deterministic = await evaluateContextualPilot(
    samples,
    'deterministic',
    maps.deterministic,
    baselineIndexTokens,
    tokenizer,
    cachedEncoder,
    candidateCount,
  )
  const deterministicRepeat = await evaluateContextualPilot(
    samples,
    'deterministic-repeat',
    maps.deterministic,
    baselineIndexTokens,
    tokenizer,
    cachedEncoder,
    candidateCount,
  )
  const deterministicStable = JSON.stringify(stableMetrics(deterministic)) === JSON.stringify(stableMetrics(deterministicRepeat))
  const baselineStable = JSON.stringify(stableMetrics(baseline)) === JSON.stringify(stableMetrics(baselineRepeat))

  const llmRuns: Array<{ evaluation: ContextualPilotEvaluation; records: readonly ContextPrefixRecord[] }> = []
  for (let index = 1; index <= runCount; index += 1) {
    const runNamespace = `llm-${String(index).padStart(2, '0')}`
    const prefixRun = await generateContextPrefixRun(samples, runNamespace, openAiGenerator({
      apiKey,
      baseUrl: required(values['base-url'], 'base-url'),
      modelId: required(values.model, 'model'),
      revision: required(values['model-revision'], 'model-revision'),
      temperature,
      api: values.api,
    }), tokenizer, concurrency)
    const evaluation = await evaluateContextualPilot(
      samples,
      runNamespace,
      prefixRun.texts,
      baselineIndexTokens,
      tokenizer,
      cachedEncoder,
      candidateCount,
    )
    llmRuns.push({ evaluation, records: prefixRun.records })
    await writeFile(join(outputDir, `${runNamespace}-prefix-records.jsonl`), `${prefixRun.records.map(record => JSON.stringify(record)).join('\n')}\n`)
    await writeFile(join(outputDir, `${runNamespace}-evaluation.json`), `${JSON.stringify(evaluation, null, 2)}\n`)
  }

  const baselineCoverage = aggregateMean(baseline, 'completeEvidenceCoverage')
  const baselineRecall = aggregateMean(baseline, 'recallAt10')
  const deterministicCoverage = aggregateMean(deterministic, 'completeEvidenceCoverage')
  const deterministicRecall = aggregateMean(deterministic, 'recallAt10')
  const llmCoverage = llmRuns.map(run => aggregateMean(run.evaluation, 'completeEvidenceCoverage'))
  const llmRecall = llmRuns.map(run => aggregateMean(run.evaluation, 'recallAt10'))
  const baselineGainPassed = mean(llmCoverage) - baselineCoverage >= 0.05 || mean(llmRecall) - baselineRecall >= 0.05
  const deterministicGainPassed = llmRuns.every((_, index) => (
    (llmCoverage[index] as number) > deterministicCoverage || (llmRecall[index] as number) > deterministicRecall
  ))
  const ndcgGuardPassed = llmRuns.every(run => (['bm25', 'dense', 'hybrid'] as const).every(retrieval => (
    run.evaluation.metrics[retrieval].ndcgAt10 >= baseline.metrics[retrieval].ndcgAt10 - 0.01
  )))
  const tokenIncreasePassed = mean(llmRuns.map(run => run.evaluation.indexTokenIncreaseRatio)) <= 0.25
  const generationSuccessPassed = llmRuns.every(run => generationSummary(run.records).successRate >= 0.99)
  const infrastructurePassed = baselineStable && deterministicStable
  const gates = {
    infrastructurePassed,
    baselineGainPassed,
    deterministicGainPassed,
    ndcgGuardPassed,
    tokenIncreasePassed,
    generationSuccessPassed,
  }
  const summary = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    inputs: {
      samplesPath,
      samplesSha256: sha256(source),
      sampleCount: samples.length,
      chunkCount: [...maps.baseline.keys()].length,
    },
    configuration: {
      denseModelId: BGE_M3_MODEL_ID,
      denseModelRevision: BGE_M3_REVISION,
      prefixModelId: required(values.model, 'model'),
      prefixModelRevision: required(values['model-revision'], 'model-revision'),
      prefixApi: values.api,
      runCount,
      concurrency,
      candidateCount,
      maxResults: 10,
      reranker: 'off',
      adjacentExpansion: 'off',
      rrfK: 60,
    },
    deterministicChecks: { baselineStable, deterministicStable },
    baseline,
    deterministic,
    llmRuns: llmRuns.map(run => ({ evaluation: run.evaluation, generation: generationSummary(run.records) })),
    gates,
    decision: Object.values(gates).every(Boolean) ? 'continue-to-formal-spec' : 'stop-and-keep-current-default',
  }
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ event: 'contextual-pilot-complete', summary: summaryPath, decision: summary.decision, gates })}\n`)
} finally {
  await encoder.dispose()
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
