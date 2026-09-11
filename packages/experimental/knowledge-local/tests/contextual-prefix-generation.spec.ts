import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chunkDocuments } from '../src/chunker.ts'
import type { ChunkTokenizer } from '../src/tokenizer.ts'
import { parseCorpusJsonl } from '../src/corpus.ts'
import { CONTEXTUAL_PREFIX_CACHE_FILE, ContextualPrefixCache } from '../src/offline/contextual-prefix/contextual-prefix-cache.ts'
import {
  ContextualPrefixGenerationError,
  contextualPrefixCacheKey,
  executeContextualPrefixPlan,
  type ContextualPrefixCachedSuccess,
  type ContextualPrefixFailedAttempt,
  type ContextualPrefixGenerationCache,
  type ContextualPrefixGenerator,
} from '../src/offline/contextual-prefix/contextual-prefix-generation.ts'
import { planContextualPrefixes, type ContextualPrefixPlan } from '../src/offline/contextual-prefix/contextual-prefix.ts'

const tokenizer: ChunkTokenizer = {
  countTokens(text) {
    return text.match(/\S+/gu)?.length ?? 0
  },
}

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-context-prefix-cache-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function plan(): ContextualPrefixPlan {
  const documents = parseCorpusJsonl([
    JSON.stringify({ id: 'a', title: 'First', text: 'It needs earlier context.' }),
    JSON.stringify({ id: 'b', title: 'Second', text: 'However, this also needs context.' }),
  ].join('\n'))
  const chunks = chunkDocuments(documents, tokenizer, { maxTokens: 32, overlapTokens: 0 })
  return planContextualPrefixes(documents, chunks, tokenizer, {
    detector: 'strict-v1',
    target: 'dense',
    maxCandidateRatio: 1,
    maxInputTokens: 10_000,
    maxOutputTokens: 1_000,
    maxPrefixTokens: 20,
    contextWindowTokens: 32,
    maxChunksPerRequest: 1,
    budgetAction: 'fail',
    promptVersion: 'context-prefix-v2',
  })
}

class MemoryCache implements ContextualPrefixGenerationCache {
  readonly successes = new Map<string, ContextualPrefixCachedSuccess>()
  readonly failures: { key: string; failure: ContextualPrefixFailedAttempt }[] = []

  get(key: string): ContextualPrefixCachedSuccess | undefined {
    return this.successes.get(key)
  }

  put(key: string, value: ContextualPrefixCachedSuccess): boolean {
    if (this.successes.has(key)) return false
    this.successes.set(key, value)
    return true
  }

  recordFailure(key: string, failure: ContextualPrefixFailedAttempt): void {
    this.failures.push({ key, failure })
  }
}

function generator(generate: ContextualPrefixGenerator['generate']): ContextualPrefixGenerator {
  return {
    modelId: 'fixture-model',
    revision: 'a'.repeat(40),
    parameters: { temperature: 0, store: false },
    countTokens: request => Promise.resolve(tokenizer.countTokens(JSON.stringify(request))),
    generate,
  }
}

function output(request: Parameters<ContextualPrefixGenerator['generate']>[0]): string {
  return JSON.stringify({
    prefixes: request.targets.map(target => ({ chunkId: target.id, context: `Context for ${target.id}.` })),
  })
}

function rejectWithUnknown(reason: unknown): Promise<never> {
  return new Promise((_resolve, reject) => {
    Reflect.apply(reject, undefined, [reason])
  })
}

const executionOptions = {
  maxInputTokens: 10_000,
  maxOutputTokens: 1_000,
  maxRetries: 0,
  budgetAction: 'fail' as const,
  tokenizer,
}

describe('contextual prefix generation', () => {
  it('preserves candidates excluded by planning as deterministic fallbacks', async () => {
    const value = plan()
    const fallback = { chunkId: 'excluded', sourceTextSha256: 'f'.repeat(64) }
    const result = await executeContextualPrefixPlan(
      { ...value, fallbacks: [fallback], fallbackCandidateCount: 1, detectedCandidateCount: 3 },
      generator(request => Promise.resolve({
        output: output(request),
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      })),
      new MemoryCache(),
      executionOptions,
    )

    expect(result.values[0]).toEqual({ ...fallback, status: 'fallback' })
    expect(result.fallbackCount).toBe(1)
  })

  it('generates strict batches once and reuses every successful content address', async () => {
    const cache = new MemoryCache()
    const generate = vi.fn<ContextualPrefixGenerator['generate']>(request => Promise.resolve({
      output: output(request),
      inputTokens: 12,
      outputTokens: 4,
      latencyMs: 7,
    }))
    const fixed = generator(generate)
    const first = await executeContextualPrefixPlan(plan(), fixed, cache, executionOptions)

    expect(first.values.map(value => value.status)).toEqual(['generated', 'generated'])
    expect(first).toMatchObject({
      cacheQueryCount: 2,
      cacheHitCount: 0,
      generatedCount: 2,
      fallbackCount: 0,
      requestCount: 2,
      retryCount: 0,
      inputTokens: 24,
      outputTokens: 8,
      latencyMs: 14,
    })

    const countTokens = vi.fn(fixed.countTokens)
    const second = await executeContextualPrefixPlan(plan(), { ...fixed, countTokens }, cache, executionOptions)
    expect(second.values.map(value => value.status)).toEqual(['cache-hit', 'cache-hit'])
    expect(second).toMatchObject({
      cacheHitCount: 2,
      generatedCount: 0,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheSavedInputTokens: 24,
      cacheSavedOutputTokens: 8,
    })
    expect(countTokens).not.toHaveBeenCalled()
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('retries the same batch and stores all consumed usage with the success', async () => {
    const cache = new MemoryCache()
    const generate = vi.fn<ContextualPrefixGenerator['generate']>()
      .mockRejectedValueOnce(new ContextualPrefixGenerationError('temporary', 9, 1, 3))
      .mockImplementationOnce(request => Promise.resolve({
        output: output(request),
        inputTokens: 10,
        outputTokens: 3,
        latencyMs: 4,
      }))
    const one = { ...plan(), batches: plan().batches.slice(0, 1) }
    const result = await executeContextualPrefixPlan(one, generator(generate), cache, {
      ...executionOptions,
      maxRetries: 1,
    })

    expect(result).toMatchObject({ requestCount: 2, retryCount: 1, inputTokens: 19, outputTokens: 4, latencyMs: 7 })
    expect(cache.failures[0]?.failure).toMatchObject({ failureType: 'request', inputTokens: 9, outputTokens: 1 })
    expect([...cache.successes.values()][0]).toMatchObject({ inputTokens: 19, outputTokens: 4, latencyMs: 7 })
  })

  it.each([
    ['not json', 'json'],
    ['[]', 'schema'],
    ['{}', 'schema'],
    ['{"prefixes":[]}', 'schema'],
    ['{"prefixes":[null]}', 'schema'],
    ['{"prefixes":[{"chunkId":"$ID","context":"value","extra":true}]}', 'schema'],
    ['{"prefixes":[{"chunkId":"wrong","context":"value"}]}', 'schema'],
    ['{"prefixes":[{"chunkId":"$ID","context":""}]}', 'empty'],
    ['{"prefixes":[{"chunkId":"$ID","context":"first\\nsecond"}]}', 'schema'],
    ['{"prefixes":[{"chunkId":"$ID","context":"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one"}]}', 'token-limit'],
  ] as const)('falls back for invalid output %s', async (raw, failureType) => {
    const selected = { ...plan(), batches: plan().batches.slice(0, 1) }
    const id = selected.batches[0]!.candidateChunkIds[0]!
    const cache = new MemoryCache()
    const result = await executeContextualPrefixPlan(selected, generator(() => Promise.resolve({
      output: raw.replace('$ID', id),
      inputTokens: 10,
      outputTokens: 2,
      latencyMs: 1,
    })), cache, { ...executionOptions, budgetAction: 'deterministic-fallback' })

    expect(result.values).toEqual([{
      chunkId: id,
      sourceTextSha256: createHash('sha256').update(selected.batches[0]!.request.targets[0]!.text).digest('hex'),
      status: 'fallback',
    }])
    expect(cache.failures[0]?.failure.failureType).toBe(failureType)
    expect(cache.successes).toHaveLength(0)
  })

  it('rejects a copied source span and records it before deterministic fallback', async () => {
    const base = plan()
    const batch = base.batches[0]!
    const copied = 'This source passage is deliberately longer than eighty characters so the copy detector can reject a large repeated span from the target chunk.'
    const changedBatch = {
      ...batch,
      request: {
        ...batch.request,
        targets: [{ id: batch.candidateChunkIds[0]!, text: copied }],
        maxPrefixTokens: 100,
      },
    }
    const selected = { ...base, batches: [changedBatch] }
    const cache = new MemoryCache()
    const result = await executeContextualPrefixPlan(selected, generator(request => Promise.resolve({
      output: JSON.stringify({ prefixes: [{ chunkId: request.targets[0]!.id, context: copied }] }),
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 1,
    })), cache, { ...executionOptions, budgetAction: 'deterministic-fallback' })

    expect(result.fallbackCount).toBe(1)
    expect(cache.failures[0]?.failure.failureType).toBe('chunk-copy')
  })

  it('measures every cache miss and rejects an oversized plan before generation', async () => {
    const cache = new MemoryCache()
    const generate = vi.fn<ContextualPrefixGenerator['generate']>()
    const countTokens = vi.fn(() => Promise.resolve(101))
    await expect(executeContextualPrefixPlan(plan(), {
      ...generator(generate),
      countTokens,
    }, cache, { ...executionOptions, maxInputTokens: 200 })).rejects.toThrow('measured plan exceeds')
    expect(countTokens).toHaveBeenCalledTimes(2)
    expect(generate).not.toHaveBeenCalled()
  })

  it('keeps candidate order when a valid response returns several prefixes in reverse order', async () => {
    const base = plan()
    const left = base.batches[0]!
    const right = base.batches[1]!
    const batch = {
      ...left,
      candidateChunkIds: [left.candidateChunkIds[0]!, right.candidateChunkIds[0]!],
      maximumOutputTokens: 168,
      request: {
        ...left.request,
        targets: [left.request.targets[0]!, right.request.targets[0]!],
      },
    }
    const selected = { ...base, batches: [batch] }
    const result = await executeContextualPrefixPlan(selected, generator(request => Promise.resolve({
      output: JSON.stringify({
        prefixes: [...request.targets].reverse().map(target => ({ chunkId: target.id, context: `Context ${target.id}` })),
      }),
      inputTokens: 10,
      outputTokens: 4,
      latencyMs: 1,
    })), new MemoryCache(), executionOptions)

    expect(result.values.map(value => value.chunkId)).toEqual(batch.candidateChunkIds)
  })

  it('stops before an unaffordable retry and can fall back after actual usage exceeds the budget', async () => {
    const selected = { ...plan(), batches: plan().batches.slice(0, 1) }
    const retryCache = new MemoryCache()
    const retry = await executeContextualPrefixPlan(selected, {
      ...generator(() => Promise.reject(new ContextualPrefixGenerationError('spent', 10, 0, 1))),
      countTokens: () => Promise.resolve(1),
    }, retryCache, {
      ...executionOptions,
      maxInputTokens: 10,
      maxRetries: 1,
      budgetAction: 'deterministic-fallback',
    })
    expect(retry).toMatchObject({ requestCount: 1, retryCount: 0, fallbackCount: 1, inputTokens: 10 })
    expect(retryCache.failures.map(value => value.failure.failureType)).toEqual(['request', 'budget'])

    const overageCache = new MemoryCache()
    const overage = await executeContextualPrefixPlan(selected, {
      ...generator(request => Promise.resolve({ output: output(request), inputTokens: 11, outputTokens: 1, latencyMs: 1 })),
      countTokens: () => Promise.resolve(1),
    }, overageCache, {
      ...executionOptions,
      maxInputTokens: 10,
      budgetAction: 'deterministic-fallback',
    })
    expect(overage.fallbackCount).toBe(1)
    expect(overageCache.failures[0]?.failure.failureType).toBe('budget')
  })

  it('stops between batches while preserving the first committed success', async () => {
    const cache = new MemoryCache()
    const controller = new AbortController()
    const generate = vi.fn<ContextualPrefixGenerator['generate']>((request) => {
      controller.abort()
      return Promise.resolve({ output: output(request), inputTokens: 10, outputTokens: 2, latencyMs: 1 })
    })
    await expect(executeContextualPrefixPlan(plan(), generator(generate), cache, {
      ...executionOptions,
      signal: controller.signal,
    })).rejects.toThrow('was cancelled')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(cache.successes.size).toBe(1)
  })

  it('validates generator identity, execution limits, measured counts, usage, and strict failure mode', async () => {
    const selected = { ...plan(), batches: plan().batches.slice(0, 1) }
    const cache = new MemoryCache()
    await expect(executeContextualPrefixPlan(selected, { ...generator(vi.fn()), modelId: ' ' }, cache, executionOptions))
      .rejects.toThrow('modelId')
    await expect(executeContextualPrefixPlan(selected, { ...generator(vi.fn()), revision: '' }, cache, executionOptions))
      .rejects.toThrow('revision')
    await expect(executeContextualPrefixPlan(
      selected,
      { ...generator(vi.fn()), parameters: { temperature: Number.NaN } },
      cache,
      executionOptions,
    ))
      .rejects.toThrow('parameters')
    await expect(executeContextualPrefixPlan(selected, {
      ...generator(vi.fn()),
      parameters: { '': true },
    }, cache, executionOptions)).rejects.toThrow('parameters')
    await expect(executeContextualPrefixPlan(selected, generator(vi.fn()), cache, { ...executionOptions, maxRetries: -1 }))
      .rejects.toThrow('maxRetries')
    await expect(executeContextualPrefixPlan(selected, generator(vi.fn()), cache, {
      ...executionOptions,
      budgetAction: 'future' as 'fail',
    })).rejects.toThrow('budgetAction')
    await expect(executeContextualPrefixPlan(selected, {
      ...generator(vi.fn()),
      countTokens: () => Promise.resolve(0),
    }, cache, executionOptions)).rejects.toThrow('counted request tokens')
    await expect(executeContextualPrefixPlan(selected, generator(() => Promise.resolve({
      output: '{}', inputTokens: 0, outputTokens: 0, latencyMs: 0,
    })), cache, executionOptions)).rejects.toThrow('inputTokens')
    await expect(executeContextualPrefixPlan(selected, generator(() => Promise.reject(new Error('offline'))), cache, executionOptions))
      .rejects.toThrow('offline')
    await expect(executeContextualPrefixPlan(selected, generator(() => rejectWithUnknown('offline string')), cache, executionOptions))
      .rejects.toThrow('offline string')
    await expect(executeContextualPrefixPlan(selected, generator(() => Promise.resolve({
      output: 1 as unknown as string, inputTokens: 1, outputTokens: 0, latencyMs: 0,
    })), cache, executionOptions)).rejects.toThrow('invalid output')
    await expect(executeContextualPrefixPlan(selected, generator(request => Promise.resolve({
      output: output(request), inputTokens: 1, outputTokens: 0, latencyMs: Number.NaN,
    })), cache, executionOptions)).rejects.toThrow('latencyMs')
  })

  it('changes the content address for model, detector, window, parameters, and exact request bytes', () => {
    const base = plan()
    const batch = base.batches[0]!
    const fixed = generator(vi.fn())
    const key = contextualPrefixCacheKey(base, batch, fixed)
    expect(key).toMatch(/^[a-f0-9]{64}$/u)
    expect(contextualPrefixCacheKey(base, batch, { ...fixed, revision: 'b'.repeat(40) })).not.toBe(key)
    expect(contextualPrefixCacheKey(base, batch, { ...fixed, parameters: { store: false, temperature: 1 } })).not.toBe(key)
    expect(contextualPrefixCacheKey({ ...base, detector: 'strict-v1', contextWindowTokens: 33 }, batch, fixed)).not.toBe(key)
    expect(contextualPrefixCacheKey(base, {
      ...batch,
      request: { ...batch.request, promptVersion: 'other' },
    }, fixed)).not.toBe(key)
    expect(contextualPrefixCacheKey(base, {
      ...batch,
      request: {
        ...batch.request,
        document: { ...batch.request.document, title: 'Changed title' },
      },
    }, fixed)).not.toBe(key)
    expect(contextualPrefixCacheKey(base, {
      ...batch,
      request: {
        ...batch.request,
        context: batch.request.context.map((chunk, index) => index === 0 ? { ...chunk, text: `${chunk.text} changed` } : chunk),
      },
    }, fixed)).not.toBe(key)
    expect(contextualPrefixCacheKey(base, {
      ...batch,
      request: { ...batch.request, sectionPath: 'Changed section' },
    }, fixed)).not.toBe(key)
    expect(contextualPrefixCacheKey(base, {
      ...batch,
      request: { ...batch.request, maxPrefixTokens: batch.request.maxPrefixTokens + 1 },
    }, fixed)).not.toBe(key)
    expect(contextualPrefixCacheKey(base, batch, {
      ...fixed,
      parameters: { store: false, temperature: 0 },
    })).toBe(key)
    expect(contextualPrefixCacheKey(base, batch, { ...fixed, parameters: { z: 1, a: 2 } })).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => contextualPrefixCacheKey(base, batch, {
      ...fixed,
      parameters: { invalid: (() => undefined) as unknown as string },
    })).toThrow('unsupported value')
    expect(() => contextualPrefixCacheKey(base, {
      ...batch,
      request: { ...batch.request, maxPrefixTokens: Number.NaN },
    }, fixed)).toThrow('non-finite number')
  })
})

describe('contextual prefix cache', () => {
  it('persists successes, leaves failures audit-only, and reopens cleanly', async () => {
    const directory = await temporaryDirectory()
    const key = 'a'.repeat(64)
    const value: ContextualPrefixCachedSuccess = {
      schemaVersion: 1,
      prefixes: [{ chunkId: 'chunk', context: 'Document-specific context.' }],
      inputTokens: 12,
      outputTokens: 3,
      latencyMs: 7.5,
      outputSha256: createHash('sha256').update('output').digest('hex'),
    }
    const cache = await ContextualPrefixCache.open(directory)
    expect(cache.get(key, ['chunk'])).toBeUndefined()
    cache.recordFailure(key, {
      attempt: 1,
      failureType: 'request',
      message: 'temporary',
      inputTokens: 2,
      outputTokens: 0,
      latencyMs: 1,
    })
    expect(cache.get(key, ['chunk'])).toBeUndefined()
    expect(cache.failureCount(key)).toBe(1)
    expect(cache.put(key, value)).toBe(true)
    expect(cache.put(key, value)).toBe(false)
    cache.close()

    const reopened = await ContextualPrefixCache.open(directory)
    expect(reopened.get(key, ['chunk'])).toEqual(value)
    expect(reopened.failureCount(key)).toBe(1)
    reopened.close()
    reopened.close()
  })

  it('rejects corrupted payloads and incompatible chunk identities', async () => {
    const directory = await temporaryDirectory()
    const key = 'b'.repeat(64)
    const value: ContextualPrefixCachedSuccess = {
      schemaVersion: 1,
      prefixes: [{ chunkId: 'chunk', context: 'Context.' }],
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      outputSha256: 'c'.repeat(64),
    }
    const cache = await ContextualPrefixCache.open(directory)
    cache.put(key, value)
    expect(() => cache.get(key, ['other'])).toThrow('incompatible chunk identities')
    cache.close()

    const database = new DatabaseSync(join(directory, CONTEXTUAL_PREFIX_CACHE_FILE))
    database.prepare('UPDATE successful_batches SET payload = ? WHERE cache_key = ?').run(Buffer.from('{}'), key)
    database.close()
    const corrupted = await ContextualPrefixCache.open(directory)
    expect(() => corrupted.get(key, ['chunk'])).toThrow('payload digest mismatch')
    corrupted.close()
  })

  it('rejects every malformed durable payload field', async () => {
    const corrupt = async (transform: (payload: Record<string, unknown>) => unknown, message: string) => {
      const directory = await temporaryDirectory()
      const key = 'd'.repeat(64)
      const value: ContextualPrefixCachedSuccess = {
        schemaVersion: 1,
        prefixes: [{ chunkId: 'chunk', context: 'Context.' }],
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        outputSha256: 'e'.repeat(64),
      }
      const cache = await ContextualPrefixCache.open(directory)
      cache.put(key, value)
      cache.close()
      const database = new DatabaseSync(join(directory, CONTEXTUAL_PREFIX_CACHE_FILE))
      const row = database.prepare('SELECT payload FROM successful_batches WHERE cache_key = ?').get(key) as { payload: Uint8Array }
      const original = JSON.parse(Buffer.from(row.payload).toString('utf8')) as Record<string, unknown>
      const changed = transform(original)
      const payload = Buffer.from(typeof changed === 'string' ? changed : JSON.stringify(changed))
      database.prepare('UPDATE successful_batches SET payload = ?, payload_sha256 = ? WHERE cache_key = ?').run(
        payload,
        createHash('sha256').update(payload).digest('hex'),
        key,
      )
      database.close()
      const reopened = await ContextualPrefixCache.open(directory)
      expect(() => reopened.get(key, ['chunk'])).toThrow(message)
      reopened.close()
    }

    await corrupt(() => '{', 'invalid JSON')
    await corrupt(() => null, 'invalid payload')
    await corrupt(value => ({ ...value, extra: true }), 'invalid payload fields')
    await corrupt(value => ({ ...value, schemaVersion: 2 }), 'invalid schema version')
    await corrupt(value => ({ ...value, prefixes: {} }), 'invalid prefixes')
    await corrupt(value => ({ ...value, prefixes: [null] }), 'invalid prefix')
    await corrupt(value => ({ ...value, prefixes: [{ chunkId: 'chunk', context: 'Context.', extra: true }] }), 'invalid prefix fields')
    await corrupt(value => ({ ...value, prefixes: [{ chunkId: 'chunk', context: '' }] }), 'invalid prefix text')
    await corrupt(value => ({ ...value, prefixes: [] }), 'incompatible chunk identities')
    await corrupt(value => ({ ...value, outputSha256: 'bad' }), 'invalid output digest')
    await corrupt(value => ({ ...value, inputTokens: -1 }), 'invalid input token count')
    await corrupt(value => ({ ...value, latencyMs: Number.NaN }), 'invalid latency')
  })

  it('rejects an incompatible schema version', async () => {
    const directory = await temporaryDirectory()
    const database = new DatabaseSync(join(directory, CONTEXTUAL_PREFIX_CACHE_FILE))
    database.exec('PRAGMA user_version = 2')
    database.close()
    await expect(ContextualPrefixCache.open(directory)).rejects.toThrow('schema version must be 1')
  })
})
