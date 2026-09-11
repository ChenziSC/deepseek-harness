/** Budgeted execution and validation for optional offline contextual-prefix generation. */

import { createHash } from 'node:crypto'
import { compareCodePoints } from '../../ordering.ts'
import type { ChunkTokenizer } from '../../tokenizer.ts'
import { longestCommonSubstring } from '../text.ts'
import type {
  ContextualPrefixBatch,
  ContextualPrefixBudgetAction,
  ContextualPrefixPlan,
  ContextualPrefixRequest,
} from './contextual-prefix.ts'

/** Metered raw response returned by one prefix-model request. */
export interface ContextualPrefixGeneration {
  readonly output: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: number
}

/** Fixed model identity and operations supplied by an offline caller. */
export interface ContextualPrefixGenerator {
  readonly modelId: string
  readonly revision: string
  readonly parameters: Readonly<Record<string, string | number | boolean>>
  readonly countTokens: (request: ContextualPrefixRequest) => Promise<number>
  readonly generate: (request: ContextualPrefixRequest) => Promise<ContextualPrefixGeneration>
}

/** Request error that preserves provider usage already consumed before failure. */
export class ContextualPrefixGenerationError extends Error {
  constructor(
    message: string,
    readonly inputTokens: number,
    readonly outputTokens: number,
    readonly latencyMs: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ContextualPrefixGenerationError'
  }
}

/** Validated prefix result stored for one complete request batch. */
export interface ContextualPrefixCachedSuccess {
  readonly schemaVersion: 1
  readonly prefixes: readonly {
    readonly chunkId: string
    readonly context: string
  }[]
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: number
  readonly outputSha256: string
}

/** Auditable failed attempt that is never eligible as a cache hit. */
export interface ContextualPrefixFailedAttempt {
  readonly attempt: number
  readonly failureType: 'request' | 'json' | 'schema' | 'empty' | 'token-limit' | 'chunk-copy' | 'budget'
  readonly message: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: number
}

/** Cache operations required by the generation executor. */
export interface ContextualPrefixGenerationCache {
  readonly get: (
    key: string,
    expectedChunkIds: readonly string[],
  ) => ContextualPrefixCachedSuccess | undefined
  readonly put: (key: string, value: ContextualPrefixCachedSuccess) => boolean
  readonly recordFailure: (key: string, failure: ContextualPrefixFailedAttempt) => void
}

/** Explicit cumulative limits and failure behavior for one execution. */
export interface ContextualPrefixExecutionOptions {
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly maxRetries: number
  readonly budgetAction: ContextualPrefixBudgetAction
  readonly tokenizer: Pick<ChunkTokenizer, 'countTokens'>
  readonly signal?: AbortSignal
}

/** Per-chunk result consumed by a later index build. */
interface ContextualPrefixExecutionValue {
  readonly chunkId: string
  readonly sourceTextSha256: string
  readonly status: 'generated' | 'cache-hit' | 'fallback'
  readonly context?: string
}

/** Complete metered outcome for one frozen plan. */
export interface ContextualPrefixExecution {
  readonly values: readonly ContextualPrefixExecutionValue[]
  readonly cacheQueryCount: number
  readonly cacheHitCount: number
  readonly generatedCount: number
  readonly fallbackCount: number
  readonly requestCount: number
  readonly retryCount: number
  readonly plannedInputTokens: number
  readonly plannedMaximumOutputTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheSavedInputTokens: number
  readonly cacheSavedOutputTokens: number
  readonly latencyMs: number
}

interface PreparedBatch {
  readonly batch: ContextualPrefixBatch
  readonly key: string
  readonly countedInputTokens: number
  readonly cached?: ContextualPrefixCachedSuccess
}

interface ParsedFailure {
  readonly failureType: ContextualPrefixFailedAttempt['failureType']
  readonly message: string
}

function nonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`knowledge-local: contextual prefix ${name} must be a non-negative safe integer`)
  }
}

function nonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`knowledge-local: contextual prefix ${name} must be a non-negative finite number`)
  }
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`knowledge-local: contextual prefix ${name} must be a positive safe integer`)
  }
}

function validateGenerator(generator: ContextualPrefixGenerator): void {
  if (generator.modelId.trim().length === 0) {
    throw new TypeError('knowledge-local: contextual prefix generator modelId must be non-empty')
  }
  if (generator.revision.trim().length === 0) {
    throw new TypeError('knowledge-local: contextual prefix generator revision must be non-empty')
  }
  for (const [name, value] of Object.entries(generator.parameters)) {
    if (name.length === 0 || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) {
      throw new TypeError('knowledge-local: contextual prefix generator parameters are invalid')
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('knowledge-local: contextual prefix generator parameters are invalid')
    }
  }
}

function validateOptions(
  options: Omit<ContextualPrefixExecutionOptions, 'budgetAction'> & { readonly budgetAction: string },
): void {
  positiveSafeInteger(options.maxInputTokens, 'execution maxInputTokens')
  positiveSafeInteger(options.maxOutputTokens, 'execution maxOutputTokens')
  nonNegativeSafeInteger(options.maxRetries, 'execution maxRetries')
  if (options.budgetAction !== 'fail' && options.budgetAction !== 'deterministic-fallback') {
    throw new TypeError('knowledge-local: contextual prefix execution budgetAction is unsupported')
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new TypeError('knowledge-local: contextual prefix generation was cancelled')
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('knowledge-local: contextual prefix cache identity has a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  throw new TypeError('knowledge-local: contextual prefix cache identity contains an unsupported value')
}

/**
 * Address one generated batch by every input that can change its prefixes.
 * @param plan - detector and window identity for the frozen plan.
 * @param batch - exact document window and targets.
 * @param generator - complete model revision and generation parameters.
 * @returns SHA-256 content address suitable for the independent prefix cache.
 */
export function contextualPrefixCacheKey(
  plan: Pick<ContextualPrefixPlan, 'detector' | 'contextWindowTokens'>,
  batch: ContextualPrefixBatch,
  generator: Pick<ContextualPrefixGenerator, 'modelId' | 'revision' | 'parameters'>,
): string {
  return createHash('sha256').update(canonical({
    schemaVersion: 1,
    outputSchemaVersion: 1,
    detector: plan.detector,
    contextWindowTokens: plan.contextWindowTokens,
    modelId: generator.modelId,
    revision: generator.revision,
    parameters: generator.parameters,
    request: batch.request,
  })).digest('hex')
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((field, index) => field === sorted[index])
}

function parseOutput(
  output: string,
  batch: ContextualPrefixBatch,
  tokenizer: Pick<ChunkTokenizer, 'countTokens'>,
): readonly { readonly chunkId: string; readonly context: string }[] | ParsedFailure {
  let raw: unknown
  try {
    raw = JSON.parse(output) as unknown
  } catch {
    return { failureType: 'json', message: 'model output is not valid JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { failureType: 'schema', message: 'model output must be an object' }
  }
  const root = raw as Record<string, unknown>
  if (!exactFields(root, ['prefixes']) || !Array.isArray(root['prefixes'])) {
    return { failureType: 'schema', message: 'model output must contain only a prefixes array' }
  }
  const targets = new Map(batch.request.targets.map(target => [target.id, target]))
  const seen = new Set<string>()
  const prefixes: { chunkId: string; context: string }[] = []
  for (const item of root['prefixes']) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { failureType: 'schema', message: 'each generated prefix must be an object' }
    }
    const prefix = item as Record<string, unknown>
    if (!exactFields(prefix, ['chunkId', 'context']) || typeof prefix['chunkId'] !== 'string') {
      return { failureType: 'schema', message: 'each generated prefix must contain only chunkId and context' }
    }
    const target = targets.get(prefix['chunkId'])
    if (target === undefined || seen.has(prefix['chunkId'])) {
      return { failureType: 'schema', message: 'generated prefix chunk IDs must match each target exactly once' }
    }
    if (typeof prefix['context'] !== 'string' || prefix['context'].trim().length === 0) {
      return { failureType: 'empty', message: `generated prefix for ${prefix['chunkId']} must be non-empty` }
    }
    const context = prefix['context'].trim()
    if (/\r|\n/u.test(context)) {
      return { failureType: 'schema', message: `generated prefix for ${prefix['chunkId']} must be one paragraph` }
    }
    if (tokenizer.countTokens(context) > batch.request.maxPrefixTokens) {
      return { failureType: 'token-limit', message: `generated prefix for ${prefix['chunkId']} exceeds its token limit` }
    }
    const normalizedContext = context.normalize('NFKC').replace(/\s+/gu, ' ')
    const normalizedTarget = target.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
    const copied = longestCommonSubstring(normalizedContext, normalizedTarget)
    if (copied >= 80 && copied / normalizedTarget.length >= 0.5) {
      return { failureType: 'chunk-copy', message: `generated prefix for ${prefix['chunkId']} copies a large source span` }
    }
    seen.add(prefix['chunkId'])
    prefixes.push({ chunkId: prefix['chunkId'], context })
  }
  if (seen.size !== targets.size) {
    return { failureType: 'schema', message: 'generated prefix chunk IDs must match each target exactly once' }
  }
  return prefixes.sort((left, right) => batch.candidateChunkIds.indexOf(left.chunkId) - batch.candidateChunkIds.indexOf(right.chunkId))
}

function validateGeneration(value: ContextualPrefixGeneration): void {
  if (typeof value.output !== 'string') throw new TypeError('contextual prefix generator returned an invalid output')
  positiveSafeInteger(value.inputTokens, 'generation inputTokens')
  nonNegativeSafeInteger(value.outputTokens, 'generation outputTokens')
  nonNegativeFinite(value.latencyMs, 'generation latencyMs')
}

function meteredFailure(error: unknown, attempt: number): ContextualPrefixFailedAttempt {
  if (error instanceof ContextualPrefixGenerationError) {
    nonNegativeSafeInteger(error.inputTokens, 'failed generation inputTokens')
    nonNegativeSafeInteger(error.outputTokens, 'failed generation outputTokens')
    nonNegativeFinite(error.latencyMs, 'failed generation latencyMs')
    return {
      attempt,
      failureType: 'request',
      message: error.message,
      inputTokens: error.inputTokens,
      outputTokens: error.outputTokens,
      latencyMs: error.latencyMs,
    }
  }
  return {
    attempt,
    failureType: 'request',
    message: error instanceof Error ? error.message : String(error),
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
  }
}

function fallbackValues(batch: ContextualPrefixBatch): ContextualPrefixExecutionValue[] {
  const targets = new Map(batch.request.targets.map(target => [target.id, target.text]))
  return batch.candidateChunkIds.map(chunkId => ({
    chunkId,
    sourceTextSha256: createHash('sha256').update(targets.get(chunkId) as string).digest('hex'),
    status: 'fallback',
  }))
}

function completedValues(
  batch: ContextualPrefixBatch,
  prefixes: ContextualPrefixCachedSuccess['prefixes'],
  status: 'generated' | 'cache-hit',
): ContextualPrefixExecutionValue[] {
  const targets = new Map(batch.request.targets.map(target => [target.id, target.text]))
  return prefixes.map(prefix => ({
    ...prefix,
    sourceTextSha256: createHash('sha256').update(targets.get(prefix.chunkId) as string).digest('hex'),
    status,
  }))
}

/**
 * Reuse or generate every batch under preflight and per-attempt token budgets.
 * @param plan - frozen deterministic plan whose order controls execution and recovery.
 * @param generator - complete model revision with actual usage reporting.
 * @param cache - independent durable cache for successful batches and failed-attempt audit.
 * @param options - explicit cumulative budgets, retry count, tokenizer, and cancellation signal.
 * @returns per-chunk statuses and actual or saved usage totals.
 */
export async function executeContextualPrefixPlan(
  plan: ContextualPrefixPlan,
  generator: ContextualPrefixGenerator,
  cache: ContextualPrefixGenerationCache,
  options: ContextualPrefixExecutionOptions,
): Promise<ContextualPrefixExecution> {
  validateGenerator(generator)
  validateOptions(options)
  throwIfCancelled(options.signal)
  const prepared: PreparedBatch[] = []
  for (const batch of plan.batches) {
    const key = contextualPrefixCacheKey(plan, batch, generator)
    const cached = cache.get(key, batch.candidateChunkIds)
    throwIfCancelled(options.signal)
    const countedInputTokens = cached === undefined ? await generator.countTokens(batch.request) : 0
    if (cached === undefined) positiveSafeInteger(countedInputTokens, 'counted request tokens')
    prepared.push({ batch, key, countedInputTokens, ...(cached === undefined ? {} : { cached }) })
  }
  const misses = prepared.filter(item => item.cached === undefined)
  const plannedInputTokens = misses.reduce((sum, item) => sum + item.countedInputTokens, 0)
  const plannedMaximumOutputTokens = misses.reduce((sum, item) => sum + item.batch.maximumOutputTokens, 0)
  if (plannedInputTokens > options.maxInputTokens || plannedMaximumOutputTokens > options.maxOutputTokens) {
    throw new TypeError('knowledge-local: contextual prefix measured plan exceeds the execution token budget')
  }

  const values: ContextualPrefixExecutionValue[] = plan.fallbacks.map(value => ({ ...value, status: 'fallback' }))
  let cacheHitCount = 0
  let generatedCount = 0
  let fallbackCount = plan.fallbacks.length
  let requestCount = 0
  let retryCount = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheSavedInputTokens = 0
  let cacheSavedOutputTokens = 0
  let latencyMs = 0

  for (const item of prepared) {
    throwIfCancelled(options.signal)
    if (item.cached !== undefined) {
      cacheHitCount += item.batch.candidateChunkIds.length
      cacheSavedInputTokens += item.cached.inputTokens
      cacheSavedOutputTokens += item.cached.outputTokens
      values.push(...completedValues(item.batch, item.cached.prefixes, 'cache-hit'))
      continue
    }

    let success: ContextualPrefixCachedSuccess | undefined
    let finalFailure: ContextualPrefixFailedAttempt | undefined
    let batchInputTokens = 0
    let batchOutputTokens = 0
    let batchLatencyMs = 0
    for (let attempt = 1; attempt <= options.maxRetries + 1; attempt += 1) {
      const reservedInput = inputTokens + item.countedInputTokens
      const reservedOutput = outputTokens + item.batch.maximumOutputTokens
      if (reservedInput > options.maxInputTokens || reservedOutput > options.maxOutputTokens) {
        finalFailure = {
          attempt,
          failureType: 'budget',
          message: 'retry would exceed the cumulative contextual prefix token budget',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
        }
        cache.recordFailure(item.key, finalFailure)
        break
      }
      requestCount += 1
      if (attempt > 1) retryCount += 1
      try {
        const response = await generator.generate(item.batch.request)
        validateGeneration(response)
        inputTokens += response.inputTokens
        outputTokens += response.outputTokens
        latencyMs += response.latencyMs
        batchInputTokens += response.inputTokens
        batchOutputTokens += response.outputTokens
        batchLatencyMs += response.latencyMs
        const parsed = parseOutput(response.output, item.batch, options.tokenizer)
        if ('failureType' in parsed) {
          finalFailure = {
            attempt,
            ...parsed,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            latencyMs: response.latencyMs,
          }
          cache.recordFailure(item.key, finalFailure)
        } else if (inputTokens > options.maxInputTokens || outputTokens > options.maxOutputTokens) {
          finalFailure = {
            attempt,
            failureType: 'budget',
            message: 'provider usage exceeded the cumulative contextual prefix token budget',
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            latencyMs: response.latencyMs,
          }
          cache.recordFailure(item.key, finalFailure)
        } else {
          success = {
            schemaVersion: 1,
            prefixes: parsed,
            inputTokens: batchInputTokens,
            outputTokens: batchOutputTokens,
            latencyMs: batchLatencyMs,
            outputSha256: createHash('sha256').update(response.output).digest('hex'),
          }
          cache.put(item.key, success)
          break
        }
      } catch (error) {
        finalFailure = meteredFailure(error, attempt)
        inputTokens += finalFailure.inputTokens
        outputTokens += finalFailure.outputTokens
        latencyMs += finalFailure.latencyMs
        batchInputTokens += finalFailure.inputTokens
        batchOutputTokens += finalFailure.outputTokens
        batchLatencyMs += finalFailure.latencyMs
        cache.recordFailure(item.key, finalFailure)
      }
    }

    if (success !== undefined) {
      generatedCount += success.prefixes.length
      values.push(...completedValues(item.batch, success.prefixes, 'generated'))
      continue
    }
    if (options.budgetAction === 'fail') {
      throw new TypeError(
        `knowledge-local: contextual prefix batch ${item.batch.id} failed: ${(finalFailure as ContextualPrefixFailedAttempt).message}`,
      )
    }
    const fallback = fallbackValues(item.batch)
    fallbackCount += fallback.length
    values.push(...fallback)
  }

  return {
    values,
    cacheQueryCount: prepared.length,
    cacheHitCount,
    generatedCount,
    fallbackCount,
    requestCount,
    retryCount,
    plannedInputTokens,
    plannedMaximumOutputTokens,
    inputTokens,
    outputTokens,
    cacheSavedInputTokens,
    cacheSavedOutputTokens,
    latencyMs,
  }
}
