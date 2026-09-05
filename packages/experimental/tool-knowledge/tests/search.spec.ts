import { describe, expect, it } from 'vitest'
import { KnowledgeChunkId, KnowledgeDocumentId, type KnowledgeHit } from '@deepseek-ai/dsh-experimental-knowledge'
import { collectKnowledgeResult, renderKnowledgeResult } from '@deepseek-ai/dsh-experimental-tool-knowledge'

const strategy = { retrieval: 'hybrid', denseIndex: 'exact', rerank: false } as const

function hit(text: string): KnowledgeHit {
  return {
    documentId: KnowledgeDocumentId('doc-1'),
    chunkId: KnowledgeChunkId('doc-1:0-1'),
    title: 'Title',
    source: 'fixture',
    text,
    score: 1,
  }
}

describe('knowledge_search output', () => {
  it('assigns call-local citations and omits provider scores', () => {
    const result = collectKnowledgeResult([hit('first'), { ...hit('second'), chunkId: KnowledgeChunkId('doc-1:1-2') }], 200, 1_000, strategy)
    expect(result.evidence.map(item => item.citation)).toEqual(['K1', 'K2'])
    expect(result.evidence[0]).not.toHaveProperty('score')
    expect(renderKnowledgeResult(result)).toContain('[K1]')
    expect(renderKnowledgeResult({ evidence: [], truncated: false, strategy }))
      .toBe('Strategy: hybrid, exact, rerank off.\nNo relevant evidence found.')
    expect(renderKnowledgeResult({
      evidence: [],
      truncated: false,
      strategy: { retrieval: 'bm25', rerank: true },
    })).toBe('Strategy: bm25, rerank on.\nNo relevant evidence found.')
  })

  it('bounds individual and complete rendered output', () => {
    const result = collectKnowledgeResult([hit('x'.repeat(1_000)), hit('second')], 100, 160, strategy)
    expect(result.truncated).toBe(true)
    expect(Array.from(renderKnowledgeResult(result)).length).toBeLessThanOrEqual(160)
  })

  it('keeps citations contiguous when an oversized fixed header drops a hit', () => {
    const oversized = { ...hit('first'), documentId: KnowledgeDocumentId('x'.repeat(200)) }
    const result = collectKnowledgeResult([oversized, hit('second')], 100, 1_000, strategy)
    expect(result.evidence.map(item => item.citation)).toEqual(['K1'])
    expect(result.evidence[0]?.text).toBe('second')
    expect(result.truncated).toBe(true)
  })

  it('renders optional metadata only when present and clips at one character', () => {
    const bare: KnowledgeHit = {
      documentId: KnowledgeDocumentId('d'),
      chunkId: KnowledgeChunkId('c'),
      text: 'abcdef',
      score: 1,
    }
    const fixedLength = Array.from('[K1]\nDocument: d\nChunk: c\n').length
    const result = collectKnowledgeResult([bare], fixedLength + 1, 1_000, strategy)
    expect(result.evidence[0]?.text).toBe('…')
    expect(renderKnowledgeResult(result)).not.toContain('Title:')
    expect(renderKnowledgeResult(result)).not.toContain('Source:')
  })
})
