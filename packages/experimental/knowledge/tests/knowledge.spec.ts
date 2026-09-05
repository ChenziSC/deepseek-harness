import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Knowledge, {
  KnowledgeChunkId,
  KnowledgeDocumentId,
  KnowledgeError,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResult,
} from '@deepseek-ai/dsh-experimental-knowledge'

class FixtureKnowledge extends Knowledge {
  async search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult> {
    return Promise.resolve({
      strategy: { retrieval: 'bm25', rerank: false },
      hits: [{
        documentId: KnowledgeDocumentId('doc-1'),
        chunkId: KnowledgeChunkId('doc-1:0-1'),
        text: request.query,
        score: 1,
      }],
    })
  }
}

describe('Knowledge', () => {
  it('registers a provider implementation on ctx.knowledge', async () => {
    const ctx = new Context()
    await ctx.plugin(FixtureKnowledge)

    await expect(ctx.knowledge.search({ query: 'evidence', maxResults: 1 })).resolves.toEqual({
      strategy: { retrieval: 'bm25', rerank: false },
      hits: [{
        documentId: 'doc-1',
        chunkId: 'doc-1:0-1',
        text: 'evidence',
        score: 1,
      }],
    })
  })

  it('keeps stable error codes separate from messages', () => {
    const error = new KnowledgeError('invalid query', 'KNOWLEDGE_INVALID_REQUEST')
    expect(error).toMatchObject({ name: 'KnowledgeError', message: 'invalid query', code: 'KNOWLEDGE_INVALID_REQUEST' })
  })
})
