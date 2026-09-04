import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  BGE_SMALL_EN_MODEL_ID,
  BGE_SMALL_EN_REVISION,
  DENSE_DIMENSIONS,
  DenseEncoder,
  LocalKnowledge,
  Reranker,
  buildKnowledgeIndex,
  resolveConfig,
  type ChunkTokenizer,
  type DenseFeatureExtractor,
  type RerankerBackend,
} from '@deepseek-ai/dsh-experimental-knowledge-local'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const contexts: Context[] = []
const whitespaceTokenizer: ChunkTokenizer = {
  countTokens(text) {
    return text.match(/\S+/gu)?.length ?? 0
  },
}

function unitRows(rowCount: number, dimension: number): Float32Array {
  const vectors = new Float32Array(rowCount * DENSE_DIMENSIONS)
  for (let row = 0; row < rowCount; row += 1) vectors[row * DENSE_DIMENSIONS + dimension] = 1
  return vectors
}

function queryEncoder(dimension: number): DenseEncoder {
  const extractor: DenseFeatureExtractor = {
    extract: texts => Promise.resolve({
      type: 'float32',
      dims: [texts.length, DENSE_DIMENSIONS],
      data: unitRows(texts.length, dimension),
    }),
    dispose: () => Promise.resolve(),
  }
  return new DenseEncoder(extractor, 512)
}

function contentReranker(): Reranker {
  const backend: RerankerBackend = {
    scorePairs(_queries, documents) {
      return Promise.resolve({
        type: 'float32',
        dims: [documents.length, 1],
        data: Float32Array.from(documents.map(document => document.includes('beta') ? 0.9 : 0.1)),
      })
    },
    dispose: () => Promise.resolve(),
  }
  return new Reranker(backend, 512)
}

async function denseIndex(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-provider-'))
  const outputDir = join(root, 'index')
  temporaryDirectories.push(root)
  await buildKnowledgeIndex({
    corpusText: [
      '{"id":"doc-a","text":"alpha"}',
      '{"id":"doc-b","text":"beta"}',
    ].join('\n'),
    outputDir,
    tokenizer: whitespaceTokenizer,
    chunking: { maxTokens: 8, overlapTokens: 0 },
    bm25K1: 1.2,
    bm25B: 0.75,
    dense: {
      encoder: {
        embedDocuments(texts) {
          const vectors = new Float32Array(texts.length * DENSE_DIMENSIONS)
          for (const [row, text] of texts.entries()) {
            vectors[row * DENSE_DIMENSIONS + (text === 'alpha' ? 0 : 1)] = 1
          }
          return Promise.resolve(vectors)
        },
      },
      batchSize: 2,
      modelId: BGE_SMALL_EN_MODEL_ID,
      revision: BGE_SMALL_EN_REVISION,
      dtype: 'q8',
    },
  })
  return outputDir
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('LocalKnowledge model-backed modes', () => {
  it('shares one in-flight model load across concurrent searches', async () => {
    let loadCount = 0
    let completeLoad: ((encoder: DenseEncoder) => void) | undefined
    const loading = new Promise<DenseEncoder>((resolve) => {
      completeLoad = resolve
    })
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        loadCount += 1
        return loading
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      mode: 'dense',
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
    })

    const first = context.knowledge.search({ query: 'claim', maxResults: 1 })
    const second = context.knowledge.search({ query: 'claim', maxResults: 1 })
    await Promise.resolve()
    expect(loadCount).toBe(1)
    completeLoad?.(queryEncoder(1))

    await expect(first).resolves.toMatchObject({ hits: [{ documentId: 'doc-b' }] })
    await expect(second).resolves.toMatchObject({ hits: [{ documentId: 'doc-b' }] })
    await expect(context.knowledge.search({ query: 'claim', maxResults: 1 }))
      .resolves.toMatchObject({ hits: [{ documentId: 'doc-b' }] })
    expect(loadCount).toBe(1)
  })

  it('allows a failed model load to be retried by the next search', async () => {
    let loadCount = 0
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        loadCount += 1
        return loadCount === 1 ? Promise.reject(new Error('fixture load failure')) : Promise.resolve(queryEncoder(0))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      mode: 'dense',
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
    })

    await expect(context.knowledge.search({ query: 'claim', maxResults: 1 })).rejects.toThrow('Knowledge search failed')
    await expect(context.knowledge.search({ query: 'claim', maxResults: 1 }))
      .resolves.toMatchObject({ hits: [{ documentId: 'doc-a' }] })
    expect(loadCount).toBe(2)
  })

  it('does not require or load a Dense model in BM25 mode', async () => {
    let loadCount = 0
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        loadCount += 1
        return Promise.reject(new Error('must not load'))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: join(process.cwd(), 'examples/rag-knowledge/index'),
      mode: 'bm25',
      candidateCount: 2,
    })

    await expect(context.knowledge.search({ query: 'photosynthesis', maxResults: 1 }))
      .resolves.toMatchObject({ hits: [{ documentId: 'photosynthesis' }] })
    expect(loadCount).toBe(0)
  })

  it('requires an explicit cache only when Dense or Hybrid mode is selected', () => {
    expect(() => resolveConfig({ indexDir: './index', mode: 'dense' })).toThrow('modelCacheDir is required')
    expect(() => resolveConfig({ indexDir: './index', mode: 'hybrid' })).toThrow('modelCacheDir is required')
    expect(() => resolveConfig({ indexDir: './index', mode: 'bm25', rerank: true })).toThrow('modelCacheDir is required')
    expect(resolveConfig({ indexDir: './index', mode: 'bm25' }).modelCacheDir).toBeUndefined()
  })

  it('combines BM25 and Dense candidates in Hybrid mode', async () => {
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(1))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      mode: 'hybrid',
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
    })

    await expect(context.knowledge.search({ query: 'alpha', maxResults: 2 })).resolves.toMatchObject({
      hits: [
        { documentId: 'doc-a', score: 1 / 61 + 1 / 62 },
        { documentId: 'doc-b', score: 1 / 61 },
      ],
    })
  })

  it.each([
    { mode: 'bm25', rerank: false, expected: ['doc-a'] },
    { mode: 'bm25', rerank: true, expected: ['doc-a'] },
    { mode: 'dense', rerank: false, expected: ['doc-b', 'doc-a'] },
    { mode: 'dense', rerank: true, expected: ['doc-b', 'doc-a'] },
    { mode: 'hybrid', rerank: false, expected: ['doc-a', 'doc-b'] },
    { mode: 'hybrid', rerank: true, expected: ['doc-b', 'doc-a'] },
  ] as const)('supports $mode retrieval with rerank=$rerank', async ({ mode, rerank, expected }) => {
    let rerankerLoads = 0
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(1))
      }

      protected override createReranker(): Promise<Reranker> {
        rerankerLoads += 1
        return Promise.resolve(contentReranker())
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      mode,
      rerank,
      ...(mode === 'bm25' && !rerank ? {} : { modelCacheDir: '/unused-test-cache' }),
      candidateCount: 2,
    })

    const result = await context.knowledge.search({ query: 'alpha', maxResults: 2 })
    expect(result.hits.map(hit => hit.documentId)).toEqual(expected)
    expect(rerankerLoads).toBe(rerank ? 1 : 0)
  })

  it('shares reranker loads and retries after a failed load', async () => {
    let loadCount = 0
    let completeLoad: ((reranker: Reranker) => void) | undefined
    const loading = new Promise<Reranker>((resolve) => {
      completeLoad = resolve
    })
    class SharedKnowledge extends LocalKnowledge {
      protected override createReranker(): Promise<Reranker> {
        loadCount += 1
        return loading
      }
    }
    const sharedContext = new Context()
    contexts.push(sharedContext)
    await sharedContext.plugin(SharedKnowledge, {
      indexDir: await denseIndex(),
      mode: 'bm25',
      rerank: true,
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
    })
    const first = sharedContext.knowledge.search({ query: 'alpha', maxResults: 1 })
    const second = sharedContext.knowledge.search({ query: 'alpha', maxResults: 1 })
    await Promise.resolve()
    expect(loadCount).toBe(1)
    completeLoad?.(contentReranker())
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(loadCount).toBe(1)

    class RetryKnowledge extends LocalKnowledge {
      protected override createReranker(): Promise<Reranker> {
        loadCount += 1
        return loadCount === 2
          ? Promise.reject(new Error('fixture reranker load failure'))
          : Promise.resolve(contentReranker())
      }
    }
    const retryContext = new Context()
    contexts.push(retryContext)
    await retryContext.plugin(RetryKnowledge, {
      indexDir: await denseIndex(),
      mode: 'bm25',
      rerank: true,
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
    })
    await expect(retryContext.knowledge.search({ query: 'alpha', maxResults: 1 })).rejects.toThrow('Knowledge search failed')
    await expect(retryContext.knowledge.search({ query: 'alpha', maxResults: 1 })).resolves.toMatchObject({
      hits: [{ documentId: 'doc-a' }],
    })
    expect(loadCount).toBe(3)
  })

  it('releases loaded models and rejects searches after disposal', async () => {
    let denseDisposals = 0
    let rerankerDisposals = 0
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(new DenseEncoder({
          extract: texts => Promise.resolve({
            type: 'float32',
            dims: [texts.length, DENSE_DIMENSIONS],
            data: unitRows(texts.length, 1),
          }),
          dispose: () => {
            denseDisposals += 1
            return Promise.resolve()
          },
        }, 512))
      }

      protected override createReranker(): Promise<Reranker> {
        const rerankerBackend: RerankerBackend = {
          scorePairs(_queries, documents) {
            return Promise.resolve({
              type: 'float32',
              dims: [documents.length, 1],
              data: new Float32Array(documents.length).fill(1),
            })
          },
          dispose() {
            rerankerDisposals += 1
            return Promise.resolve()
          },
        }
        return Promise.resolve(new Reranker(rerankerBackend, 512))
      }
    }
    const context = new Context()
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      mode: 'hybrid',
      rerank: true,
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
    })
    const provider = context.knowledge
    await provider.search({ query: 'alpha', maxResults: 1 })
    await context.fiber.dispose()

    expect(denseDisposals).toBe(1)
    expect(rerankerDisposals).toBe(1)
    await expect(provider.search({ query: 'alpha', maxResults: 1 })).rejects.toThrow('closed')
  })
})
