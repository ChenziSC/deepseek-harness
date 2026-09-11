import { KnowledgeError } from '@deepseek-ai/dsh-experimental-knowledge'
import {
  resolveKnowledgeSearchStrategy,
  type KnowledgeSearchCapabilities,
  type KnowledgeSearchPolicy,
} from '../src/strategy.ts'
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
    expect(resolveKnowledgeSearchStrategy('ordinary scientific question', undefined, policy, capabilities)).toEqual({
      retrieval: 'hybrid',
      denseIndex: 'exact',
      rerank: 'off',
    })
    expect(policy).toMatchObject({ defaultDenseIndex: 'auto', defaultRerank: 'off' })
  })

  it('resolves caller-selected high-level combinations', () => {
    expect(resolveKnowledgeSearchStrategy('alpha', { retrieval: 'bm25', denseIndex: 'auto' }, policy, capabilities)).toEqual({
      retrieval: 'bm25',
      rerank: 'off',
    })
    expect(resolveKnowledgeSearchStrategy('alpha', { retrieval: 'dense', denseIndex: 'exact', rerank: 'on' }, policy, capabilities)).toEqual({
      retrieval: 'dense',
      denseIndex: 'exact',
      rerank: 'on',
    })
  })

  it('routes exact terms to BM25 and other queries to Dense', () => {
    const automatic = { ...policy, defaultRetrieval: 'auto' as const }
    expect(resolveKnowledgeSearchStrategy('ERR_CONNECTION_RESET in api_client', undefined, automatic, capabilities))
      .toMatchObject({ retrieval: 'bm25' })
    expect(resolveKnowledgeSearchStrategy('光合作用是什么', undefined, automatic, capabilities))
      .toMatchObject({ retrieval: 'dense' })
    expect(resolveKnowledgeSearchStrategy('what powers photosynthesis', undefined, automatic, capabilities))
      .toMatchObject({ retrieval: 'dense' })
    expect(resolveKnowledgeSearchStrategy('hello 世界', undefined, automatic, capabilities))
      .toMatchObject({ retrieval: 'dense' })
  })

  it('keeps explicit choices and constrains automatic routing to the allowed set', () => {
    const automatic = { ...policy, defaultRetrieval: 'auto' as const, allowedRetrieval: ['bm25'] as const }
    expect(resolveKnowledgeSearchStrategy('ordinary question', undefined, automatic, capabilities))
      .toEqual({ retrieval: 'bm25', rerank: 'off' })
    expect(resolveKnowledgeSearchStrategy('ERR_123456', { retrieval: 'dense' }, policy, capabilities))
      .toMatchObject({ retrieval: 'dense' })
  })

  it('rejects invalid and deployment-disabled combinations with stable error codes', () => {
    expect(() => resolveKnowledgeSearchStrategy('alpha', { retrieval: 'bm25', denseIndex: 'exact' }, policy, capabilities))
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
        resolveKnowledgeSearchStrategy('alpha', request, restricted, capabilities)
        throw new Error('expected strategy rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(KnowledgeError)
        expect(error).toMatchObject({ code: 'KNOWLEDGE_STRATEGY_NOT_ALLOWED' })
      }
    }

    expect(() => resolveKnowledgeSearchStrategy(
      'alpha',
      { retrieval: 'dense', denseIndex: 'hnsw' },
      policy,
      capabilities,
    )).toThrow(expect.objectContaining({ code: 'KNOWLEDGE_STRATEGY_NOT_ALLOWED' }))

    expect(() => resolveKnowledgeSearchStrategy(
      'alpha',
      { retrieval: 'dense', denseIndex: 'hnsw' },
      { ...policy, allowedDenseIndexes: ['exact', 'hnsw'] },
      capabilities,
    )).toThrow(expect.objectContaining({ code: 'KNOWLEDGE_SEARCH_FAILED' }))
  })
})
