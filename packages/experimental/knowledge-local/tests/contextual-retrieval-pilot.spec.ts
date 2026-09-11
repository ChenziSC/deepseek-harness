import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  baselineContextualText,
  contextPrefixInput,
  contextualPilotTextMaps,
  deterministicContextualText,
  evaluateContextualPilot,
  generateContextPrefixRun,
  parseContextualPilotSamples,
  renderContextPrefixPrompt,
  type ContextualAmbiguity,
  type ContextualPilotSample,
} from '../scripts/contextual-retrieval-pilot.ts'

const tokenizer = { countTokens: (text: string) => text.trim().split(/\s+/u).filter(Boolean).length }

function sample(ambiguity: ContextualAmbiguity, index: number, keyword = `term${index}`): ContextualPilotSample {
  const documentId = `${ambiguity}-${index}`
  const chunkId = `${documentId}:target`
  const text = `${keyword} result ${index}`
  return {
    schemaVersion: 1,
    id: `sample-${ambiguity}-${index}`,
    ambiguity,
    query: keyword,
    document: {
      id: documentId,
      title: `Title ${index}`,
      sourceVersion: 'v1',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z',
      text: `Context for ${keyword}. ${text}`,
      chunks: [{ id: chunkId, sectionPath: 'Result', text }],
    },
    evidence: [{ chunkId, quote: `result ${index}` }],
  }
}

describe('contextual retrieval pilot', () => {
  it('loads the frozen balanced sample and keeps all evidence quotes grounded', async () => {
    const path = new URL('../../../../specs/rag/phase-six/data/contextual-retrieval-pilot-samples.jsonl', import.meta.url)
    const samples = parseContextualPilotSamples(await readFile(path, 'utf8'), path.pathname)

    expect(samples).toHaveLength(60)
    expect(new Set(samples.flatMap(value => value.document.chunks.map(chunk => chunk.id))).size).toBe(72)
    expect(Object.fromEntries([
      'pronoun-reference',
      'relative-time',
      'same-name-entity',
      'cross-section-ownership',
      'weak-title',
    ].map(ambiguity => [ambiguity, samples.filter(sample => sample.ambiguity === ambiguity).length]))).toEqual({
      'pronoun-reference': 12,
      'relative-time': 12,
      'same-name-entity': 12,
      'cross-section-ownership': 12,
      'weak-title': 12,
    })
  })

  it('rejects an undersized or malformed frozen sample', () => {
    expect(() => parseContextualPilotSamples('{}')).toThrow('schemaVersion must be 1')
    expect(() => parseContextualPilotSamples('{')).toThrow('invalid JSON')
    expect(() => parseContextualPilotSamples('')).toThrow('expected at least 60 samples')
  })

  it('builds distinct baseline and deterministic inputs without changing the body', () => {
    const value = sample('relative-time', 1)
    const chunk = value.document.chunks[0] as NonNullable<typeof value.document.chunks[0]>

    expect(baselineContextualText(value.document, chunk)).toBe('Title 1\nResult\nterm1 result 1')
    expect(deterministicContextualText(value.document, chunk)).toBe([
      'Title: Title 1',
      'Section: Result',
      'Source version: v1',
      'Valid from: 2026-01-01T00:00:00.000Z',
      'Valid until: 2027-01-01T00:00:00.000Z',
      'term1 result 1',
    ].join('\n'))
    const input = contextPrefixInput(value.document, chunk)
    expect(input.inputSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(renderContextPrefixPrompt(input)).not.toContain('Evaluation query:')
  })

  it('records valid prefixes and deterministic fallbacks without dropping failures', async () => {
    const samples = [sample('pronoun-reference', 1), sample('relative-time', 2)]
    const generate = vi.fn()
      .mockResolvedValueOnce({ output: '{"context":"The target concerns the first fixture."}', inputTokens: 20, outputTokens: 6, latencyMs: 12 })
      .mockResolvedValueOnce({ output: '{"context":"term2"}', inputTokens: 18, outputTokens: 3, latencyMs: 9 })
    const result = await generateContextPrefixRun(samples, 'llm-run-1', {
      modelId: 'fixture-model',
      revision: 'fixture-revision',
      parameters: { temperature: 0 },
      generate,
    }, tokenizer)

    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.records.map(record => record.status)).toEqual(['success', 'fallback'])
    expect(result.records[1]).toMatchObject({ failureType: 'query-reference', inputTokens: 18, outputTokens: 3 })
    expect(result.texts.get('pronoun-reference-1:target')).toContain('The target concerns the first fixture.')
    expect(result.texts.get('relative-time-2:target')).toBe(deterministicContextualText(
      samples[1]!.document,
      samples[1]!.document.chunks[0]!,
    ))
  })

  it('evaluates BM25, Exact Dense, and Hybrid over identical chunks', async () => {
    const ambiguities: ContextualAmbiguity[] = [
      'pronoun-reference',
      'relative-time',
      'same-name-entity',
      'cross-section-ownership',
      'weak-title',
    ]
    const samples = ambiguities.map((ambiguity, index) => sample(ambiguity, index))
    const maps = contextualPilotTextMaps(samples)
    const baselineTokens = [...maps.baseline.values()].reduce((sum, text) => sum + tokenizer.countTokens(text), 0)
    const keywords = samples.map(value => value.query)
    const vector = (text: string) => {
      const values = new Float32Array(keywords.length)
      const index = keywords.findIndex(keyword => text.includes(keyword))
      values[Math.max(0, index)] = 1
      return values
    }
    const report = await evaluateContextualPilot(samples, 'baseline', maps.baseline, baselineTokens, tokenizer, {
      dimensions: keywords.length,
      embedDocuments: texts => Promise.resolve(Float32Array.from(texts.flatMap(text => [...vector(text)]))),
      embedQuery: query => Promise.resolve(vector(query)),
    }, 10)

    expect(report.chunkCount).toBe(5)
    expect(report.indexTokenIncreaseRatio).toBe(0)
    expect(report.queries).toHaveLength(15)
    expect(report.metrics.bm25.recallAt10).toBe(1)
    expect(report.metrics.dense.recallAt10).toBe(1)
    expect(report.metrics.hybrid.recallAt10).toBe(1)
    expect(report.byAmbiguity['weak-title'].dense.queryCount).toBe(1)
  })
})
