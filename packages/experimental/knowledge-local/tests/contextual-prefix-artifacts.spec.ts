import { describe, expect, it } from 'vitest'
import {
  contextualPrefixArtifactSha256,
  parseContextualPrefixPlanArtifact,
  parseContextualPrefixRecordsArtifact,
  renderContextualPrefixArtifact,
  type ContextualPrefixPlanArtifact,
  type ContextualPrefixRecordsArtifact,
} from '../src/offline/contextual-prefix/contextual-prefix-artifacts.ts'

const request = {
  schemaVersion: 1 as const,
  promptVersion: 'prefix-v1',
  document: {
    id: 'doc',
    title: 'Title',
    source: 'source',
    sourceVersion: 'v1',
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: '2027-01-01T00:00:00Z',
  },
  sectionPath: 'Section',
  context: [{ id: 'doc:0-3', text: 'It needs context.' }],
  targets: [{ id: 'doc:0-3', text: 'It needs context.' }],
  maxPrefixTokens: 20,
}

const planArtifact: ContextualPrefixPlanArtifact = {
  schemaVersion: 1,
  corpus: { sha256: 'a'.repeat(64), format: 'generic', documentCount: 1 },
  chunking: {
    tokenizerModelId: 'tokenizer',
    tokenizerRevision: 'revision',
    maxTokens: 384,
    overlapTokens: 64,
    strategy: 'markdown-structure-v1',
  },
  plan: {
    schemaVersion: 1,
    detector: 'strict-v1',
    target: 'dense',
    promptVersion: 'prefix-v1',
    contextWindowTokens: 512,
    maxPrefixTokens: 20,
    totalChunkCount: 2,
    detectedCandidateCount: 2,
    selectedCandidateCount: 1,
    fallbackCandidateCount: 1,
    candidateRatio: 1,
    estimatedInputTokens: 10,
    maximumOutputTokens: 148,
    signals: {
      'cross-reference': 0,
      'leading-reference': 2,
      'relative-time': 0,
      continuation: 0,
      'weak-structure': 1,
    },
    batches: [{
      id: 'b'.repeat(64),
      request,
      candidateChunkIds: ['doc:0-3'],
      risk: 3,
      estimatedInputTokens: 10,
      maximumOutputTokens: 148,
    }],
    fallbacks: [{ chunkId: 'doc:3-6', sourceTextSha256: 'c'.repeat(64) }],
  },
}

const recordsArtifact: ContextualPrefixRecordsArtifact = {
  schemaVersion: 1,
  planSha256: 'd'.repeat(64),
  generator: {
    modelId: 'model',
    revision: 'revision',
    parameters: { temperature: 0, store: false, mode: 'json' },
  },
  execution: {
    values: [
      { chunkId: 'doc:0-3', sourceTextSha256: 'e'.repeat(64), status: 'generated', context: 'A context.' },
      { chunkId: 'doc:3-6', sourceTextSha256: 'c'.repeat(64), status: 'fallback' },
      { chunkId: 'doc:6-9', sourceTextSha256: 'f'.repeat(64), status: 'cache-hit', context: 'Cached context.' },
    ],
    cacheQueryCount: 1,
    cacheHitCount: 1,
    generatedCount: 1,
    fallbackCount: 1,
    requestCount: 1,
    retryCount: 0,
    plannedInputTokens: 10,
    plannedMaximumOutputTokens: 148,
    inputTokens: 8,
    outputTokens: 3,
    cacheSavedInputTokens: 0,
    cacheSavedOutputTokens: 0,
    latencyMs: 2.5,
  },
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type Mutable<T> = { -readonly [Key in keyof T]: Mutable<T[Key]> }

describe('contextual prefix artifacts', () => {
  it('round-trips stable plan and record files', () => {
    const planText = renderContextualPrefixArtifact(planArtifact)
    expect(parseContextualPrefixPlanArtifact(planText)).toEqual(planArtifact)
    expect(contextualPrefixArtifactSha256(planText)).toMatch(/^[a-f0-9]{64}$/u)
    expect(parseContextualPrefixRecordsArtifact(renderContextualPrefixArtifact(recordsArtifact))).toEqual(recordsArtifact)
  })

  it('accepts requests without optional document and section fields', () => {
    const value = clone(planArtifact) as Mutable<ContextualPrefixPlanArtifact>
    const batch = value.plan.batches[0] as Mutable<ContextualPrefixPlanArtifact['plan']['batches'][number]>
    batch.request.document = { id: 'doc' }
    delete batch.request.sectionPath
    expect(parseContextualPrefixPlanArtifact(JSON.stringify(value)).plan.batches[0]?.request.document).toEqual({ id: 'doc' })
  })

  it.each([
    ['not-json', '{', 'not valid JSON'],
    ['non-object', '[]', 'must be an object'],
    ['top-fields', JSON.stringify({ ...planArtifact, extra: true }), 'fields are invalid'],
    ['top-version', JSON.stringify({ ...planArtifact, schemaVersion: 2 }), 'schemaVersion must be 1'],
    ['corpus-digest', JSON.stringify({ ...planArtifact, corpus: { ...planArtifact.corpus, sha256: 'bad' } }), 'must be SHA-256'],
    ['corpus-format', JSON.stringify({ ...planArtifact, corpus: { ...planArtifact.corpus, format: 'other' } }), 'format is unsupported'],
    ['empty-tokenizer', JSON.stringify({ ...planArtifact, chunking: { ...planArtifact.chunking, tokenizerModelId: '' } }), 'must be a non-empty string'],
    ['negative-documents', JSON.stringify({ ...planArtifact, corpus: { ...planArtifact.corpus, documentCount: -1 } }), 'safe integer'],
    ['overlap', JSON.stringify({ ...planArtifact, chunking: { ...planArtifact.chunking, overlapTokens: 384 } }), 'overlap must be below'],
    ['strategy', JSON.stringify({ ...planArtifact, chunking: { ...planArtifact.chunking, strategy: 'other' } }), 'strategy is unsupported'],
    ['plan-version', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, schemaVersion: 2 } }), 'plan.schemaVersion must be 1'],
    ['signals', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, signals: [] } }), 'signals must be an object'],
    ['counts', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, detectedCandidateCount: 1 } }), 'counts are inconsistent'],
    ['batches', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, batches: {} } }), 'batches must be an array'],
    ['batch-id', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, batches: [{ ...planArtifact.plan.batches[0], id: 'bad' }] } }), 'must be SHA-256'],
    ['batch-ids', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, batches: [{ ...planArtifact.plan.batches[0], candidateChunkIds: [] }] } }), 'must be non-empty and unique'],
    ['batch-targets', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, batches: [{ ...planArtifact.plan.batches[0], candidateChunkIds: ['other'] }] } }), 'targets do not match'],
    ['batch-risk', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, batches: [{ ...planArtifact.plan.batches[0], risk: 5 }] } }), 'risk must be at most 4'],
    ['request-version', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, batches: [{ ...planArtifact.plan.batches[0], request: { ...request, schemaVersion: 2 } }] } }), 'request.schemaVersion must be 1'],
    ['request-context', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, batches: [{ ...planArtifact.plan.batches[0], request: { ...request, context: [null] } }] } }), 'context[0] must be an object'],
    ['candidate-ratio', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, candidateRatio: 2 } }), 'candidateRatio must be at most one'],
    ['prompt-version', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, promptVersion: 'other' } }), 'batch configuration is inconsistent'],
    ['prefix-limit', JSON.stringify({ ...planArtifact, plan: { ...planArtifact.plan, maxPrefixTokens: 21 } }), 'batch configuration is inconsistent'],
    ['batch-output', JSON.stringify({
      ...planArtifact,
      plan: {
        ...planArtifact.plan,
        batches: [{ ...planArtifact.plan.batches[0], maximumOutputTokens: 147 }],
      },
    }), 'maximumOutputTokens is inconsistent'],
    ['plan-output', JSON.stringify({
      ...planArtifact,
      plan: { ...planArtifact.plan, maximumOutputTokens: 149 },
    }), 'token totals are inconsistent'],
  ])('rejects invalid plan artifact %s', (_name, text, message) => {
    expect(() => parseContextualPrefixPlanArtifact(text)).toThrow(message)
  })

  it.each([
    ['not-json', '{', 'not valid JSON'],
    ['top-version', JSON.stringify({ ...recordsArtifact, schemaVersion: 2 }), 'schemaVersion must be 1'],
    ['plan-digest', JSON.stringify({ ...recordsArtifact, planSha256: 'bad' }), 'must be SHA-256'],
    ['generator', JSON.stringify({ ...recordsArtifact, generator: [] }), 'generator must be an object'],
    ['parameters', JSON.stringify({ ...recordsArtifact, generator: { ...recordsArtifact.generator, parameters: { bad: null } } }), 'parameters are invalid'],
    ['execution', JSON.stringify({ ...recordsArtifact, execution: [] }), 'execution must be an object'],
    ['values', JSON.stringify({ ...recordsArtifact, execution: { ...recordsArtifact.execution, values: {} } }), 'values must be an array'],
    ['status', JSON.stringify({ ...recordsArtifact, execution: { ...recordsArtifact.execution, values: [{ ...recordsArtifact.execution.values[0], status: 'other' }] } }), 'status is unsupported'],
    ['fallback-context', JSON.stringify({ ...recordsArtifact, execution: { ...recordsArtifact.execution, values: [{ ...recordsArtifact.execution.values[1], context: 'bad' }, recordsArtifact.execution.values[0]] } }), 'fields are invalid'],
    ['count', JSON.stringify({ ...recordsArtifact, execution: { ...recordsArtifact.execution, generatedCount: 0 } }), 'counts are inconsistent'],
    ['latency', JSON.stringify({ ...recordsArtifact, execution: { ...recordsArtifact.execution, latencyMs: -1 } }), 'finite number'],
  ])('rejects invalid records artifact %s', (_name, text, message) => {
    expect(() => parseContextualPrefixRecordsArtifact(text)).toThrow(message)
  })
})
