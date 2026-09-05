import { describe, expect, it, vi } from 'vitest'

const transformerMocks = vi.hoisted(() => {
  const tokenizer = Object.assign(vi.fn(() => ({ input_ids: [] })), { padding_side: 'left' })
  const dispose = vi.fn(() => Promise.resolve())
  const state: { output: unknown } = {
    output: { logits: { type: 'float32', dims: [1], data: Float32Array.of(0.75) } },
  }
  const model = Object.assign(vi.fn(() => Promise.resolve(state.output)), { dispose })
  return {
    tokenizer,
    dispose,
    state,
    model,
    tokenizerFromPretrained: vi.fn(() => Promise.resolve(tokenizer)),
    modelFromPretrained: vi.fn(() => Promise.resolve(model)),
  }
})

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: transformerMocks.tokenizerFromPretrained },
  AutoModelForSequenceClassification: { from_pretrained: transformerMocks.modelFromPretrained },
}))
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

    for (const output of [
      { type: 'float64', dims: [2], data: Float32Array.of(1, 2) },
      { type: 'float32', dims: [2, 2], data: Float32Array.of(1, 2) },
      { type: 'float32', dims: [2], data: [1, 2] },
      { type: 'float32', dims: [2], data: Float32Array.of(1) },
    ]) {
      const invalid = new Reranker({
        scorePairs: () => Promise.resolve(output),
        dispose: () => Promise.resolve(),
      }, 512)
      await expect(invalid.rerank('query', candidates, chunks, 2)).rejects.toThrow()
    }
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

  it.each([
    [{ cacheDir: ' ' }, 'reranker cacheDir must be non-empty'],
    [{ cacheDir: '/cache', modelId: ' ' }, 'reranker modelId must be non-empty'],
    [{ cacheDir: '/cache', revision: 'main' }, 'reranker revision must be a full lowercase commit SHA'],
    [{ cacheDir: '/cache', maxTokens: 0 }, 'reranker maxTokens must be an integer from 1 through 512'],
    [{ cacheDir: '/cache', maxTokens: 513 }, 'reranker maxTokens must be an integer from 1 through 512'],
    [{ cacheDir: '/cache', maxTokens: 1.5 }, 'reranker maxTokens must be an integer from 1 through 512'],
  ])('rejects invalid loader options %j', async (override, message) => {
    await expect(loadReranker({ localFilesOnly: true, ...override })).rejects.toThrow(message)
  })

  it('rejects invalid batches and candidate ordinals', async () => {
    const reranker = new Reranker(backend([], [[1]]), 512)
    await expect(reranker.rerank('query', [{ ordinal: 0, score: 1 }], chunks, 0))
      .rejects.toThrow('batchSize must be a positive safe integer')
    await expect(reranker.rerank('query', [{ ordinal: 99, score: 1 }], chunks, 1))
      .rejects.toThrow('candidate ordinal is out of range')
  })

  it('accepts one-dimensional logits and releases the backend', async () => {
    const dispose = vi.fn(() => Promise.resolve())
    const reranker = new Reranker({
      scorePairs: () => Promise.resolve({ type: 'float32', dims: [1], data: Float32Array.of(1) }),
      dispose,
    }, 512)
    await expect(reranker.rerank('query', [{ ordinal: 0, score: 1 }], chunks, 1))
      .resolves.toEqual([{ ordinal: 0, score: 1 }])
    await reranker.dispose()
    expect(dispose).toHaveBeenCalled()
  })

  it('uses the Transformers.js adapter and validates its response object', async () => {
    transformerMocks.state.output = {
      logits: { type: 'float32', dims: [1], data: Float32Array.of(0.75) },
    }
    const reranker = await loadReranker({
      cacheDir: '/cache',
      localFilesOnly: true,
      modelId: 'model',
      revision: 'a'.repeat(40),
      dtype: 'q8',
      maxTokens: 64,
    })
    await expect(reranker.rerank('query', [{ ordinal: 0, score: 1 }], chunks, 1))
      .resolves.toEqual([{ ordinal: 0, score: 0.75 }])
    expect(transformerMocks.tokenizer.padding_side).toBe('right')
    expect(transformerMocks.tokenizer).toHaveBeenCalledWith(['query'], {
      text_pair: ['Alpha\nfirst body'],
      padding: true,
      truncation: true,
      max_length: 64,
    })
    expect(transformerMocks.model).toHaveBeenCalledWith({ input_ids: [] })
    await reranker.dispose()
    expect(transformerMocks.dispose).toHaveBeenCalled()

    for (const output of [null, [], {}, { logits: null }, { logits: [] }]) {
      transformerMocks.state.output = output
      const invalid = await loadReranker({ cacheDir: '/cache', localFilesOnly: true })
      await expect(invalid.rerank('query', [{ ordinal: 0, score: 1 }], chunks, 1))
        .rejects.toThrow('did not return logits')
    }

    transformerMocks.state.output = { logits: { data: Float32Array.of(1) } }
    const missingMetadata = await loadReranker({ cacheDir: '/cache', localFilesOnly: true })
    await expect(missingMetadata.rerank('query', [{ ordinal: 0, score: 1 }], chunks, 1))
      .rejects.toThrow('must be float32')
  })
})
