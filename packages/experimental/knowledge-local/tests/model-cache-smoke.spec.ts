import { describe, expect, it } from 'vitest'
import { KnowledgeChunkId, KnowledgeDocumentId } from '@deepseek-ai/dsh-experimental-knowledge'
import { DENSE_DIMENSIONS } from '../src/dense.ts'
import { loadDenseEncoder } from '../src/model-runtime.ts'
import { loadReranker } from '../src/reranker.ts'

const denseCacheDir = process.env['DSH_BGE_MODEL_CACHE_DIR']
const rerankerCacheDir = process.env['DSH_BGE_RERANKER_CACHE_DIR']

describe.skipIf(denseCacheDir === undefined)('Dense local model smoke', () => {
  it('embeds one document batch and one query without network access', async () => {
    if (denseCacheDir === undefined) throw new TypeError('DSH_BGE_MODEL_CACHE_DIR is required')
    const encoder = await loadDenseEncoder({ cacheDir: denseCacheDir, localFilesOnly: true })
    try {
      await expect(encoder.embedDocuments(['Science\nEvidence supports the claim.']))
        .resolves.toHaveLength(DENSE_DIMENSIONS)
      await expect(encoder.embedQuery('What supports the claim?')).resolves.toHaveLength(DENSE_DIMENSIONS)
    } finally {
      await encoder.dispose()
    }
  })
})

describe.skipIf(rerankerCacheDir === undefined)('Reranker local model smoke', () => {
  it('scores one text pair without network access', async () => {
    if (rerankerCacheDir === undefined) throw new TypeError('DSH_BGE_RERANKER_CACHE_DIR is required')
    const reranker = await loadReranker({ cacheDir: rerankerCacheDir, localFilesOnly: true })
    try {
      await expect(reranker.rerank(
        'claim',
        [{ ordinal: 0, score: 1 }],
        [{
          documentId: KnowledgeDocumentId('doc-a'),
          chunkId: KnowledgeChunkId('chunk-a'),
          title: 'Alpha',
          text: 'first body',
          score: 0,
        }],
        1,
      )).resolves.toHaveLength(1)
    } finally {
      await reranker.dispose()
    }
  })
})
