import { describe, expect, it } from 'vitest'
import { chunkDocuments } from '../src/chunker.ts'
import type { ChunkTokenizer } from '../src/tokenizer.ts'
import { parseCorpusJsonl } from '../src/corpus.ts'
import {
  contextualPrefixRequestOutputTokens,
  detectContextualAmbiguity,
  planContextualPrefixes,
  renderContextualPrefixRequest,
  type ContextualPrefixPlanningOptions,
} from '../src/offline/contextual-prefix/contextual-prefix.ts'

const tokenizer: ChunkTokenizer = {
  countTokens(text) {
    return text.match(/\S+/gu)?.length ?? 0
  },
}

const options: ContextualPrefixPlanningOptions = {
  detector: 'strict-v1',
  target: 'dense',
  maxCandidateRatio: 1,
  maxInputTokens: 10_000,
  maxOutputTokens: 1_000,
  maxPrefixTokens: 20,
  contextWindowTokens: 30,
  maxChunksPerRequest: 2,
  budgetAction: 'fail',
  promptVersion: 'context-prefix-v2',
}

describe('contextual prefix planning', () => {
  it.each([
    ['It was later adopted by the second service.', 'leading-reference', 3],
    ['This approach reduces duplicate work.', 'leading-reference', 3],
    ['However, the cache remains optional.', 'continuation', 1],
    ['See the previous section for the required identifier.', 'cross-reference', 4],
    ['The service is currently available to local callers.', 'relative-time', 2],
    ['该方案会复用已有向量。', 'leading-reference', 3],
    ['此外，缓存不会改变原始正文。', 'continuation', 1],
    ['详细字段见上文。', 'cross-reference', 4],
    ['该功能目前默认关闭。', 'leading-reference', 3],
  ] as const)('detects %s', (text, signal, risk) => {
    expect(detectContextualAmbiguity({ text }).signals).toContain(signal)
    expect(detectContextualAmbiguity({ text }).risk).toBe(risk)
  })

  it('does not select missing titles, ordinary demonstratives, or absolute dates alone', () => {
    expect(detectContextualAmbiguity({ text: 'A complete standalone statement.' })).toEqual({
      candidate: false,
      risk: 0,
      signals: [],
    })
    expect(detectContextualAmbiguity({ text: 'This study reports a controlled experiment.' }).candidate).toBe(false)
    expect(detectContextualAmbiguity({ text: 'The service launched in 2026.' }).candidate).toBe(false)
  })

  it('marks weak or repeated structure only when another ambiguity signal exists', () => {
    const duplicate = new Set(['overview\u0000results'])
    expect(detectContextualAmbiguity({ title: 'Overview', sectionPath: 'Results', text: 'It improved recall.' }, duplicate))
      .toEqual({ candidate: true, risk: 3, signals: ['leading-reference', 'weak-structure'] })
    expect(detectContextualAmbiguity({ title: 'Overview', sectionPath: 'Results', text: 'Recall improved.' }, duplicate))
      .toEqual({ candidate: false, risk: 0, signals: [] })
  })

  it('detects repeated title-only and section-only structures across documents', () => {
    const documents = parseCorpusJsonl([
      JSON.stringify({ id: 'a', title: 'Guide', text: 'It needs context.' }),
      JSON.stringify({ id: 'b', title: 'Guide', text: 'They need context.' }),
      JSON.stringify({ id: 'c', text: '# Shared\n\nIt also needs context.' }),
      JSON.stringify({ id: 'd', text: '# Shared\n\nThey also need context.' }),
    ].join('\n'))
    const chunks = chunkDocuments(documents, tokenizer, { maxTokens: 5, overlapTokens: 0 })
    const plan = planContextualPrefixes(documents, chunks, tokenizer, { ...options, maxChunksPerRequest: 1 })

    expect(plan.signals['weak-structure']).toBe(4)
    expect(plan.batches).toHaveLength(4)
  })

  it('groups nearby candidates into a bounded query-independent request', () => {
    const documents = parseCorpusJsonl(`${JSON.stringify({
      id: 'guide',
      title: 'Cache Guide',
      source: 'manual',
      sourceVersion: 'v2',
      text: [
        '# Cache',
        'The cache stores complete records.',
        'It avoids repeated derivation work.',
        'However, invalid entries fail loudly.',
      ].join('\n\n'),
    })}\n`)
    const chunks = chunkDocuments(documents, tokenizer, { maxTokens: 7, overlapTokens: 0 })
    const plan = planContextualPrefixes(documents, chunks, tokenizer, options)

    expect(plan.detectedCandidateCount).toBe(2)
    expect(plan.selectedCandidateCount).toBe(2)
    expect(plan.fallbackCandidateCount).toBe(0)
    expect(plan.batches).toHaveLength(1)
    expect(plan.batches[0]?.candidateChunkIds).toHaveLength(2)
    expect(plan.batches[0]?.request.document).toMatchObject({ id: 'guide', title: 'Cache Guide', sourceVersion: 'v2' })
    expect(JSON.stringify(plan.batches[0]?.request)).not.toContain('query')
    expect(renderContextualPrefixRequest(plan.batches[0]!.request)).toContain('at most 10 tokens')
    expect(plan.estimatedInputTokens).toBeGreaterThan(0)
    expect(plan.maximumOutputTokens).toBe(168)
  })

  it('uses stable risk order when a candidate ratio requires fallbacks', () => {
    const documents = parseCorpusJsonl([
      JSON.stringify({ id: 'a', text: 'However, this is a continuation.' }),
      JSON.stringify({ id: 'b', text: 'This method needs its earlier definition.' }),
      JSON.stringify({ id: 'c', text: 'See the previous section for details.' }),
      JSON.stringify({ id: 'd', text: 'A standalone statement.' }),
    ].join('\n'))
    const chunks = chunkDocuments(documents, tokenizer, { maxTokens: 20, overlapTokens: 0 })
    const plan = planContextualPrefixes(documents, chunks, tokenizer, {
      ...options,
      maxCandidateRatio: 0.5,
      maxChunksPerRequest: 1,
      budgetAction: 'deterministic-fallback',
    })

    expect(plan.detectedCandidateCount).toBe(3)
    expect(plan.selectedCandidateCount).toBe(2)
    expect(plan.fallbackCandidateCount).toBe(1)
    expect(plan.batches.map(batch => batch.request.document.id)).toEqual(['c', 'b'])
    expect(plan.fallbacks).toHaveLength(1)
    expect(plan.fallbacks[0]?.chunkId.startsWith('a:')).toBe(true)
    expect(plan.fallbacks[0]?.sourceTextSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('applies cumulative input and output budgets before generation', () => {
    const documents = parseCorpusJsonl([
      JSON.stringify({ id: 'a', text: 'It needs context.' }),
      JSON.stringify({ id: 'b', text: 'They need context.' }),
    ].join('\n'))
    const chunks = chunkDocuments(documents, tokenizer, { maxTokens: 20, overlapTokens: 0 })
    const first = planContextualPrefixes(documents, chunks, tokenizer, {
      ...options,
      maxChunksPerRequest: 1,
    })
    const oneBatchInput = first.batches[0]?.estimatedInputTokens as number
    const plan = planContextualPrefixes(documents, chunks, tokenizer, {
      ...options,
      maxChunksPerRequest: 1,
      maxInputTokens: oneBatchInput,
      maxOutputTokens: 148,
      budgetAction: 'deterministic-fallback',
    })

    expect(plan.selectedCandidateCount).toBe(1)
    expect(plan.fallbackCandidateCount).toBe(1)
    expect(plan.estimatedInputTokens).toBe(oneBatchInput)
    expect(plan.maximumOutputTokens).toBe(148)

    const outputLimited = planContextualPrefixes(documents, chunks, tokenizer, {
      ...options,
      maxChunksPerRequest: 1,
      maxOutputTokens: 148,
      budgetAction: 'deterministic-fallback',
    })
    expect(outputLimited.selectedCandidateCount).toBe(1)
  })

  it('fails before generation when strict candidate or token budgets are exceeded', () => {
    const documents = parseCorpusJsonl([
      JSON.stringify({ id: 'a', text: 'It needs context.' }),
      JSON.stringify({ id: 'b', text: 'They need context.' }),
    ].join('\n'))
    const chunks = chunkDocuments(documents, tokenizer, { maxTokens: 20, overlapTokens: 0 })

    expect(() => planContextualPrefixes(documents, chunks, tokenizer, { ...options, maxCandidateRatio: 0.5 }))
      .toThrow('candidate count 2 exceeds ratio capacity 1')
    expect(() => planContextualPrefixes(documents, chunks, tokenizer, { ...options, maxInputTokens: 1 }))
      .toThrow('plan exceeds the configured token budget')
  })

  it('rejects invalid options, missing source documents, and oversized target chunks', () => {
    const documents = parseCorpusJsonl(`${JSON.stringify({ id: 'a', text: 'It needs context.' })}\n`)
    const chunks = chunkDocuments(documents, tokenizer, { maxTokens: 20, overlapTokens: 0 })
    expect(() => planContextualPrefixes(documents, chunks, tokenizer, { ...options, maxCandidateRatio: 0 }))
      .toThrow('maxCandidateRatio')
    expect(() => planContextualPrefixes([], chunks, tokenizer, options)).toThrow('has no source document')
    expect(() => planContextualPrefixes(documents, chunks, tokenizer, { ...options, contextWindowTokens: 1 }))
      .toThrow('exceeds contextWindowTokens')
  })

  it.each([
    [{ ...options, detector: 'future' }, 'detector is unsupported'],
    [{ ...options, target: 'future' }, 'target is unsupported'],
    [{ ...options, maxCandidateRatio: Number.NaN }, 'maxCandidateRatio'],
    [{ ...options, maxCandidateRatio: 2 }, 'maxCandidateRatio'],
    [{ ...options, maxInputTokens: 0 }, 'maxInputTokens'],
    [{ ...options, maxOutputTokens: 0.5 }, 'maxOutputTokens'],
    [{ ...options, maxPrefixTokens: 0 }, 'maxPrefixTokens'],
    [{ ...options, contextWindowTokens: 0 }, 'contextWindowTokens'],
    [{ ...options, maxChunksPerRequest: 0 }, 'maxChunksPerRequest'],
    [{ ...options, budgetAction: 'future' }, 'budgetAction is unsupported'],
    [{ ...options, promptVersion: ' ' }, 'promptVersion must be non-empty'],
  ] as const)('rejects invalid planning option %s', (invalid, message) => {
    expect(() => planContextualPrefixes([], [], tokenizer, invalid as ContextualPrefixPlanningOptions)).toThrow(message)
  })

  it('returns an empty plan without creating batches', () => {
    expect(planContextualPrefixes([], [], tokenizer, options)).toEqual({
      schemaVersion: 1,
      detector: 'strict-v1',
      target: 'dense',
      promptVersion: 'context-prefix-v2',
      contextWindowTokens: 30,
      maxPrefixTokens: 20,
      totalChunkCount: 0,
      detectedCandidateCount: 0,
      selectedCandidateCount: 0,
      fallbackCandidateCount: 0,
      candidateRatio: 0,
      estimatedInputTokens: 0,
      maximumOutputTokens: 0,
      signals: {
        'cross-reference': 0,
        'leading-reference': 0,
        'relative-time': 0,
        continuation: 0,
        'weak-structure': 0,
      },
      batches: [],
      fallbacks: [],
    })
  })

  it('rejects an unsafe request output limit', () => {
    expect(() => contextualPrefixRequestOutputTokens({
      targets: [{ id: 'a', text: 'a' }],
      maxPrefixTokens: Number.MAX_SAFE_INTEGER,
    })).toThrow('exceeds a safe integer')
  })

  it('expands context on either side and stops before an oversized neighbor', () => {
    const rightDocuments = parseCorpusJsonl(`${JSON.stringify({
      id: 'right',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z',
      text: 'It needs context.\n\nA nearby explanation.\n\nA very large neighboring paragraph that cannot fit.',
    })}\n`)
    const rightChunks = chunkDocuments(rightDocuments, tokenizer, { maxTokens: 3, overlapTokens: 0 })
    const right = planContextualPrefixes(rightDocuments, rightChunks, tokenizer, {
      ...options,
      contextWindowTokens: 6,
      maxChunksPerRequest: 1,
    })
    expect(right.batches[0]?.request.context.length).toBe(2)
    expect(right.batches[0]?.request.document).toMatchObject({
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z',
    })

    const leftDocuments = parseCorpusJsonl(`${JSON.stringify({
      id: 'left',
      text: 'A nearby explanation.\n\nHowever, it needs context.',
    })}\n`)
    const leftChunks = chunkDocuments(leftDocuments, tokenizer, { maxTokens: 3, overlapTokens: 0 })
    const left = planContextualPrefixes(leftDocuments, leftChunks, tokenizer, {
      ...options,
      contextWindowTokens: 6,
      maxChunksPerRequest: 1,
    })
    expect(left.batches[0]?.request.context.length).toBe(2)
  })

  it('uses stable chunk ids to order equal-risk batches in one document', () => {
    const documents = parseCorpusJsonl(`${JSON.stringify({ id: 'same', text: 'It needs context.' })}\n`)
    const base = chunkDocuments(documents, tokenizer, { maxTokens: 20, overlapTokens: 0 })[0]!
    const chunks = [
      { ...base, id: `${base.id}-b` as typeof base.id },
      { ...base, id: `${base.id}-a` as typeof base.id },
    ]
    const plan = planContextualPrefixes(documents, chunks, tokenizer, { ...options, maxChunksPerRequest: 1 })

    expect(plan.batches.map(batch => batch.candidateChunkIds[0])).toEqual([`${base.id}-a`, `${base.id}-b`])
  })
})
