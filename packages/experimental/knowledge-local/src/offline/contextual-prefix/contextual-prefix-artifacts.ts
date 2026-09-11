/** Reviewable plan and generation-record files for optional contextual prefixes. */

import { createHash } from 'node:crypto'
import type { ChunkingStrategy } from '../../chunker.ts'
import type { ContextualPrefixExecution } from './contextual-prefix-generation.ts'
import { contextualPrefixRequestOutputTokens } from './contextual-prefix.ts'
import type {
  ContextualAmbiguitySignal,
  ContextualPrefixBatch,
  ContextualPrefixPlan,
  ContextualPrefixRequest,
} from './contextual-prefix.ts'

/** Corpus and chunking identity recorded before any remote generation. */
export interface ContextualPrefixPlanArtifact {
  readonly schemaVersion: 1
  readonly corpus: {
    readonly sha256: string
    readonly format: 'generic' | 'scifact' | 'mldr' | 't2ranking'
    readonly documentCount: number
  }
  readonly chunking: {
    readonly tokenizerModelId: string
    readonly tokenizerRevision: string
    readonly maxTokens: number
    readonly overlapTokens: number
    readonly strategy: ChunkingStrategy
  }
  readonly plan: ContextualPrefixPlan
}

/** Metered generated values tied to the exact bytes of one reviewed plan file. */
export interface ContextualPrefixRecordsArtifact {
  readonly schemaVersion: 1
  readonly planSha256: string
  readonly generator: {
    readonly modelId: string
    readonly revision: string
    readonly parameters: Readonly<Record<string, string | number | boolean>>
  }
  readonly execution: ContextualPrefixExecution
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`knowledge-local: ${subject} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], subject: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`knowledge-local: ${subject} fields are invalid`)
  }
}

function array(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`knowledge-local: ${subject} must be an array`)
  return value
}

function string(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`knowledge-local: ${subject} must be a non-empty string`)
  }
  return value
}

function integer(value: unknown, subject: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`knowledge-local: ${subject} must be a safe integer of at least ${minimum}`)
  }
  return value as number
}

function finite(value: unknown, subject: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`knowledge-local: ${subject} must be a finite number of at least ${minimum}`)
  }
  return value
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], subject: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`knowledge-local: ${subject} is unsupported`)
  }
  return value as T
}

function digest(value: unknown, subject: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`knowledge-local: ${subject} must be SHA-256`)
  }
  return value
}

function parseJson(text: string, subject: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new TypeError(`knowledge-local: ${subject} is not valid JSON`, { cause: error })
  }
}

function parseRequestChunk(value: unknown, subject: string): { readonly id: string; readonly text: string } {
  const item = record(value, subject)
  exactFields(item, ['id', 'text'], subject)
  return { id: string(item['id'], `${subject}.id`), text: string(item['text'], `${subject}.text`) }
}

function parseRequest(value: unknown, subject: string): ContextualPrefixRequest {
  const item = record(value, subject)
  const hasSection = item['sectionPath'] !== undefined
  exactFields(
    item,
    hasSection
      ? ['schemaVersion', 'promptVersion', 'document', 'sectionPath', 'context', 'targets', 'maxPrefixTokens']
      : ['schemaVersion', 'promptVersion', 'document', 'context', 'targets', 'maxPrefixTokens'],
    subject,
  )
  if (item['schemaVersion'] !== 1) throw new TypeError(`knowledge-local: ${subject}.schemaVersion must be 1`)
  const document = record(item['document'], `${subject}.document`)
  const optionalDocumentFields = ['title', 'source', 'sourceVersion', 'validFrom', 'validUntil']
    .filter(field => document[field] !== undefined)
  exactFields(document, ['id', ...optionalDocumentFields], `${subject}.document`)
  return {
    schemaVersion: 1,
    promptVersion: string(item['promptVersion'], `${subject}.promptVersion`),
    document: {
      id: string(document['id'], `${subject}.document.id`),
      ...(document['title'] === undefined ? {} : { title: string(document['title'], `${subject}.document.title`) }),
      ...(document['source'] === undefined ? {} : { source: string(document['source'], `${subject}.document.source`) }),
      ...(document['sourceVersion'] === undefined
        ? {}
        : { sourceVersion: string(document['sourceVersion'], `${subject}.document.sourceVersion`) }),
      ...(document['validFrom'] === undefined
        ? {}
        : { validFrom: string(document['validFrom'], `${subject}.document.validFrom`) }),
      ...(document['validUntil'] === undefined
        ? {}
        : { validUntil: string(document['validUntil'], `${subject}.document.validUntil`) }),
    },
    ...(hasSection ? { sectionPath: string(item['sectionPath'], `${subject}.sectionPath`) } : {}),
    context: array(item['context'], `${subject}.context`)
      .map((entry, index) => parseRequestChunk(entry, `${subject}.context[${index}]`)),
    targets: array(item['targets'], `${subject}.targets`)
      .map((entry, index) => parseRequestChunk(entry, `${subject}.targets[${index}]`)),
    maxPrefixTokens: integer(item['maxPrefixTokens'], `${subject}.maxPrefixTokens`, 1),
  }
}

function parseBatch(value: unknown, index: number): ContextualPrefixBatch {
  const subject = `contextual prefix plan.batches[${index}]`
  const item = record(value, subject)
  exactFields(item, [
    'id', 'request', 'candidateChunkIds', 'risk', 'estimatedInputTokens', 'maximumOutputTokens',
  ], subject)
  const request = parseRequest(item['request'], `${subject}.request`)
  const candidateChunkIds = array(item['candidateChunkIds'], `${subject}.candidateChunkIds`)
    .map((entry, entryIndex) => string(entry, `${subject}.candidateChunkIds[${entryIndex}]`))
  if (candidateChunkIds.length === 0 || candidateChunkIds.length !== new Set(candidateChunkIds).size) {
    throw new TypeError(`knowledge-local: ${subject}.candidateChunkIds must be non-empty and unique`)
  }
  if (candidateChunkIds.length !== request.targets.length
    || candidateChunkIds.some((id, targetIndex) => id !== request.targets[targetIndex]?.id)) {
    throw new TypeError(`knowledge-local: ${subject} targets do not match candidateChunkIds`)
  }
  const risk = integer(item['risk'], `${subject}.risk`, 1)
  if (risk > 4) throw new TypeError(`knowledge-local: ${subject}.risk must be at most 4`)
  const maximumOutputTokens = integer(item['maximumOutputTokens'], `${subject}.maximumOutputTokens`, 1)
  if (maximumOutputTokens !== contextualPrefixRequestOutputTokens(request)) {
    throw new TypeError(`knowledge-local: ${subject}.maximumOutputTokens is inconsistent`)
  }
  return {
    id: digest(item['id'], `${subject}.id`),
    request,
    candidateChunkIds,
    risk: risk as 1 | 2 | 3 | 4,
    estimatedInputTokens: integer(item['estimatedInputTokens'], `${subject}.estimatedInputTokens`, 1),
    maximumOutputTokens,
  }
}

function parsePlan(value: unknown): ContextualPrefixPlan {
  const subject = 'contextual prefix plan'
  const item = record(value, subject)
  exactFields(item, [
    'schemaVersion', 'detector', 'target', 'promptVersion', 'contextWindowTokens', 'maxPrefixTokens', 'totalChunkCount',
    'detectedCandidateCount', 'selectedCandidateCount', 'fallbackCandidateCount', 'candidateRatio',
    'estimatedInputTokens', 'maximumOutputTokens', 'signals', 'batches', 'fallbacks',
  ], subject)
  if (item['schemaVersion'] !== 1) throw new TypeError('knowledge-local: contextual prefix plan.schemaVersion must be 1')
  const signalNames: readonly ContextualAmbiguitySignal[] = [
    'cross-reference', 'leading-reference', 'relative-time', 'continuation', 'weak-structure',
  ]
  const rawSignals = record(item['signals'], `${subject}.signals`)
  exactFields(rawSignals, signalNames, `${subject}.signals`)
  const signals = Object.fromEntries(signalNames.map(name => [
    name,
    integer(rawSignals[name], `${subject}.signals.${name}`),
  ])) as Record<ContextualAmbiguitySignal, number>
  const batches = array(item['batches'], `${subject}.batches`).map(parseBatch)
  const fallbacks = array(item['fallbacks'], `${subject}.fallbacks`).map((value, index) => {
    const fallbackSubject = `${subject}.fallbacks[${index}]`
    const fallback = record(value, fallbackSubject)
    exactFields(fallback, ['chunkId', 'sourceTextSha256'], fallbackSubject)
    return {
      chunkId: string(fallback['chunkId'], `${fallbackSubject}.chunkId`),
      sourceTextSha256: digest(fallback['sourceTextSha256'], `${fallbackSubject}.sourceTextSha256`),
    }
  })
  const selectedCandidateCount = integer(item['selectedCandidateCount'], `${subject}.selectedCandidateCount`)
  const fallbackCandidateCount = integer(item['fallbackCandidateCount'], `${subject}.fallbackCandidateCount`)
  const detectedCandidateCount = integer(item['detectedCandidateCount'], `${subject}.detectedCandidateCount`)
  if (selectedCandidateCount !== batches.reduce((sum, batch) => sum + batch.candidateChunkIds.length, 0)
    || fallbackCandidateCount !== fallbacks.length
    || detectedCandidateCount !== selectedCandidateCount + fallbackCandidateCount) {
    throw new TypeError('knowledge-local: contextual prefix plan candidate counts are inconsistent')
  }
  const promptVersion = string(item['promptVersion'], `${subject}.promptVersion`)
  const contextWindowTokens = integer(item['contextWindowTokens'], `${subject}.contextWindowTokens`, 1)
  const maxPrefixTokens = integer(item['maxPrefixTokens'], `${subject}.maxPrefixTokens`, 1)
  const candidateRatio = finite(item['candidateRatio'], `${subject}.candidateRatio`)
  if (candidateRatio > 1) throw new TypeError('knowledge-local: contextual prefix plan.candidateRatio must be at most one')
  if (batches.some(batch => batch.request.promptVersion !== promptVersion
    || batch.request.maxPrefixTokens !== maxPrefixTokens)) {
    throw new TypeError('knowledge-local: contextual prefix plan batch configuration is inconsistent')
  }
  const estimatedInputTokens = integer(item['estimatedInputTokens'], `${subject}.estimatedInputTokens`)
  const maximumOutputTokens = integer(item['maximumOutputTokens'], `${subject}.maximumOutputTokens`)
  if (estimatedInputTokens !== batches.reduce((sum, batch) => sum + batch.estimatedInputTokens, 0)
    || maximumOutputTokens !== batches.reduce((sum, batch) => sum + batch.maximumOutputTokens, 0)) {
    throw new TypeError('knowledge-local: contextual prefix plan token totals are inconsistent')
  }
  return {
    schemaVersion: 1,
    detector: enumeration(item['detector'], ['strict-v1'], `${subject}.detector`),
    target: enumeration(item['target'], ['dense', 'bm25-and-dense'], `${subject}.target`),
    promptVersion,
    contextWindowTokens,
    maxPrefixTokens,
    totalChunkCount: integer(item['totalChunkCount'], `${subject}.totalChunkCount`),
    detectedCandidateCount,
    selectedCandidateCount,
    fallbackCandidateCount,
    candidateRatio,
    estimatedInputTokens,
    maximumOutputTokens,
    signals,
    batches,
    fallbacks,
  }
}

/**
 * Render stable, reviewable JSON whose exact bytes are used by generation records.
 * @param value - Plan or generation-record artifact to serialize.
 * @returns Pretty-printed JSON ending with one newline.
 */
export function renderContextualPrefixArtifact(value: ContextualPrefixPlanArtifact | ContextualPrefixRecordsArtifact): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Compute the lowercase SHA-256 identity used to bind records to a plan file.
 * @param text - Exact serialized plan bytes interpreted as UTF-8 text.
 * @returns Lowercase SHA-256 hexadecimal digest.
 */
export function contextualPrefixArtifactSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Parse and validate one externally supplied contextual-prefix plan file.
 * @param text - Complete plan file contents.
 * @returns Validated version-one plan artifact.
 */
export function parseContextualPrefixPlanArtifact(text: string): ContextualPrefixPlanArtifact {
  const item = record(parseJson(text, 'contextual prefix plan file'), 'contextual prefix plan file')
  exactFields(item, ['schemaVersion', 'corpus', 'chunking', 'plan'], 'contextual prefix plan file')
  if (item['schemaVersion'] !== 1) throw new TypeError('knowledge-local: contextual prefix plan file schemaVersion must be 1')
  const corpus = record(item['corpus'], 'contextual prefix plan file.corpus')
  exactFields(corpus, ['sha256', 'format', 'documentCount'], 'contextual prefix plan file.corpus')
  const chunking = record(item['chunking'], 'contextual prefix plan file.chunking')
  exactFields(
    chunking,
    ['tokenizerModelId', 'tokenizerRevision', 'maxTokens', 'overlapTokens', 'strategy'],
    'contextual prefix plan file.chunking',
  )
  const maxTokens = integer(chunking['maxTokens'], 'contextual prefix plan file.chunking.maxTokens', 1)
  const overlapTokens = integer(chunking['overlapTokens'], 'contextual prefix plan file.chunking.overlapTokens')
  if (overlapTokens >= maxTokens) {
    throw new TypeError('knowledge-local: contextual prefix plan file chunk overlap must be below maxTokens')
  }
  return {
    schemaVersion: 1,
    corpus: {
      sha256: digest(corpus['sha256'], 'contextual prefix plan file.corpus.sha256'),
      format: enumeration(corpus['format'], ['generic', 'scifact', 'mldr', 't2ranking'], 'contextual prefix corpus format'),
      documentCount: integer(corpus['documentCount'], 'contextual prefix plan file.corpus.documentCount'),
    },
    chunking: {
      tokenizerModelId: string(chunking['tokenizerModelId'], 'contextual prefix tokenizerModelId'),
      tokenizerRevision: string(chunking['tokenizerRevision'], 'contextual prefix tokenizerRevision'),
      maxTokens,
      overlapTokens,
      strategy: enumeration(
        chunking['strategy'],
        ['token-window-v1', 'markdown-structure-v1'],
        'contextual prefix chunking strategy',
      ),
    },
    plan: parsePlan(item['plan']),
  }
}

function parseParameters(value: unknown): Readonly<Record<string, string | number | boolean>> {
  const parameters = record(value, 'contextual prefix records generator.parameters')
  for (const [name, parameter] of Object.entries(parameters)) {
    if (name.length === 0
      || (typeof parameter !== 'string' && typeof parameter !== 'number' && typeof parameter !== 'boolean')
      || (typeof parameter === 'number' && !Number.isFinite(parameter))) {
      throw new TypeError('knowledge-local: contextual prefix records generator parameters are invalid')
    }
  }
  return parameters as Readonly<Record<string, string | number | boolean>>
}

function parseExecution(value: unknown): ContextualPrefixExecution {
  const subject = 'contextual prefix records execution'
  const item = record(value, subject)
  const countFields = [
    'cacheQueryCount', 'cacheHitCount', 'generatedCount', 'fallbackCount', 'requestCount', 'retryCount',
    'plannedInputTokens', 'plannedMaximumOutputTokens', 'inputTokens', 'outputTokens', 'cacheSavedInputTokens',
    'cacheSavedOutputTokens',
  ] as const
  exactFields(item, ['values', ...countFields, 'latencyMs'], subject)
  const values = array(item['values'], `${subject}.values`).map((value, index) => {
    const valueSubject = `${subject}.values[${index}]`
    const entry = record(value, valueSubject)
    const status = enumeration(entry['status'], ['generated', 'cache-hit', 'fallback'], `${valueSubject}.status`)
    exactFields(
      entry,
      status === 'fallback'
        ? ['chunkId', 'sourceTextSha256', 'status']
        : ['chunkId', 'sourceTextSha256', 'status', 'context'],
      valueSubject,
    )
    return {
      chunkId: string(entry['chunkId'], `${valueSubject}.chunkId`),
      sourceTextSha256: digest(entry['sourceTextSha256'], `${valueSubject}.sourceTextSha256`),
      status,
      ...(status === 'fallback' ? {} : { context: string(entry['context'], `${valueSubject}.context`) }),
    }
  })
  const counts = Object.fromEntries(
    countFields.map(name => [name, integer(item[name], `${subject}.${name}`)]),
  ) as Record<(typeof countFields)[number], number>
  if (new Set(values.map(entry => entry.chunkId)).size !== values.length
    || counts['cacheHitCount'] !== values.filter(entry => entry.status === 'cache-hit').length
    || counts['generatedCount'] !== values.filter(entry => entry.status === 'generated').length
    || counts['fallbackCount'] !== values.filter(entry => entry.status === 'fallback').length) {
    throw new TypeError('knowledge-local: contextual prefix records execution counts are inconsistent')
  }
  return {
    values,
    cacheQueryCount: counts['cacheQueryCount'],
    cacheHitCount: counts['cacheHitCount'],
    generatedCount: counts['generatedCount'],
    fallbackCount: counts['fallbackCount'],
    requestCount: counts['requestCount'],
    retryCount: counts['retryCount'],
    plannedInputTokens: counts['plannedInputTokens'],
    plannedMaximumOutputTokens: counts['plannedMaximumOutputTokens'],
    inputTokens: counts['inputTokens'],
    outputTokens: counts['outputTokens'],
    cacheSavedInputTokens: counts['cacheSavedInputTokens'],
    cacheSavedOutputTokens: counts['cacheSavedOutputTokens'],
    latencyMs: finite(item['latencyMs'], `${subject}.latencyMs`),
  }
}

/**
 * Parse and validate one externally supplied contextual-prefix generation record file.
 * @param text - Complete generation-record file contents.
 * @returns Validated version-one generation-record artifact.
 */
export function parseContextualPrefixRecordsArtifact(text: string): ContextualPrefixRecordsArtifact {
  const item = record(parseJson(text, 'contextual prefix records file'), 'contextual prefix records file')
  exactFields(item, ['schemaVersion', 'planSha256', 'generator', 'execution'], 'contextual prefix records file')
  if (item['schemaVersion'] !== 1) {
    throw new TypeError('knowledge-local: contextual prefix records file schemaVersion must be 1')
  }
  const generator = record(item['generator'], 'contextual prefix records generator')
  exactFields(generator, ['modelId', 'revision', 'parameters'], 'contextual prefix records generator')
  return {
    schemaVersion: 1,
    planSha256: digest(item['planSha256'], 'contextual prefix records planSha256'),
    generator: {
      modelId: string(generator['modelId'], 'contextual prefix records generator.modelId'),
      revision: string(generator['revision'], 'contextual prefix records generator.revision'),
      parameters: parseParameters(generator['parameters']),
    },
    execution: parseExecution(item['execution']),
  }
}
