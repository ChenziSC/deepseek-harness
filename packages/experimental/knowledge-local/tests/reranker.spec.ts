import { describe, expect, it } from 'vitest'
import {
  BGE_RERANKER_DTYPE,
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  Reranker,
  loadReranker,
  type RerankerBackend,
  type RerankerInferenceOptions,
} from '@deepseek-ai/dsh-experimental-knowledge-local'
import { KnowledgeChunkId, KnowledgeDocumentId, type KnowledgeHit } from '@deepseek-ai/dsh-experimental-knowledge'

const chunks: KnowledgeHit[] = [
  {
    documentId: KnowledgeDocumentId('doc-a'),
    chunkId: KnowledgeChunkId('chunk-a'),
    title: 'Alpha',
    text: 'first body',
    score: 0,
  },
  {
    documentId: KnowledgeDocumentId('doc-b'),
    chunkId: KnowledgeChunkId('chunk-b'),
    text: 'second body',
    score: 0,
  },
  {
    documentId: KnowledgeDocumentId('doc-c'),
    chunkId: KnowledgeChunkId('chunk-c'),
    text: 'third body',
    score: 0,
  },
]

function backend(
  calls: Array<{ queries: readonly string[]; documents: readonly string[]; options: RerankerInferenceOptions }>,
  outputs: readonly number[][],
): RerankerBackend {
  let call = 0
  return {
    scorePairs(queries, documents, options) {
      calls.push({ queries: [...queries], documents: [...documents], options })
      const values = outputs[call] ?? []
      call += 1
      return Promise.resolve({
        type: 'float32',
        dims: [values.length, 1],
        data: Float32Array.from(values),
      })
    },
    dispose: () => Promise.resolve(),
  }
}

describe('Reranker', () => {
  it('batches text pairs and keeps recall order for equal logits', async () => {
    const calls: Array<{ queries: readonly string[]; documents: readonly string[]; options: RerankerInferenceOptions }> = []
    const reranker = new Reranker(backend(calls, [[0.2, 0.9], [0.9]]), 37)
    const result = await reranker.rerank(
      'claim',
      [{ ordinal: 0, score: 3 }, { ordinal: 1, score: 2 }, { ordinal: 2, score: 1 }],
      chunks,
      2,
    )

    expect(result.map(match => match.ordinal)).toEqual([1, 2, 0])
    expect(calls).toEqual([
      {
        queries: ['claim', 'claim'],
        documents: ['Alpha\nfirst body', 'second body'],
        options: {
          padding: true,
          truncation: true,
          truncationStrategy: 'longest_first',
          truncationSide: 'right',
          maxLength: 37,
        },
      },
      {
        queries: ['claim'],
        documents: ['third body'],
        options: {
          padding: true,
          truncation: true,
          truncationStrategy: 'longest_first',
          truncationSide: 'right',
          maxLength: 37,
        },
      },
    ])
  })

  it('rejects invalid outputs and never returns partial batches', async () => {
    const candidates = [{ ordinal: 0, score: 3 }, { ordinal: 1, score: 2 }]
    const wrongCount = new Reranker(backend([], [[0.5]]), 512)
    await expect(wrongCount.rerank('query', candidates, chunks, 2)).rejects.toThrow('must contain 2 logits')

    const nonFinite = new Reranker(backend([], [[0.5, Number.NaN]]), 512)
    await expect(nonFinite.rerank('query', candidates, chunks, 2)).rejects.toThrow('non-finite')

    const failing: RerankerBackend = {
      scorePairs: () => Promise.reject(new Error('batch failed')),
      dispose: () => Promise.resolve(),
    }
    await expect(new Reranker(failing, 512).rerank('query', candidates, chunks, 1)).rejects.toThrow('batch failed')
  })

  it('checks cancellation before and after each batch', async () => {
    const before = new AbortController()
    before.abort()
    const untouched = backend([], [[1]])
    await expect(new Reranker(untouched, 512).rerank('query', [{ ordinal: 0, score: 1 }], chunks, 1, before.signal))
      .rejects.toThrow('cancelled')

    const after = new AbortController()
    const aborting: RerankerBackend = {
      scorePairs() {
        after.abort()
        return Promise.resolve({ type: 'float32', dims: [1, 1], data: Float32Array.of(1) })
      },
      dispose: () => Promise.resolve(),
    }
    await expect(new Reranker(aborting, 512).rerank('query', [{ ordinal: 0, score: 1 }], chunks, 1, after.signal))
      .rejects.toThrow('cancelled')
  })

  it('passes the fixed model identity and local-only policy to the loader', async () => {
    let received: Parameters<NonNullable<Parameters<typeof loadReranker>[1]>>[0] | undefined
    await loadReranker({ cacheDir: '/model-cache', localFilesOnly: true }, (options) => {
      received = options
      return Promise.resolve(backend([], []))
    })

    expect(received).toEqual({
      cacheDir: '/model-cache',
      localFilesOnly: true,
      modelId: BGE_RERANKER_MODEL_ID,
      revision: BGE_RERANKER_REVISION,
      dtype: BGE_RERANKER_DTYPE,
      maxTokens: 512,
    })
  })
})

const modelCacheDir = process.env['DSH_BGE_RERANKER_CACHE_DIR']

describe.skipIf(modelCacheDir === undefined)('Reranker local model smoke', () => {
  it('scores one text pair without network access', async () => {
    if (modelCacheDir === undefined) throw new TypeError('DSH_BGE_RERANKER_CACHE_DIR is required')
    const reranker = await loadReranker({ cacheDir: modelCacheDir, localFilesOnly: true })
    try {
      await expect(reranker.rerank('claim', [{ ordinal: 0, score: 1 }], chunks, 1))
        .resolves.toHaveLength(1)
    } finally {
      await reranker.dispose()
    }
  })
})
