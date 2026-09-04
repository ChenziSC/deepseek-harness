import { describe, expect, it } from 'vitest'
import { KnowledgeChunkId, KnowledgeDocumentId, type KnowledgeHit } from '@deepseek-ai/dsh-experimental-knowledge'
import { collectKnowledgeResult, renderKnowledgeResult } from '@deepseek-ai/dsh-experimental-tool-knowledge'

function hit(text: string): KnowledgeHit {
  return {
    documentId: KnowledgeDocumentId('doc-1'),
    chunkId: KnowledgeChunkId('doc-1:0-1'),
    title: 'Title',
    text,
    score: 1,
  }
}

describe('knowledge_search output', () => {
  it('assigns call-local citations and omits provider scores', () => {
    const result = collectKnowledgeResult([hit('first'), { ...hit('second'), chunkId: KnowledgeChunkId('doc-1:1-2') }], 200, 1_000)
    expect(result.evidence.map(item => item.citation)).toEqual(['K1', 'K2'])
    expect(result.evidence[0]).not.toHaveProperty('score')
    expect(renderKnowledgeResult(result)).toContain('[K1]')
  })

  it('bounds individual and complete rendered output', () => {
    const result = collectKnowledgeResult([hit('x'.repeat(1_000)), hit('second')], 100, 160)
    expect(result.truncated).toBe(true)
    expect(Array.from(renderKnowledgeResult(result)).length).toBeLessThanOrEqual(160)
  })

  it('keeps citations contiguous when an oversized fixed header drops a hit', () => {
    const oversized = { ...hit('first'), documentId: KnowledgeDocumentId('x'.repeat(200)) }
    const result = collectKnowledgeResult([oversized, hit('second')], 100, 1_000)
    expect(result.evidence.map(item => item.citation)).toEqual(['K1'])
    expect(result.evidence[0]?.text).toBe('second')
    expect(result.truncated).toBe(true)
  })
})
