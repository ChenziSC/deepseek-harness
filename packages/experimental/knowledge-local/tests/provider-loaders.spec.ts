import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadDenseEncoder: vi.fn<(options: Record<string, unknown>) => Promise<{ kind: string }>>(
    () => Promise.resolve({ kind: 'dense' }),
  ),
  loadReranker: vi.fn<(options: Record<string, unknown>) => Promise<{ kind: string }>>(
    () => Promise.resolve({ kind: 'reranker' }),
  ),
}))

vi.mock('../src/model-runtime.ts', () => ({
  BGE_DENSE_DTYPE: 'q8',
  BGE_DENSE_MODEL_FILE: 'onnx/model_quantized.onnx',
  BGE_QUERY_PREFIX: '',
  DEFAULT_DENSE_MAX_TOKENS: 512,
  DenseEncoder: class { readonly mocked = true },
  loadDenseEncoder: mocks.loadDenseEncoder,
}))

vi.mock('../src/reranker.ts', () => ({
  BGE_RERANKER_DTYPE: 'q8',
  BGE_RERANKER_MODEL_ID: 'reranker-default',
  BGE_RERANKER_REVISION: 'c'.repeat(40),
  DEFAULT_RERANKER_BATCH_SIZE: 8,
  DEFAULT_RERANKER_MAX_TOKENS: 512,
  Reranker: class { readonly mocked = true },
  loadReranker: mocks.loadReranker,
}))

import { LocalKnowledgeProvider } from '../src/provider.ts'

class ExposedLocalKnowledgeProvider extends LocalKnowledgeProvider {
  loadDense() {
    return this.createDenseEncoder()
  }

  loadReranker() {
    return this.createReranker()
  }
}

describe('LocalKnowledge provider model loaders', () => {
  it('forwards the resolved local-only model configuration', async () => {
    const provider = new ExposedLocalKnowledgeProvider(new Context(), {
      indexDir: './index',
      defaultRetrieval: 'dense',
      defaultDenseIndex: 'exact',
      defaultRerank: 'on',
      allowedRetrieval: ['dense'],
      allowedDenseIndexes: ['exact'],
      allowedRerank: true,
      modelCacheDir: './models',
      denseModelId: 'dense-model',
      denseModelRevision: 'a'.repeat(40),
      denseMaxTokens: 128,
      rerankerModelId: 'reranker-model',
      rerankerModelRevision: 'b'.repeat(40),
      rerankerMaxTokens: 256,
    })

    await expect(provider.loadDense()).resolves.toEqual({ kind: 'dense' })
    const denseOptions = mocks.loadDenseEncoder.mock.calls[0]?.[0] as Record<string, unknown>
    expect(denseOptions['cacheDir']).toEqual(expect.stringContaining('/models'))
    expect(denseOptions).toMatchObject({
      localFilesOnly: true,
      modelId: 'dense-model',
      revision: 'a'.repeat(40),
      dtype: 'q8',
      maxTokens: 128,
    })
    await expect(provider.loadReranker()).resolves.toEqual({ kind: 'reranker' })
    const rerankerOptions = mocks.loadReranker.mock.calls[0]?.[0] as Record<string, unknown>
    expect(rerankerOptions['cacheDir']).toEqual(expect.stringContaining('/models'))
    expect(rerankerOptions).toMatchObject({
      localFilesOnly: true,
      modelId: 'reranker-model',
      revision: 'b'.repeat(40),
      dtype: 'q8',
      maxTokens: 256,
    })
  })
})
