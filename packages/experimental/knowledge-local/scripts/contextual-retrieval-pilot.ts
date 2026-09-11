/** Isolated evaluation support for the phase-six contextual-retrieval pilot. */

import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { MIXED_ZH_EN_ANALYZER } from '../src/bm25.ts'
import { buildBm25Index, searchBm25 } from '../src/offline/evaluation/in-memory-bm25.ts'
import { searchDense } from '../src/dense.ts'
import { DEFAULT_RRF_K, fuseRrf } from '../src/hybrid.ts'
import { longestCommonSubstring } from '../src/offline/text.ts'
import { retrievalText } from '../src/retrieval-text.ts'
import type { ChunkTokenizer } from '../src/tokenizer.ts'

/** Ambiguity families required by the fixed contextual-retrieval sample. */
export type ContextualAmbiguity =
  | 'pronoun-reference'
  | 'relative-time'
  | 'same-name-entity'
  | 'cross-section-ownership'
  | 'weak-title'

/** One fixed chunk whose boundaries remain identical across pilot strategies. */
export interface ContextualPilotChunk {
  readonly id: string
  readonly sectionPath?: string
  readonly text: string
}

/** One source document and the sampled chunks evaluated from it. */
export interface ContextualPilotDocument {
  readonly id: string
  readonly title?: string
  readonly sourceVersion?: string
  readonly validFrom?: string
  readonly validUntil?: string
  readonly text: string
  readonly chunks: readonly ContextualPilotChunk[]
}

/** One reviewed query, its complete required evidence, and its source document. */
export interface ContextualPilotSample {
  readonly schemaVersion: 1
  readonly id: string
  readonly ambiguity: ContextualAmbiguity
  readonly query: string
  readonly document: ContextualPilotDocument
  readonly evidence: readonly {
    readonly chunkId: string
    readonly quote: string
  }[]
}

/** Input supplied to a model without exposing any evaluation query. */
export interface ContextPrefixInput {
  readonly promptVersion: string
  readonly document: ContextualPilotDocument
  readonly chunk: ContextualPilotChunk
  readonly inputSha256: string
}

/** Raw response and metering returned by an injected prefix model. */
export interface ContextPrefixGeneration {
  readonly output: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: number
}

/** Model identity and operation used for one independent generation run. */
export interface ContextPrefixGenerator {
  readonly modelId: string
  readonly revision: string
  readonly parameters: Readonly<Record<string, string | number | boolean>>
  readonly generate: (input: ContextPrefixInput) => Promise<ContextPrefixGeneration>
}

/** Auditable outcome for one generated or fallback contextual prefix. */
export interface ContextPrefixRecord {
  readonly schemaVersion: 1
  readonly runNamespace: string
  readonly promptVersion: string
  readonly modelId: string
  readonly revision: string
  readonly parameters: Readonly<Record<string, string | number | boolean>>
  readonly documentId: string
  readonly documentSha256: string
  readonly chunkId: string
  readonly inputSha256: string
  readonly status: 'success' | 'fallback'
  readonly context: string
  readonly generatedContext?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: number
  readonly outputSha256?: string
  readonly failureType?: 'request' | 'json' | 'schema' | 'empty' | 'token-limit' | 'query-reference' | 'chunk-copy'
  readonly failure?: string
}

/** Prefix text and records produced for one isolated LLM run. */
export interface ContextPrefixRun {
  readonly runNamespace: string
  readonly texts: ReadonlyMap<string, string>
  readonly records: readonly ContextPrefixRecord[]
}

/** Minimal encoder surface used by the isolated Exact Dense pilot. */
export interface ContextualPilotEncoder {
  readonly dimensions: number
  readonly embedDocuments: (texts: readonly string[]) => Promise<Float32Array>
  readonly embedQuery: (query: string) => Promise<Float32Array>
}

/** Retrieval methods intentionally isolated from reranking and adjacency. */
export type ContextualPilotRetrieval = 'bm25' | 'dense' | 'hybrid'

/** Per-query evidence and ranking retained for review. */
export interface ContextualPilotQueryResult {
  readonly sampleId: string
  readonly ambiguity: ContextualAmbiguity
  readonly retrieval: ContextualPilotRetrieval
  readonly relevantChunkIds: readonly string[]
  readonly rankedChunkIds: readonly string[]
  readonly completeEvidenceCoverage: number
  readonly recallAt10: number
  readonly ndcgAt10: number
  readonly mrrAt10: number
}

/** Aggregate result for one input strategy and retrieval method. */
export interface ContextualPilotMetrics {
  readonly queryCount: number
  readonly completeEvidenceCoverage: number
  readonly recallAt10: number
  readonly ndcgAt10: number
  readonly mrrAt10: number
}

/** One baseline, deterministic, or independently generated LLM evaluation. */
export interface ContextualPilotEvaluation {
  readonly strategy: string
  readonly chunkCount: number
  readonly indexTokens: number
  readonly indexTokenIncreaseRatio: number
  readonly buildMs: number
  readonly observedRssBytes: number
  readonly metrics: Readonly<Record<ContextualPilotRetrieval, ContextualPilotMetrics>>
  readonly byAmbiguity: Readonly<Record<ContextualAmbiguity, Readonly<Record<ContextualPilotRetrieval, ContextualPilotMetrics>>>>
  readonly queries: readonly ContextualPilotQueryResult[]
}

const AMBIGUITIES: readonly ContextualAmbiguity[] = [
  'pronoun-reference',
  'relative-time',
  'same-name-entity',
  'cross-section-ownership',
  'weak-title',
]

const RETRIEVALS: readonly ContextualPilotRetrieval[] = ['bm25', 'dense', 'hybrid']

/** Prompt revision frozen before any phase-six prefix generation. */
export const CONTEXT_PREFIX_PROMPT_VERSION = 'context-prefix-v1'
/** Maximum generated prefix length measured by the fixed BGE tokenizer. */
export const CONTEXT_PREFIX_MAX_TOKENS = 80

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new TypeError(`${label} has unknown field "${unknown[0]}"`)
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function optionalNonEmpty(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : nonEmpty(value, label)
}

function parseChunk(value: unknown, label: string): ContextualPilotChunk {
  const input = record(value, label)
  exactKeys(input, ['id', 'sectionPath', 'text'], label)
  return {
    id: nonEmpty(input['id'], `${label}.id`),
    ...(input['sectionPath'] === undefined
      ? {}
      : { sectionPath: nonEmpty(input['sectionPath'], `${label}.sectionPath`) }),
    text: nonEmpty(input['text'], `${label}.text`),
  }
}

function parseSample(value: unknown, label: string): ContextualPilotSample {
  const input = record(value, label)
  exactKeys(input, ['schemaVersion', 'id', 'ambiguity', 'query', 'document', 'evidence'], label)
  if (input['schemaVersion'] !== 1) throw new TypeError(`${label}.schemaVersion must be 1`)
  if (!AMBIGUITIES.includes(input['ambiguity'] as ContextualAmbiguity)) {
    throw new TypeError(`${label}.ambiguity is unsupported`)
  }
  const documentInput = record(input['document'], `${label}.document`)
  exactKeys(documentInput, ['id', 'title', 'sourceVersion', 'validFrom', 'validUntil', 'text', 'chunks'], `${label}.document`)
  if (!Array.isArray(documentInput['chunks']) || documentInput['chunks'].length === 0) {
    throw new TypeError(`${label}.document.chunks must be a non-empty array`)
  }
  if (!Array.isArray(input['evidence']) || input['evidence'].length === 0) {
    throw new TypeError(`${label}.evidence must be a non-empty array`)
  }
  const document: ContextualPilotDocument = {
    id: nonEmpty(documentInput['id'], `${label}.document.id`),
    ...(optionalNonEmpty(documentInput['title'], `${label}.document.title`) === undefined
      ? {}
      : { title: documentInput['title'] as string }),
    ...(optionalNonEmpty(documentInput['sourceVersion'], `${label}.document.sourceVersion`) === undefined
      ? {}
      : { sourceVersion: documentInput['sourceVersion'] as string }),
    ...(optionalNonEmpty(documentInput['validFrom'], `${label}.document.validFrom`) === undefined
      ? {}
      : { validFrom: documentInput['validFrom'] as string }),
    ...(optionalNonEmpty(documentInput['validUntil'], `${label}.document.validUntil`) === undefined
      ? {}
      : { validUntil: documentInput['validUntil'] as string }),
    text: nonEmpty(documentInput['text'], `${label}.document.text`),
    chunks: documentInput['chunks'].map((chunk, index) => parseChunk(chunk, `${label}.document.chunks[${index}]`)),
  }
  const chunks = new Map(document.chunks.map(chunk => [chunk.id, chunk]))
  const evidence = input['evidence'].map((value, index) => {
    const evidenceLabel = `${label}.evidence[${index}]`
    const entry = record(value, evidenceLabel)
    exactKeys(entry, ['chunkId', 'quote'], evidenceLabel)
    const chunkId = nonEmpty(entry['chunkId'], `${evidenceLabel}.chunkId`)
    const quote = nonEmpty(entry['quote'], `${evidenceLabel}.quote`)
    const chunk = chunks.get(chunkId)
    if (chunk === undefined) throw new TypeError(`${evidenceLabel}.chunkId is not present in its document`)
    if (!chunk.text.includes(quote)) throw new TypeError(`${evidenceLabel}.quote is not present in its chunk`)
    return { chunkId, quote }
  })
  return {
    schemaVersion: 1,
    id: nonEmpty(input['id'], `${label}.id`),
    ambiguity: input['ambiguity'] as ContextualAmbiguity,
    query: nonEmpty(input['query'], `${label}.query`),
    document,
    evidence,
  }
}

/**
 * Parse and validate the complete fixed JSONL sample before prefix generation.
 * @param text - one sample object per non-empty line.
 * @param source - source label included in validation errors.
 * @returns sixty or more reviewed samples with unique identities and balanced ambiguity types.
 */
export function parseContextualPilotSamples(text: string, source = 'contextual-pilot-samples.jsonl'): ContextualPilotSample[] {
  const samples = text.split(/\r?\n/gu).flatMap((line, index) => {
    if (line.trim().length === 0) return []
    try {
      return [parseSample(JSON.parse(line) as unknown, `${source}:${index + 1}`)]
    } catch (error) {
      if (error instanceof SyntaxError) throw new TypeError(`${source}:${index + 1}: invalid JSON`)
      throw error
    }
  })
  if (samples.length < 60) throw new TypeError(`${source}: expected at least 60 samples`)
  const sampleIds = new Set<string>()
  const documentIds = new Set<string>()
  const chunkIds = new Set<string>()
  const counts = new Map<ContextualAmbiguity, number>(AMBIGUITIES.map(type => [type, 0]))
  for (const sample of samples) {
    if (sampleIds.has(sample.id)) throw new TypeError(`${source}: duplicate sample id "${sample.id}"`)
    if (documentIds.has(sample.document.id)) throw new TypeError(`${source}: duplicate document id "${sample.document.id}"`)
    sampleIds.add(sample.id)
    documentIds.add(sample.document.id)
    counts.set(sample.ambiguity, (counts.get(sample.ambiguity) as number) + 1)
    for (const chunk of sample.document.chunks) {
      if (chunkIds.has(chunk.id)) throw new TypeError(`${source}: duplicate chunk id "${chunk.id}"`)
      chunkIds.add(chunk.id)
    }
  }
  for (const ambiguity of AMBIGUITIES) {
    if ((counts.get(ambiguity) as number) < 12) throw new TypeError(`${source}: ${ambiguity} requires at least 12 samples`)
  }
  return samples
}

/**
 * Build the current production retrieval input without modifying `retrievalText()`.
 * @param document - source document metadata.
 * @param chunk - fixed source chunk.
 * @returns current title, section, and body composition.
 */
export function baselineContextualText(document: ContextualPilotDocument, chunk: ContextualPilotChunk): string {
  return retrievalText(document.title, chunk.sectionPath, chunk.text)
}

/**
 * Build the fixed metadata-labelled comparison input.
 * @param document - source document metadata.
 * @param chunk - fixed source chunk.
 * @returns deterministic prefix followed by the unchanged body.
 */
export function deterministicContextualText(document: ContextualPilotDocument, chunk: ContextualPilotChunk): string {
  const lines = [
    document.title === undefined ? undefined : `Title: ${document.title}`,
    chunk.sectionPath === undefined ? undefined : `Section: ${chunk.sectionPath}`,
    document.sourceVersion === undefined ? undefined : `Source version: ${document.sourceVersion}`,
    document.validFrom === undefined ? undefined : `Valid from: ${document.validFrom}`,
    document.validUntil === undefined ? undefined : `Valid until: ${document.validUntil}`,
  ].filter((value): value is string => value !== undefined)
  return [...lines, chunk.text].join('\n')
}

/**
 * Create the frozen prompt input and its content identity for one chunk.
 * @param document - complete sampled source document.
 * @param chunk - target chunk from the same document.
 * @returns prompt input with a stable SHA-256 identity.
 */
export function contextPrefixInput(document: ContextualPilotDocument, chunk: ContextualPilotChunk): ContextPrefixInput {
  const canonical = JSON.stringify({ promptVersion: CONTEXT_PREFIX_PROMPT_VERSION, document, chunk })
  return { promptVersion: CONTEXT_PREFIX_PROMPT_VERSION, document, chunk, inputSha256: sha256(canonical) }
}

/**
 * Render the frozen model instruction. Evaluation queries are deliberately absent.
 * @param input - stable document and target-chunk input.
 * @returns one JSON-only generation prompt.
 */
export function renderContextPrefixPrompt(input: ContextPrefixInput): string {
  return [
    'Return exactly one JSON object with the single field "context".',
    'Write one concise paragraph of at most 35 English words or 55 Chinese characters, and never more than 80 tokens.',
    'Identify only the target chunk\'s entity, time, topic, and resolved references using facts in the source document.',
    'Do not answer any possible user query, add outside facts, or copy a long passage from the target chunk.',
    `Document title: ${input.document.title ?? '(missing)'}`,
    `Source version: ${input.document.sourceVersion ?? '(missing)'}`,
    `Valid from: ${input.document.validFrom ?? '(missing)'}`,
    `Valid until: ${input.document.validUntil ?? '(missing)'}`,
    `Source document:\n${input.document.text}`,
    `Target section: ${input.chunk.sectionPath ?? '(missing)'}`,
    `Target chunk:\n${input.chunk.text}`,
  ].join('\n\n')
}

function parseGeneratedContext(
  output: string,
  chunk: ContextualPilotChunk,
  prohibitedQueries: readonly string[],
  tokenizer: Pick<ChunkTokenizer, 'countTokens'>,
): { readonly context?: string; readonly failureType?: ContextPrefixRecord['failureType']; readonly failure?: string } {
  let value: unknown
  try {
    value = JSON.parse(output) as unknown
  } catch {
    return { failureType: 'json', failure: 'model output is not valid JSON' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { failureType: 'schema', failure: 'model output must be an object' }
  }
  const fields = Object.keys(value)
  if (fields.length !== 1 || fields[0] !== 'context') {
    return { failureType: 'schema', failure: 'model output must contain only context' }
  }
  const context = (value as Record<string, unknown>)['context']
  if (typeof context !== 'string' || context.trim().length === 0) {
    return { failureType: 'empty', failure: 'generated context must be non-empty' }
  }
  const normalized = context.trim()
  if (tokenizer.countTokens(normalized) > CONTEXT_PREFIX_MAX_TOKENS) {
    return { context: normalized, failureType: 'token-limit', failure: 'generated context exceeds 80 tokens' }
  }
  const folded = normalized.normalize('NFKC').toLowerCase()
  if (prohibitedQueries.some(query => folded.includes(query.normalize('NFKC').toLowerCase()))) {
    return { failureType: 'query-reference', failure: 'generated context repeats an evaluation query' }
  }
  const body = chunk.text.replace(/\s+/gu, ' ').trim()
  const copied = longestCommonSubstring(normalized.replace(/\s+/gu, ' '), body)
  if (copied >= 80 && copied / body.length >= 0.5) {
    return { failureType: 'chunk-copy', failure: 'generated context copies a large target-chunk span' }
  }
  return { context: normalized }
}

/**
 * Generate one isolated run, de-duplicating identical inputs only within that run.
 * @param samples - frozen reviewed samples.
 * @param runNamespace - unique cache namespace for this independent generation run.
 * @param generator - fixed model identity and request implementation.
 * @param tokenizer - fixed tokenizer used for the 80-token limit.
 * @returns validated prefixes, with deterministic fallback retained in failure statistics.
 */
export async function generateContextPrefixRun(
  samples: readonly ContextualPilotSample[],
  runNamespace: string,
  generator: ContextPrefixGenerator,
  tokenizer: Pick<ChunkTokenizer, 'countTokens'>,
  concurrency = 1,
): Promise<ContextPrefixRun> {
  if (runNamespace.trim().length === 0) throw new TypeError('contextual pilot run namespace must be non-empty')
  if (generator.modelId.trim().length === 0 || generator.revision.trim().length === 0) {
    throw new TypeError('contextual pilot generator model and revision must be non-empty')
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('contextual pilot generation concurrency must be a positive safe integer')
  }
  const queriesByDocument = new Map<string, string[]>()
  for (const sample of samples) {
    const values = queriesByDocument.get(sample.document.id) ?? []
    values.push(sample.query)
    queriesByDocument.set(sample.document.id, values)
  }
  const jobs = new Map<string, {
    readonly sample: ContextualPilotSample
    readonly chunk: ContextualPilotChunk
    readonly input: ContextPrefixInput
  }>()
  for (const sample of samples) for (const chunk of sample.document.chunks) {
    const input = contextPrefixInput(sample.document, chunk)
    if (!jobs.has(input.inputSha256)) jobs.set(input.inputSha256, { sample, chunk, input })
  }
  const generated = new Map<string, ContextPrefixRecord>()
  const pending = [...jobs.values()]
  for (let offset = 0; offset < pending.length; offset += concurrency) await Promise.all(
    pending.slice(offset, offset + concurrency).map(async ({ sample, chunk, input }) => {
      const fallback = deterministicContextualText(sample.document, chunk)
      const documentSha256 = sha256(sample.document.text)
      let entry: ContextPrefixRecord
      try {
        const response = await generator.generate(input)
        const parsed = parseGeneratedContext(
          response.output,
          chunk,
          queriesByDocument.get(sample.document.id) ?? [],
          tokenizer,
        )
        const valid = parsed.context !== undefined && parsed.failureType === undefined
        entry = {
          schemaVersion: 1,
          runNamespace,
          promptVersion: input.promptVersion,
          modelId: generator.modelId,
          revision: generator.revision,
          parameters: generator.parameters,
          documentId: sample.document.id,
          documentSha256,
          chunkId: chunk.id,
          inputSha256: input.inputSha256,
          status: valid ? 'success' : 'fallback',
          context: valid ? parsed.context as string : fallback,
          ...(parsed.context === undefined ? {} : { generatedContext: parsed.context }),
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          latencyMs: response.latencyMs,
          outputSha256: sha256(response.output),
          ...(parsed.failureType === undefined ? {} : { failureType: parsed.failureType }),
          ...(parsed.failure === undefined ? {} : { failure: parsed.failure }),
        }
      } catch (error) {
        entry = {
          schemaVersion: 1,
          runNamespace,
          promptVersion: input.promptVersion,
          modelId: generator.modelId,
          revision: generator.revision,
          parameters: generator.parameters,
          documentId: sample.document.id,
          documentSha256,
          chunkId: chunk.id,
          inputSha256: input.inputSha256,
          status: 'fallback',
          context: fallback,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          failureType: 'request',
          failure: error instanceof Error ? error.message : String(error),
        }
      }
      generated.set(input.inputSha256, entry)
    }),
  )
  const texts = new Map<string, string>()
  const records: ContextPrefixRecord[] = []
  for (const sample of samples) for (const chunk of sample.document.chunks) {
    const input = contextPrefixInput(sample.document, chunk)
    const entry = generated.get(input.inputSha256) as ContextPrefixRecord
    const text = entry.status === 'success'
      ? `${entry.context}\n\n${baselineContextualText(sample.document, chunk)}`
      : entry.context
    texts.set(chunk.id, text)
    records.push({ ...entry, chunkId: chunk.id })
  }
  return { runNamespace, texts, records }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function queryMetrics(ranked: readonly string[], relevant: readonly string[]): Omit<ContextualPilotMetrics, 'queryCount'> {
  const expected = new Set(relevant)
  const top = ranked.slice(0, 10)
  const matches = top.filter(chunkId => expected.has(chunkId)).length
  const reciprocalIndex = top.findIndex(chunkId => expected.has(chunkId))
  const dcg = top.reduce((sum, chunkId, index) => sum + (expected.has(chunkId) ? 1 / Math.log2(index + 2) : 0), 0)
  const ideal = Array.from({ length: Math.min(10, expected.size) }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0)
  return {
    completeEvidenceCoverage: matches === expected.size ? 1 : 0,
    recallAt10: matches / expected.size,
    ndcgAt10: ideal === 0 ? 0 : dcg / ideal,
    mrrAt10: reciprocalIndex < 0 ? 0 : 1 / (reciprocalIndex + 1),
  }
}

function aggregate(results: readonly ContextualPilotQueryResult[]): ContextualPilotMetrics {
  if (results.length === 0) throw new TypeError('contextual pilot metric group must not be empty')
  return {
    queryCount: results.length,
    completeEvidenceCoverage: mean(results.map(result => result.completeEvidenceCoverage)),
    recallAt10: mean(results.map(result => result.recallAt10)),
    ndcgAt10: mean(results.map(result => result.ndcgAt10)),
    mrrAt10: mean(results.map(result => result.mrrAt10)),
  }
}

/**
 * Evaluate one fixed text strategy with production BM25 analysis, Exact Dense, and RRF Hybrid.
 * @param samples - frozen reviewed samples.
 * @param strategy - stable strategy or independent-run label.
 * @param texts - exact indexed text for every fixed chunk id.
 * @param baselineIndexTokens - baseline token total used for cost comparison.
 * @param tokenizer - fixed tokenizer used by the Dense build.
 * @param encoder - fixed-revision Dense encoder.
 * @param candidateCount - candidates supplied to each retrieval route.
 * @returns aggregate and per-query metrics without changing production indexes.
 */
export async function evaluateContextualPilot(
  samples: readonly ContextualPilotSample[],
  strategy: string,
  texts: ReadonlyMap<string, string>,
  baselineIndexTokens: number,
  tokenizer: Pick<ChunkTokenizer, 'countTokens'>,
  encoder: ContextualPilotEncoder,
  candidateCount = 50,
): Promise<ContextualPilotEvaluation> {
  if (strategy.trim().length === 0) throw new TypeError('contextual pilot strategy must be non-empty')
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 10) {
    throw new TypeError('contextual pilot candidateCount must be a safe integer of at least 10')
  }
  const chunks = samples.flatMap(sample => sample.document.chunks)
  const chunkIds = chunks.map(chunk => chunk.id)
  if (new Set(chunkIds).size !== chunkIds.length) throw new TypeError('contextual pilot chunk ids must be unique')
  const inputs = chunkIds.map((chunkId) => {
    const text = texts.get(chunkId)
    if (text === undefined) throw new TypeError(`contextual pilot text is missing for chunk "${chunkId}"`)
    return text
  })
  const indexTokens = inputs.reduce((sum, text) => sum + tokenizer.countTokens(text), 0)
  const startedAt = performance.now()
  const bm25 = buildBm25Index(inputs, MIXED_ZH_EN_ANALYZER)
  const vectors = await encoder.embedDocuments(inputs)
  const buildMs = performance.now() - startedAt
  const queryResults: ContextualPilotQueryResult[] = []
  for (const sample of samples) {
    const relevant = sample.evidence.map(item => item.chunkId)
    const bm25Matches = searchBm25(bm25, sample.query, chunkIds, candidateCount, 1.2, 0.75)
    const queryVector = await encoder.embedQuery(sample.query)
    const denseMatches = searchDense(vectors, queryVector, chunkIds, encoder.dimensions, candidateCount)
    const rankings = {
      bm25: bm25Matches.slice(0, 10),
      dense: denseMatches.slice(0, 10),
      hybrid: fuseRrf(bm25Matches, denseMatches, chunkIds, DEFAULT_RRF_K, 10),
    }
    for (const retrieval of RETRIEVALS) {
      const rankedChunkIds = rankings[retrieval].map(match => chunkIds[match.ordinal] as string)
      queryResults.push({
        sampleId: sample.id,
        ambiguity: sample.ambiguity,
        retrieval,
        relevantChunkIds: relevant,
        rankedChunkIds,
        ...queryMetrics(rankedChunkIds, relevant),
      })
    }
  }
  const metrics = Object.fromEntries(RETRIEVALS.map(retrieval => [
    retrieval,
    aggregate(queryResults.filter(result => result.retrieval === retrieval)),
  ])) as unknown as Record<ContextualPilotRetrieval, ContextualPilotMetrics>
  const byAmbiguity = Object.fromEntries(AMBIGUITIES.map(ambiguity => [ambiguity, Object.fromEntries(
    RETRIEVALS.map(retrieval => [
      retrieval,
      aggregate(queryResults.filter(result => result.ambiguity === ambiguity && result.retrieval === retrieval)),
    ]),
  )])) as unknown as Record<ContextualAmbiguity, Record<ContextualPilotRetrieval, ContextualPilotMetrics>>
  return {
    strategy,
    chunkCount: chunkIds.length,
    indexTokens,
    indexTokenIncreaseRatio: baselineIndexTokens === 0 ? 0 : indexTokens / baselineIndexTokens - 1,
    buildMs,
    observedRssBytes: process.memoryUsage().rss,
    metrics,
    byAmbiguity,
    queries: queryResults,
  }
}

/**
 * Build the two deterministic input maps used by every pilot run.
 * @param samples - fixed sample set.
 * @returns baseline and metadata-prefixed text keyed by chunk id.
 */
export function contextualPilotTextMaps(samples: readonly ContextualPilotSample[]): {
  readonly baseline: ReadonlyMap<string, string>
  readonly deterministic: ReadonlyMap<string, string>
} {
  const baseline = new Map<string, string>()
  const deterministic = new Map<string, string>()
  for (const sample of samples) for (const chunk of sample.document.chunks) {
    baseline.set(chunk.id, baselineContextualText(sample.document, chunk))
    deterministic.set(chunk.id, deterministicContextualText(sample.document, chunk))
  }
  return { baseline, deterministic }
}
