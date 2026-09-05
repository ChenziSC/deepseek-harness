import { KnowledgeError } from '@deepseek-ai/dsh-experimental-knowledge'
import {
  resolveKnowledgeSearchStrategy,
  type KnowledgeSearchCapabilities,
  type KnowledgeSearchPolicy,
} from '@deepseek-ai/dsh-experimental-knowledge-local'
import { describe, expect, it } from 'vitest'

const policy: KnowledgeSearchPolicy = {
  defaultRetrieval: 'hybrid',
  defaultDenseIndex: 'auto',
  defaultRerank: 'off',
  allowedRetrieval: ['bm25', 'dense', 'hybrid'],
  allowedDenseIndexes: ['exact'],
  allowedRerank: true,
}

const capabilities: KnowledgeSearchCapabilities = {
  autoDenseIndex: 'exact',
  availableDenseIndexes: ['exact'],
}

describe('knowledge search strategy resolution', () => {
  it('resolves the default performance strategy without mutating policy', () => {
    expect(resolveKnowledgeSearchStrategy(undefined, policy, capabilities)).toEqual({
      retrieval: 'hybrid',
      denseIndex: 'exact',
      rerank: false,
    })
    expect(policy).toMatchObject({ defaultDenseIndex: 'auto', defaultRerank: 'off' })
  })

  it('resolves caller-selected high-level combinations', () => {
    expect(resolveKnowledgeSearchStrategy({ retrieval: 'bm25', denseIndex: 'auto' }, policy, capabilities)).toEqual({
      retrieval: 'bm25',
      rerank: false,
    })
    expect(resolveKnowledgeSearchStrategy({ retrieval: 'dense', denseIndex: 'exact', rerank: 'on' }, policy, capabilities)).toEqual({
      retrieval: 'dense',
      denseIndex: 'exact',
      rerank: true,
    })
  })

  it('rejects invalid and deployment-disabled combinations with stable error codes', () => {
    expect(() => resolveKnowledgeSearchStrategy({ retrieval: 'bm25', denseIndex: 'exact' }, policy, capabilities))
      .toThrow(expect.objectContaining({ code: 'KNOWLEDGE_INVALID_REQUEST' }))

    const restricted: KnowledgeSearchPolicy = {
      ...policy,
      allowedRetrieval: ['bm25'],
      allowedDenseIndexes: [],
      allowedRerank: false,
    }
    for (const request of [
      { retrieval: 'dense' as const },
      { retrieval: 'bm25' as const, rerank: 'on' as const },
    ]) {
      try {
        resolveKnowledgeSearchStrategy(request, restricted, capabilities)
        throw new Error('expected strategy rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(KnowledgeError)
        expect(error).toMatchObject({ code: 'KNOWLEDGE_STRATEGY_NOT_ALLOWED' })
      }
    }

    expect(() => resolveKnowledgeSearchStrategy(
      { retrieval: 'dense', denseIndex: 'hnsw' },
      policy,
      capabilities,
    )).toThrow(expect.objectContaining({ code: 'KNOWLEDGE_STRATEGY_NOT_ALLOWED' }))

    expect(() => resolveKnowledgeSearchStrategy(
      { retrieval: 'dense', denseIndex: 'hnsw' },
      { ...policy, allowedDenseIndexes: ['exact', 'hnsw'] },
      capabilities,
    )).toThrow(expect.objectContaining({ code: 'KNOWLEDGE_SEARCH_FAILED' }))
  })
})
