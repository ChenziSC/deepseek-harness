/** Streaming full-corpus statistics for optional contextual-prefix planning. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { chunkDocuments, type ChunkingOptions } from '../../chunker.ts'
import { parseCorpusDocumentLine } from '../../corpus.ts'
import {
  CONTEXTUAL_PREFIX_OUTPUT_RESERVE_TOKENS,
  detectContextualAmbiguity,
  planContextualPrefixes,
  type ContextualAmbiguitySignal,
  type ContextualPrefixPlanningOptions,
} from './contextual-prefix.ts'
import type { ChunkTokenizer } from '../../tokenizer.ts'

/** Bounded example retained to explain aggregate detector counts. */
interface ContextualPrefixDiagnosticSample {
  readonly chunkId: string
  readonly risk: 1 | 2 | 3 | 4
  readonly signals: readonly ContextualAmbiguitySignal[]
}

/** Machine-readable result of a full scan that creates no retrieval index. */
export interface ContextualPrefixCorpusStatistics {
  readonly schemaVersion: 1
  readonly measurement: 'exact' | 'sampled-estimate'
  readonly corpusSha256: string
  readonly documentCount: number
  readonly tokenizedDocumentCount: number
  readonly sampleModulus: number
  readonly chunkCount: number
  readonly detectedCandidateCount: number
  readonly candidateRatio: number
  readonly maxCandidateRatio: number
  readonly selectedCandidateCount: number
  readonly clippedCandidateCount: number
  readonly risks: Readonly<Record<'1' | '2' | '3' | '4', number>>
  readonly signals: Readonly<Record<ContextualAmbiguitySignal, number>>
  readonly requestCount: number
  readonly mergedRequestReductionRatio: number
  readonly estimatedInputTokensAllCandidates: number
  readonly selectedInputTokensUpperBound: number
  readonly maximumOutputTokensAllCandidates: number
  readonly selectedMaximumOutputTokens: number
  readonly diagnostics: readonly ContextualPrefixDiagnosticSample[]
}

/** File input accepted by the no-LLM full-corpus statistics scanner. */
export interface ContextualPrefixCorpusStatisticsOptions {
  readonly corpusPath: string
  readonly corpusFormat: 'generic' | 'scifact' | 'mldr' | 't2ranking'
  readonly tokenizer: ChunkTokenizer
  readonly chunking: ChunkingOptions
  readonly planning: ContextualPrefixPlanningOptions
  readonly diagnosticSampleLimit: number
  /** Tokenize all documents at one; larger values select documents by a stable id hash. */
  readonly sampleModulus: number
}

interface DuplicateStructureState {
  firstDocumentId: string
  firstDocumentCandidateCount: number
  duplicate: boolean
}

function inputStream(path: string): Readable {
  const stream = createReadStream(path)
  return path.endsWith('.gz') ? stream.pipe(createGunzip()) : stream
}

function structureKey(chunk: { readonly title?: string; readonly sectionPath?: string }): string {
  const title = (chunk.title as string).trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
  const section = chunk.sectionPath?.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
  return `${title}\u0000${section ?? ''}`
}

function selectedCount(chunkCount: number, candidateCount: number, ratio: number): number {
  return Math.min(candidateCount, Math.floor(chunkCount * ratio))
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function sampled(documentId: string, modulus: number): boolean {
  if (modulus === 1) return true
  const value = createHash('sha256').update(documentId).digest().readUInt32BE(0)
  return value % modulus === 0
}

function scaled(value: number, factor: number): number {
  return Math.round(value * factor)
}

/**
 * Scan one complete corpus without retaining full documents, chunks, plans, or generated text.
 * @param options - source, tokenizer, chunking, detector limits, and bounded diagnostics.
 * @returns aggregate counts and conservative token bounds; no model or embedding provider is used.
 */
export async function scanContextualPrefixCorpus(
  options: ContextualPrefixCorpusStatisticsOptions,
): Promise<ContextualPrefixCorpusStatistics> {
  if (!Number.isSafeInteger(options.diagnosticSampleLimit) || options.diagnosticSampleLimit < 0) {
    throw new TypeError('knowledge-local: contextual statistics diagnosticSampleLimit must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(options.sampleModulus) || options.sampleModulus < 1) {
    throw new TypeError('knowledge-local: contextual statistics sampleModulus must be a positive safe integer')
  }
  const digest = createHash('sha256')
  const stream = inputStream(options.corpusPath)
  stream.on('data', chunk => digest.update(chunk as Buffer))
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const duplicateStructures = new Map<string, DuplicateStructureState>()
  const signals: Record<ContextualAmbiguitySignal, number> = {
    'cross-reference': 0,
    'leading-reference': 0,
    'relative-time': 0,
    continuation: 0,
    'weak-structure': 0,
  }
  const risks: Record<'1' | '2' | '3' | '4', number> = { '1': 0, '2': 0, '3': 0, '4': 0 }
  const diagnostics: ContextualPrefixDiagnosticSample[] = []
  let documentCount = 0
  let tokenizedDocumentCount = 0
  let chunkCount = 0
  let detectedCandidateCount = 0
  let requestCount = 0
  let estimatedInputTokensAllCandidates = 0
  let maximumOutputTokensAllCandidates = 0
  let line = 0
  try {
    for await (const text of lines) {
      line += 1
      if (text.trim().length === 0
        || (options.corpusFormat === 't2ranking' && line === 1 && text === 'pid\ttext')) continue
      const document = parseCorpusDocumentLine(text, options.corpusFormat, options.corpusPath, line)
      documentCount += 1
      if (!sampled(document.id, options.sampleModulus)) continue
      tokenizedDocumentCount += 1
      const chunks = chunkDocuments([document], options.tokenizer, options.chunking)
      chunkCount += chunks.length
      for (const chunk of chunks) {
        const assessment = detectContextualAmbiguity(chunk)
        if (!assessment.candidate) continue
        detectedCandidateCount += 1
        risks[String(assessment.risk) as keyof typeof risks] += 1
        for (const signal of assessment.signals) signals[signal] += 1
        if (!assessment.signals.includes('weak-structure')) {
          const key = structureKey(chunk)
          const state = duplicateStructures.get(key)
          if (state === undefined) {
            duplicateStructures.set(key, {
              firstDocumentId: document.id,
              firstDocumentCandidateCount: 1,
              duplicate: false,
            })
          } else if (state.firstDocumentId === document.id) {
            state.firstDocumentCandidateCount += 1
          } else if (state.duplicate) {
            signals['weak-structure'] += 1
          } else {
            signals['weak-structure'] += state.firstDocumentCandidateCount + 1
            state.duplicate = true
          }
        }
        if (diagnostics.length < options.diagnosticSampleLimit) {
          diagnostics.push({
            chunkId: chunk.id,
            risk: assessment.risk as 1 | 2 | 3 | 4,
            signals: assessment.signals,
          })
        }
      }
      const documentPlan = planContextualPrefixes([document], chunks, options.tokenizer, {
        ...options.planning,
        maxCandidateRatio: 1,
        maxInputTokens: Number.MAX_SAFE_INTEGER,
        maxOutputTokens: Number.MAX_SAFE_INTEGER,
        budgetAction: 'fail',
      })
      requestCount += documentPlan.batches.length
      estimatedInputTokensAllCandidates += documentPlan.estimatedInputTokens
      maximumOutputTokensAllCandidates += documentPlan.maximumOutputTokens
    }
  } finally {
    lines.close()
  }
  const factor = tokenizedDocumentCount === 0 ? 0 : documentCount / tokenizedDocumentCount
  const measuredChunkCount = scaled(chunkCount, factor)
  const measuredCandidateCount = scaled(detectedCandidateCount, factor)
  const measuredRequestCount = scaled(requestCount, factor)
  const measuredInputTokens = scaled(estimatedInputTokensAllCandidates, factor)
  const measuredOutputTokens = scaled(maximumOutputTokensAllCandidates, factor)
  const selectedCandidateCount = selectedCount(
    measuredChunkCount,
    measuredCandidateCount,
    options.planning.maxCandidateRatio,
  )
  return {
    schemaVersion: 1,
    measurement: options.sampleModulus === 1 ? 'exact' : 'sampled-estimate',
    corpusSha256: digest.digest('hex'),
    documentCount,
    tokenizedDocumentCount,
    sampleModulus: options.sampleModulus,
    chunkCount: measuredChunkCount,
    detectedCandidateCount: measuredCandidateCount,
    candidateRatio: ratio(detectedCandidateCount, chunkCount),
    maxCandidateRatio: options.planning.maxCandidateRatio,
    selectedCandidateCount,
    clippedCandidateCount: measuredCandidateCount - selectedCandidateCount,
    risks: Object.fromEntries(Object.entries(risks).map(([risk, count]) => [risk, scaled(count, factor)])) as typeof risks,
    signals: Object.fromEntries(Object.entries(signals).map(([signal, count]) => [signal, scaled(count, factor)])) as typeof signals,
    requestCount: measuredRequestCount,
    mergedRequestReductionRatio: ratio(detectedCandidateCount - requestCount, detectedCandidateCount),
    estimatedInputTokensAllCandidates: measuredInputTokens,
    selectedInputTokensUpperBound: measuredInputTokens,
    maximumOutputTokensAllCandidates: measuredOutputTokens,
    selectedMaximumOutputTokens: Math.min(
      measuredOutputTokens,
      selectedCandidateCount * options.planning.maxPrefixTokens
        + Math.min(measuredRequestCount, selectedCandidateCount) * CONTEXTUAL_PREFIX_OUTPUT_RESERVE_TOKENS,
    ),
    diagnostics,
  }
}
