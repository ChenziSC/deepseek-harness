import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { ChunkTokenizer } from '../src/tokenizer.ts'
import { resolveConfig, type LocalKnowledgeConfig } from '../src/config.ts'
import { DENSE_DIMENSIONS } from '../src/dense.ts'
import { HnswIndex } from '../src/hnsw.ts'
import { buildKnowledgeIndex } from '../src/index-builder.ts'
import { loadKnowledgeIndex } from '../src/index-format.ts'
import { LocalKnowledge } from '../src/index.ts'
import { DenseEncoder, type DenseFeatureExtractor } from '../src/model-runtime.ts'
import { Reranker, type RerankerBackend } from '../src/reranker.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION } from '../src/tokenizer.ts'
import type { ResolvedKnowledgeRetrieval } from '@deepseek-ai/dsh-experimental-knowledge'
import { afterEach, describe, expect, it, vi } from 'vitest'

const temporaryDirectories: string[] = []
const contexts: Context[] = []
const whitespaceTokenizer: ChunkTokenizer = {
  countTokens(text) {
    return text.match(/\S+/gu)?.length ?? 0
  },
}

function fixedStrategy(
  retrieval: ResolvedKnowledgeRetrieval,
  rerank = false,
): Pick<LocalKnowledgeConfig, 'defaultRetrieval' | 'defaultDenseIndex' | 'defaultRerank' | 'allowedRetrieval' | 'allowedDenseIndexes' | 'allowedRerank'> {
  return {
    defaultRetrieval: retrieval,
    defaultDenseIndex: 'exact',
    defaultRerank: rerank ? 'on' : 'off',
    allowedRetrieval: [retrieval],
    allowedDenseIndexes: ['exact'],
    allowedRerank: rerank,
  }
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

async function denseIndex(requestedIndex: 'auto' | 'exact' | 'hnsw' = 'auto'): Promise<string> {
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
      modelId: BGE_M3_MODEL_ID,
      revision: BGE_M3_REVISION,
      dtype: 'q8',
      denseIndex: requestedIndex,
    },
  })
  return outputDir
}

async function bm25Index(text: string, maxTokens = 2, overlapTokens = 0): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-provider-bm25-'))
  const outputDir = join(root, 'index')
  temporaryDirectories.push(root)
  await buildKnowledgeIndex({
    corpusText: `${JSON.stringify({ id: 'doc-a', text })}\n${JSON.stringify({ id: 'doc-b', text: 'unrelated material' })}`,
    outputDir,
    tokenizer: whitespaceTokenizer,
    chunking: { maxTokens, overlapTokens },
  })
  return outputDir
}

async function versionedIndex(
  documents: readonly Record<string, unknown>[],
  denseIndex: 'exact' | 'hnsw' | 'both' = 'both',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-provider-versioned-'))
  const outputDir = join(root, 'index')
  temporaryDirectories.push(root)
  await buildKnowledgeIndex({
    corpusText: documents.map(document => JSON.stringify(document)).join('\n'),
    outputDir,
    tokenizer: whitespaceTokenizer,
    chunking: { maxTokens: 32, overlapTokens: 0 },
    dense: {
      encoder: {
        embedDocuments(texts) {
          return Promise.resolve(unitRows(texts.length, 0))
        },
      },
      batchSize: 8,
      modelId: BGE_M3_MODEL_ID,
      revision: BGE_M3_REVISION,
      dtype: 'q8',
      denseIndex,
    },
  })
  return outputDir
}

async function versionValidityCorpus(): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(
    new URL('../../../../specs/rag/phase-six/data/version-validity-corpus.jsonl', import.meta.url),
    'utf8',
  )
  return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('LocalKnowledge model-backed modes', () => {
  it('executes explicit HNSW Dense retrieval without loading Exact vectors', async () => {
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(0))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex('hnsw'),
      ...fixedStrategy('dense'),
      defaultDenseIndex: 'hnsw',
      allowedDenseIndexes: ['hnsw'],
      candidateCount: 2,
      modelCacheDir: '/cache',
    })

    await expect(context.knowledge.search({ query: 'alpha', maxResults: 1 })).resolves.toMatchObject({
      strategy: { retrieval: 'dense', denseIndex: 'hnsw', rerank: false },
      hits: [{ documentId: 'doc-a' }],
    })
    await expect(context.knowledge.search({ query: 'alpha', maxResults: 1 })).resolves.toMatchObject({
      hits: [{ documentId: 'doc-a' }],
    })
  })

  it('shares HNSW loading, rejects missing graphs, and observes disposal before publication', async () => {
    const hnswIndex = await loadKnowledgeIndex(await denseIndex('hnsw'))
    const context = new Context()
    contexts.push(context)
    const provider = new LocalKnowledge(context, {
      indexDir: '/unused',
      ...fixedStrategy('bm25'),
    })
    const getHnsw = (provider as unknown as {
      getHnsw(index: typeof hnswIndex): Promise<unknown>
    }).getHnsw.bind(provider)
    const first = getHnsw(hnswIndex)
    const second = getHnsw(hnswIndex)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    await expect(getHnsw(hnswIndex)).resolves.toBeDefined()
    hnswIndex.sqlite.close()

    const exactIndex = await loadKnowledgeIndex(await denseIndex('exact'))
    const missingProvider = new LocalKnowledge(new Context(), {
      indexDir: '/unused',
      ...fixedStrategy('bm25'),
    })
    const getMissingHnsw = (missingProvider as unknown as {
      getHnsw(index: typeof exactIndex): Promise<unknown>
    }).getHnsw.bind(missingProvider)
    await expect(getMissingHnsw(exactIndex)).rejects.toThrow('does not contain an HNSW index')
    exactIndex.sqlite.close()

    const closingIndex = await loadKnowledgeIndex(await denseIndex('hnsw'))
    const closingContext = new Context()
    const closingProvider = new LocalKnowledge(closingContext, {
      indexDir: '/unused',
      ...fixedStrategy('bm25'),
    })
    await closingContext.fiber.dispose()
    const getClosingHnsw = (closingProvider as unknown as {
      getHnsw(index: typeof closingIndex): Promise<unknown>
    }).getHnsw.bind(closingProvider)
    await expect(getClosingHnsw(closingIndex)).rejects.toThrow('closed')
    closingIndex.sqlite.close()
  })

  it('stably orders equal-score HNSW matches by chunk identifier', async () => {
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(2))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex('hnsw'),
      ...fixedStrategy('dense'),
      defaultDenseIndex: 'hnsw',
      allowedDenseIndexes: ['hnsw'],
      candidateCount: 2,
      modelCacheDir: '/cache',
    })
    await expect(context.knowledge.search({ query: 'neutral', maxResults: 2 }).then(result => result.hits.map(hit => hit.documentId)))
      .resolves.toEqual(['doc-a', 'doc-b'])
  })

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
      ...fixedStrategy('dense'),
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
      ...fixedStrategy('dense'),
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
      ...fixedStrategy('bm25'),
      candidateCount: 2,
    })

    await expect(context.knowledge.search({ query: 'photosynthesis', maxResults: 1 }))
      .resolves.toMatchObject({ hits: [{ documentId: 'photosynthesis' }] })
    expect(loadCount).toBe(0)
  })

  it('rejects invalid requests before retrieval', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LocalKnowledge, {
      indexDir: join(process.cwd(), 'examples/rag-knowledge/index'),
      ...fixedStrategy('bm25'),
      candidateCount: 2,
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(context.knowledge.search({ query: 'alpha', maxResults: 1 }, aborted.signal)).rejects.toThrow('cancelled')
    await expect(context.knowledge.search({ query: ' ', maxResults: 1 })).rejects.toThrow('non-empty query')
    await expect(context.knowledge.search({ query: 'alpha', maxResults: 0 })).rejects.toThrow('positive result limit')
    await expect(context.knowledge.search({ query: 'alpha', maxResults: 1.5 })).rejects.toThrow('positive result limit')
    await expect(context.knowledge.search({ query: 'alpha', maxResults: 3 })).rejects.toThrow('exceeds the configured candidate count')
    await expect(context.knowledge.search({ query: 'alpha', maxResults: 1, asOf: '2026-01-01' }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_REQUEST' })
  })

  it.each([
    ['bm25', undefined],
    ['dense', 'exact'],
    ['dense', 'hnsw'],
    ['hybrid', 'exact'],
  ] as const)('filters %s/%s candidates at one inclusive-exclusive instant', async (retrieval, denseIndex) => {
    const indexDir = await versionedIndex(await versionValidityCorpus())
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(0))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir,
      defaultRetrieval: retrieval,
      defaultDenseIndex: denseIndex ?? 'exact',
      defaultRerank: 'off',
      allowedRetrieval: [retrieval],
      allowedDenseIndexes: denseIndex === undefined ? [] : [denseIndex],
      allowedRerank: false,
      ...(denseIndex === undefined ? {} : { modelCacheDir: '/cache' }),
      candidateCount: 7,
    })

    const result = await context.knowledge.search({
      query: 'common',
      maxResults: 7,
      asOf: '2026-06-01T08:00:00+08:00',
    })
    expect(result.hits.map(hit => hit.documentId).sort()).toEqual([
      'c-starting',
      'e-unknown',
      'f-left-only',
      'g-right-only',
      'h-overlap-v1',
      'i-overlap-v2',
    ])
    expect(result.hits.find(hit => hit.documentId === 'c-starting')).toMatchObject({
      sourceVersion: '2026.2',
      validFrom: '2026-06-01T00:00:00.000Z',
      supersedes: 'a-expired',
    })
    expect(result.hits.find(hit => hit.documentId === 'e-unknown')).not.toHaveProperty('validFrom')
  })

  it('selects the fixed version corpus at two historical instants and one future instant', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LocalKnowledge, {
      indexDir: await versionedIndex(await versionValidityCorpus(), 'exact'),
      ...fixedStrategy('bm25'),
      candidateCount: 9,
    })
    const documentsAt = (asOf: string) => context.knowledge.search({
      query: 'common',
      maxResults: 9,
      asOf,
    }).then(result => result.hits.map(hit => hit.documentId).sort())

    await expect(documentsAt('2025-06-01T00:00:00Z')).resolves.toEqual([
      'a-expired',
      'b-ending',
      'e-unknown',
      'f-left-only',
      'g-right-only',
      'h-overlap-v1',
    ])
    await expect(documentsAt('2026-06-01T00:00:00Z')).resolves.toEqual([
      'c-starting',
      'e-unknown',
      'f-left-only',
      'g-right-only',
      'h-overlap-v1',
      'i-overlap-v2',
    ])
    await expect(documentsAt('2028-01-01T00:00:00Z')).resolves.toEqual([
      'c-starting',
      'd-future',
      'e-unknown',
      'f-left-only',
      'g-right-only',
      'i-overlap-v2',
    ])
  })

  it('filters BM25 candidates before LIMIT and skips Dense model loading when no document is valid', async () => {
    const indexDir = await versionedIndex([
      { id: 'a-expired', text: 'common', validUntil: '2026-01-01T00:00:00Z' },
      { id: 'z-current', text: 'common', validFrom: '2026-01-01T00:00:00Z' },
    ], 'exact')
    const bm25Context = new Context()
    contexts.push(bm25Context)
    await bm25Context.plugin(LocalKnowledge, {
      indexDir,
      ...fixedStrategy('bm25'),
      candidateCount: 1,
    })
    await expect(bm25Context.knowledge.search({
      query: 'common',
      maxResults: 1,
      asOf: '2026-06-01T00:00:00Z',
    })).resolves.toMatchObject({ hits: [{ documentId: 'z-current' }] })

    let loadCount = 0
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        loadCount += 1
        return Promise.reject(new Error('must not load'))
      }
    }
    const allFutureIndex = await versionedIndex([
      { id: 'a-future', text: 'common', validFrom: '2020-01-01T00:00:00Z' },
      { id: 'b-future', text: 'common', validFrom: '2026-01-01T00:00:00Z' },
    ], 'exact')
    const denseContext = new Context()
    contexts.push(denseContext)
    await denseContext.plugin(TestKnowledge, {
      indexDir: allFutureIndex,
      ...fixedStrategy('dense'),
      modelCacheDir: '/cache',
      candidateCount: 2,
    })
    await expect(denseContext.knowledge.search({
      query: 'common',
      maxResults: 2,
      asOf: '2010-01-01T00:00:00Z',
    })).resolves.toMatchObject({ hits: [] })
    expect(loadCount).toBe(0)
  })

  it('captures the default instant once and preserves overlapping replacement evidence', async () => {
    const indexDir = await versionedIndex([
      { id: 'policy-v1', text: 'expense policy', sourceVersion: '1', validFrom: '2025-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' },
      { id: 'policy-v2', text: 'expense policy', sourceVersion: '2', validFrom: '2026-01-01T00:00:00Z', supersedes: 'policy-v1' },
      { id: 'policy-unknown', text: 'expense policy' },
    ], 'exact')
    const context = new Context()
    contexts.push(context)
    await context.plugin(LocalKnowledge, {
      indexDir,
      ...fixedStrategy('bm25'),
      candidateCount: 3,
    })

    await expect(context.knowledge.search({
      query: 'expense policy',
      maxResults: 3,
      asOf: '2025-06-01T00:00:00Z',
    }).then(result => result.hits.map(hit => hit.documentId).sort())).resolves.toEqual([
      'policy-unknown',
      'policy-v1',
    ])
    await expect(context.knowledge.search({
      query: 'expense policy',
      maxResults: 3,
      asOf: '2026-06-01T00:00:00Z',
    }).then(result => result.hits.map(hit => hit.documentId).sort())).resolves.toEqual([
      'policy-unknown',
      'policy-v1',
      'policy-v2',
    ])

    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2028-01-01T00:00:00Z'))
    await expect(context.knowledge.search({
      query: 'expense policy',
      maxResults: 3,
    }).then(result => result.hits.map(hit => hit.documentId).sort())).resolves.toEqual([
      'policy-unknown',
      'policy-v2',
    ])
    expect(now).toHaveBeenCalledTimes(1)
  })

  it('passes only eligible candidates to the reranker', async () => {
    const indexDir = await versionedIndex([
      { id: 'a-expired', text: 'common expired', validUntil: '2026-01-01T00:00:00Z' },
      { id: 'b-current', text: 'common current', validFrom: '2026-01-01T00:00:00Z' },
    ], 'exact')
    const rerankedDocuments: string[][] = []
    class TestKnowledge extends LocalKnowledge {
      protected override createReranker(): Promise<Reranker> {
        return Promise.resolve(new Reranker({
          scorePairs(_queries, documents) {
            rerankedDocuments.push([...documents])
            return Promise.resolve({
              type: 'float32',
              dims: [documents.length],
              data: new Float32Array(documents.length),
            })
          },
          dispose: () => Promise.resolve(),
        }, 512))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir,
      ...fixedStrategy('bm25', true),
      modelCacheDir: '/cache',
      candidateCount: 2,
    })

    await expect(context.knowledge.search({
      query: 'common',
      maxResults: 2,
      asOf: '2026-06-01T00:00:00Z',
    })).resolves.toMatchObject({ hits: [{ documentId: 'b-current' }] })
    expect(rerankedDocuments).toEqual([['common current']])
  })

  it('rejects ineligible candidates returned by an internal retrieval stage', async () => {
    const context = new Context()
    contexts.push(context)
    const index = await loadKnowledgeIndex(await versionedIndex([
      { id: 'expired', text: 'common', validUntil: '2026-01-01T00:00:00Z' },
      { id: 'current', text: 'common', validFrom: '2026-01-01T00:00:00Z' },
    ], 'exact'))
    const provider = new LocalKnowledge(context, {
      indexDir: '/unused',
      ...fixedStrategy('bm25'),
      candidateCount: 2,
    })
    const internals = provider as unknown as { index: typeof index }
    internals.index = index
    vi.spyOn(internals.index.sqlite, 'searchBm25').mockReturnValue([{ ordinal: 1, score: 1 }])

    await expect(provider.search({
      query: 'common',
      maxResults: 1,
      asOf: '2026-06-01T00:00:00Z',
    })).rejects.toMatchObject({
      code: 'KNOWLEDGE_SEARCH_FAILED',
      cause: { message: 'knowledge-local: retrieval returned an ineligible document' },
    })
  })

  it('rejects an ineligible candidate introduced after reranking', async () => {
    const context = new Context()
    contexts.push(context)
    const index = await loadKnowledgeIndex(await versionedIndex([
      { id: 'expired', text: 'common', validUntil: '2026-01-01T00:00:00Z' },
      { id: 'current', text: 'common', validFrom: '2026-01-01T00:00:00Z' },
    ], 'exact'))
    const provider = new LocalKnowledge(context, {
      indexDir: '/unused',
      ...fixedStrategy('bm25', true),
      modelCacheDir: '/cache',
      candidateCount: 2,
    })
    const internals = provider as unknown as {
      index: typeof index
      rerank(query: string, matches: readonly { ordinal: number; score: number }[]): Promise<Array<{ ordinal: number; score: number }>>
    }
    internals.index = index
    internals.rerank = () => Promise.resolve([{ ordinal: 1, score: 1 }])

    await expect(provider.search({
      query: 'common',
      maxResults: 1,
      asOf: '2026-06-01T00:00:00Z',
    })).rejects.toMatchObject({
      code: 'KNOWLEDGE_SEARCH_FAILED',
      cause: { message: 'knowledge-local: retrieval returned an ineligible document' },
    })
  })

  it('expands HNSW candidates until enough eligible matches are available', async () => {
    const indexDir = await versionedIndex([
      { id: 'a-expired', text: 'common expired', validUntil: '2026-01-01T00:00:00Z' },
      { id: 'b-future', text: 'common future', validFrom: '2027-01-01T00:00:00Z' },
      { id: 'c-current', text: 'common current', validFrom: '2026-01-01T00:00:00Z' },
      { id: 'd-unknown', text: 'common unknown' },
    ], 'hnsw')
    const requested: number[] = []
    vi.spyOn(HnswIndex.prototype, 'search').mockImplementation((_query, limit) => {
      requested.push(limit)
      const matches = [
        { ordinal: 0, score: 1 },
        { ordinal: 1, score: 0.9 },
        { ordinal: 2, score: 0.8 },
      ]
      if (limit > 2) matches.push({ ordinal: 2, score: 0.7 }, { ordinal: 3, score: 0.6 })
      return matches
    })
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(0))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir,
      defaultRetrieval: 'dense',
      defaultDenseIndex: 'hnsw',
      defaultRerank: 'off',
      allowedRetrieval: ['dense'],
      allowedDenseIndexes: ['hnsw'],
      allowedRerank: false,
      modelCacheDir: '/cache',
      candidateCount: 2,
    })

    const result = await context.knowledge.search({
      query: 'common',
      maxResults: 2,
      asOf: '2026-06-01T00:00:00Z',
    })
    expect(requested).toEqual([2, 4])
    expect(result.hits.map(hit => hit.documentId)).toEqual(['c-current', 'd-unknown'])
  })

  it('rejects index and provider configuration mismatches at activation', async () => {
    for (const config of [
      {
        indexDir: join(process.cwd(), 'examples/rag-knowledge/index'),
        ...fixedStrategy('dense'),
        candidateCount: 2,
        modelCacheDir: '/cache',
      },
      {
        indexDir: await denseIndex(),
        ...fixedStrategy('dense'),
        candidateCount: 2,
        modelCacheDir: '/cache',
        denseModelId: 'different-model',
      },
    ]) {
      const context = new Context()
      contexts.push(context)
      await expect(context.plugin(LocalKnowledge, config)).rejects.toThrow()
    }
  })

  it('does not load the reranker when recall returns no candidates', async () => {
    let rerankerLoads = 0
    class TestKnowledge extends LocalKnowledge {
      protected override createReranker(): Promise<Reranker> {
        rerankerLoads += 1
        return Promise.resolve(contentReranker())
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: join(process.cwd(), 'examples/rag-knowledge/index'),
      ...fixedStrategy('bm25', true),
      modelCacheDir: '/cache',
      candidateCount: 2,
    })
    await expect(context.knowledge.search({ query: 'absent-term', maxResults: 1 })).resolves.toEqual({
      hits: [],
      strategy: { retrieval: 'bm25', rerank: false },
    })
    expect(rerankerLoads).toBe(0)
  })

  it('uses candidate ambiguity for adaptive reranking', async () => {
    let rerankerLoads = 0
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(0))
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
      ...fixedStrategy('dense', true),
      defaultRerank: 'off',
      modelCacheDir: '/cache',
      candidateCount: 2,
      adaptiveRerankMinScoreGapRatio: 0.15,
    })

    await expect(context.knowledge.search({
      query: 'clear winner',
      maxResults: 2,
      strategy: { rerank: 'auto' },
    })).resolves.toMatchObject({ strategy: { rerank: false } })
    expect(rerankerLoads).toBe(0)

    class AmbiguousKnowledge extends TestKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(2))
      }
    }
    const ambiguousContext = new Context()
    contexts.push(ambiguousContext)
    await ambiguousContext.plugin(AmbiguousKnowledge, {
      indexDir: await denseIndex(),
      ...fixedStrategy('dense', true),
      defaultRerank: 'off',
      modelCacheDir: '/cache',
      candidateCount: 2,
      adaptiveRerankMinScoreGapRatio: 0.15,
    })
    await expect(ambiguousContext.knowledge.search({
      query: 'ambiguous',
      maxResults: 2,
      strategy: { rerank: 'auto' },
    })).resolves.toMatchObject({ strategy: { rerank: true } })
    expect(rerankerLoads).toBe(1)
  })

  it('attaches de-duplicated same-document neighbors after ranking', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LocalKnowledge, {
      indexDir: await bm25Index('alpha beta gamma delta', 2, 1),
      ...fixedStrategy('bm25'),
      candidateCount: 5,
      adjacentChunkCount: 1,
    })

    const result = await context.knowledge.search({ query: 'gamma', maxResults: 1 })
    expect(result.hits).toEqual([
      expect.objectContaining({
        text: 'beta gamma',
        previousText: 'alpha',
        nextText: 'delta',
      }),
    ])
  })

  it('preserves non-overlapping neighbors and can disable expansion', async () => {
    const indexDir = await bm25Index('alpha beta gamma delta', 2, 0)
    const expanded = new Context()
    contexts.push(expanded)
    await expanded.plugin(LocalKnowledge, {
      indexDir,
      ...fixedStrategy('bm25'),
      candidateCount: 5,
      adjacentChunkCount: 1,
    })
    await expect(expanded.knowledge.search({ query: 'gamma', maxResults: 1 })).resolves.toMatchObject({
      hits: [{ text: 'gamma delta', previousText: 'alpha beta' }],
    })
    await expect(expanded.knowledge.search({ query: 'alpha', maxResults: 1 })).resolves.toMatchObject({
      hits: [{ text: 'alpha beta', nextText: 'gamma delta' }],
    })

    const disabled = new Context()
    contexts.push(disabled)
    await disabled.plugin(LocalKnowledge, {
      indexDir,
      ...fixedStrategy('bm25'),
      candidateCount: 5,
      adjacentChunkCount: 0,
    })
    await expect(disabled.knowledge.search({ query: 'gamma', maxResults: 1 })).resolves.toMatchObject({
      hits: [{ text: 'gamma delta' }],
    })
    expect((await disabled.knowledge.search({ query: 'gamma', maxResults: 1 })).hits[0])
      .not.toHaveProperty('previousText')
  })

  it('drops adjacent chunks fully duplicated by their ranked neighbor', async () => {
    const previousIndex = await bm25Index('alpha beta gamma delta', 2, 0)
    const previousDatabase = new DatabaseSync(join(previousIndex, 'knowledge.sqlite'))
    previousDatabase.exec("UPDATE chunks SET text = 'gamma delta' WHERE ordinal = 0")
    previousDatabase.close()
    const previousOverlap = new Context()
    contexts.push(previousOverlap)
    await previousOverlap.plugin(LocalKnowledge, {
      indexDir: previousIndex,
      ...fixedStrategy('bm25'),
      candidateCount: 5,
      adjacentChunkCount: 1,
    })
    const previousResult = await previousOverlap.knowledge.search({ query: 'gamma', maxResults: 1 })
    expect(previousResult.hits[0]?.previousText).toBeUndefined()

    const nextIndex = await bm25Index('alpha beta gamma delta', 2, 0)
    const nextDatabase = new DatabaseSync(join(nextIndex, 'knowledge.sqlite'))
    nextDatabase.exec("UPDATE chunks SET text = 'alpha beta' WHERE ordinal = 1")
    nextDatabase.close()
    const nextOverlap = new Context()
    contexts.push(nextOverlap)
    await nextOverlap.plugin(LocalKnowledge, {
      indexDir: nextIndex,
      ...fixedStrategy('bm25'),
      candidateCount: 5,
      adjacentChunkCount: 1,
    })
    const nextResult = await nextOverlap.knowledge.search({ query: 'alpha', maxResults: 1 })
    expect(nextResult.hits[0]?.nextText).toBeUndefined()
  })

  it('observes cancellation after a lazy Dense load', async () => {
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(0))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      ...fixedStrategy('dense'),
      modelCacheDir: '/cache',
      candidateCount: 2,
    })
    let reads = 0
    const signal = {
      get aborted() {
        reads += 1
        return reads === 3
      },
    } as AbortSignal
    await expect(context.knowledge.search({ query: 'alpha', maxResults: 1 }, signal)).rejects.toThrow('cancelled')
  })

  it('disposes a Dense encoder that finishes loading after shutdown', async () => {
    let complete: ((encoder: DenseEncoder) => void) | undefined
    let disposals = 0
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return new Promise((resolve) => { complete = resolve })
      }
    }
    const context = new Context()
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      ...fixedStrategy('dense'),
      modelCacheDir: '/cache',
      candidateCount: 2,
    })
    const search = context.knowledge.search({ query: 'alpha', maxResults: 1 })
    await Promise.resolve()
    await context.fiber.dispose()
    complete?.(new DenseEncoder({
      extract: texts => Promise.resolve({ type: 'float32', dims: [texts.length, DENSE_DIMENSIONS], data: unitRows(texts.length, 0) }),
      dispose: () => { disposals += 1; return Promise.resolve() },
    }, 512))
    await expect(search).rejects.toThrow('closed')
    expect(disposals).toBe(1)
  })

  it('disposes a reranker that finishes loading after shutdown', async () => {
    let complete: ((reranker: Reranker) => void) | undefined
    let disposals = 0
    class TestKnowledge extends LocalKnowledge {
      protected override createReranker(): Promise<Reranker> {
        return new Promise((resolve) => { complete = resolve })
      }
    }
    const context = new Context()
    await context.plugin(TestKnowledge, {
      indexDir: join(process.cwd(), 'examples/rag-knowledge/index'),
      ...fixedStrategy('bm25', true),
      modelCacheDir: '/cache',
      candidateCount: 2,
    })
    const search = context.knowledge.search({ query: 'mitochondria', maxResults: 1 })
    await Promise.resolve()
    await context.fiber.dispose()
    complete?.(new Reranker({
      scorePairs: (_queries, documents) => Promise.resolve({
        type: 'float32',
        dims: [documents.length],
        data: new Float32Array(documents.length),
      }),
      dispose: () => { disposals += 1; return Promise.resolve() },
    }, 512))
    await expect(search).rejects.toThrow('closed')
    expect(disposals).toBe(1)
  })

  it('requires an explicit cache when Dense retrieval or reranking is allowed', () => {
    expect(() => resolveConfig({ indexDir: './index' })).toThrow('modelCacheDir is required')
    expect(() => resolveConfig({ indexDir: './index', ...fixedStrategy('dense') })).toThrow('modelCacheDir is required')
    expect(() => resolveConfig({ indexDir: './index', ...fixedStrategy('bm25', true) })).toThrow('modelCacheDir is required')
    expect(resolveConfig({ indexDir: './index', ...fixedStrategy('bm25') }).modelCacheDir).toBeUndefined()
  })

  it.each([
    [{ indexDir: '   ' }, 'indexDir must be non-empty'],
    [{ indexDir: './index', allowedRetrieval: [] }, 'allowedRetrieval must contain at least one value'],
    [{ indexDir: './index', defaultRetrieval: 'dense', allowedRetrieval: ['bm25'] }, 'defaultRetrieval must be auto or included'],
    [{ indexDir: './index', adaptiveRerankMinScoreGapRatio: -0.1 }, 'adaptiveRerankMinScoreGapRatio must be from 0 through 1'],
    [{ indexDir: './index', adaptiveRerankMinScoreGapRatio: 1.1 }, 'adaptiveRerankMinScoreGapRatio must be from 0 through 1'],
    [{ indexDir: './index', adjacentChunkCount: 2 }, 'adjacentChunkCount must be 0 or 1'],
    [{ indexDir: './index', defaultRetrieval: 'dense', allowedRetrieval: ['dense'], allowedDenseIndexes: [] }, 'allowedDenseIndexes must contain at least one value'],
    [{ indexDir: './index', defaultRetrieval: 'dense', defaultDenseIndex: 'exact', allowedRetrieval: ['dense'], allowedDenseIndexes: ['hnsw'] }, 'defaultDenseIndex must be auto or included'],
    [{ indexDir: './index', defaultRerank: 'on', allowedRerank: false }, 'defaultRerank cannot be on'],
    [{ indexDir: './index', candidateCount: 0 }, 'candidateCount must be a positive safe integer'],
    [{ indexDir: './index', candidateCount: 1.5 }, 'candidateCount must be a positive safe integer'],
    [{ indexDir: './index', rerankerCandidateCount: 0 }, 'rerankerCandidateCount must be a positive safe integer'],
    [{ indexDir: './index', rrfK: 0 }, 'rrfK must be a positive safe integer'],
    [{ indexDir: './index', rrfK: 1.5 }, 'rrfK must be a positive safe integer'],
    [{ indexDir: './index', denseModelId: ' ' }, 'denseModelId must be non-empty'],
    [{ indexDir: './index', denseModelRevision: 'main' }, 'denseModelRevision must be a full lowercase commit SHA'],
    [{ indexDir: './index', denseModelFile: 'other.onnx' }, 'denseModelFile is unsupported'],
    [{ indexDir: './index', denseDimensions: 0 }, 'denseDimensions must be a positive safe integer'],
    [{ indexDir: './index', denseDimensions: 1.5 }, 'denseDimensions must be a positive safe integer'],
    [{ indexDir: './index', hnswExpansionSearch: 0 }, 'hnswExpansionSearch must be a positive safe integer'],
    [{ indexDir: './index', hnswExpansionSearch: 1.5 }, 'hnswExpansionSearch must be a positive safe integer'],
    [{ indexDir: './index', denseMaxTokens: 0 }, 'denseMaxTokens must be an integer from 1 through 8192'],
    [{ indexDir: './index', denseMaxTokens: 8193 }, 'denseMaxTokens must be an integer from 1 through 8192'],
    [{ indexDir: './index', denseMaxTokens: 1.5 }, 'denseMaxTokens must be an integer from 1 through 8192'],
    [{ indexDir: './index', rerankerModelId: ' ' }, 'rerankerModelId must be non-empty'],
    [{ indexDir: './index', rerankerModelRevision: 'main' }, 'rerankerModelRevision must be a full lowercase commit SHA'],
    [{ indexDir: './index', rerankerBatchSize: 0 }, 'rerankerBatchSize must be a positive safe integer'],
    [{ indexDir: './index', rerankerBatchSize: 1.5 }, 'rerankerBatchSize must be a positive safe integer'],
    [{ indexDir: './index', rerankerMaxTokens: 0 }, 'rerankerMaxTokens must be an integer from 1 through 512'],
    [{ indexDir: './index', rerankerMaxTokens: 513 }, 'rerankerMaxTokens must be an integer from 1 through 512'],
    [{ indexDir: './index', rerankerMaxTokens: 1.5 }, 'rerankerMaxTokens must be an integer from 1 through 512'],
  ] as const)('rejects invalid provider configuration %j', (config, message) => {
    expect(() => resolveConfig({ ...fixedStrategy('bm25'), ...config } as LocalKnowledgeConfig)).toThrow(message)
  })

  it('preserves explicit model configuration', () => {
    expect(resolveConfig({
      indexDir: './index',
      ...fixedStrategy('dense', true),
      candidateCount: 7,
      rerankerCandidateCount: 5,
      rrfK: 10,
      modelCacheDir: './cache',
      denseModelId: 'dense-model',
      denseModelRevision: 'a'.repeat(40),
      denseDtype: 'q8',
      denseMaxTokens: 256,
      rerankerModelId: 'reranker-model',
      rerankerModelRevision: 'b'.repeat(40),
      rerankerDtype: 'q8',
      rerankerBatchSize: 4,
      rerankerMaxTokens: 128,
    })).toMatchObject({
      defaultRetrieval: 'dense',
      defaultRerank: 'on',
      candidateCount: 7,
      rerankerCandidateCount: 5,
      modelCacheDir: './cache',
      denseModelId: 'dense-model',
      rerankerModelId: 'reranker-model',
    })
  })

  it('reranks only the configured leading candidates and preserves the remaining recall order', async () => {
    const scoredDocuments: string[][] = []
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(1))
      }

      protected override createReranker(): Promise<Reranker> {
        return Promise.resolve(new Reranker({
          scorePairs(_queries, documents) {
            scoredDocuments.push([...documents])
            return Promise.resolve({
              type: 'float32',
              dims: [documents.length],
              data: Float32Array.from(documents.map((_document, index) => -index)),
            })
          },
          dispose: () => Promise.resolve(),
        }, 512))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      ...fixedStrategy('hybrid', true),
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
      rerankerCandidateCount: 1,
    })

    const result = await context.knowledge.search({ query: 'alpha', maxResults: 2 })
    expect(scoredDocuments).toHaveLength(1)
    expect(scoredDocuments[0]).toHaveLength(1)
    expect(result.hits).toHaveLength(2)
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
      ...fixedStrategy('hybrid'),
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

  it('uses Hybrid Exact retrieval without reranking by default', async () => {
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(1))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
    })

    await expect(context.knowledge.search({ query: 'alpha', maxResults: 1 })).resolves.toMatchObject({
      strategy: { retrieval: 'dense', denseIndex: 'exact', rerank: false },
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
      ...fixedStrategy(mode, rerank),
      ...(mode === 'bm25' && !rerank ? {} : { modelCacheDir: '/unused-test-cache' }),
      candidateCount: 2,
    })

    const result = await context.knowledge.search({ query: 'alpha', maxResults: 2 })
    expect(result.hits.map(hit => hit.documentId)).toEqual(expected)
    expect(result.strategy).toEqual({
      retrieval: mode,
      ...(mode === 'bm25' ? {} : { denseIndex: 'exact' }),
      rerank,
    })
    expect(rerankerLoads).toBe(rerank ? 1 : 0)
  })

  it('applies request strategy within the configured allowed set', async () => {
    class TestKnowledge extends LocalKnowledge {
      protected override createDenseEncoder(): Promise<DenseEncoder> {
        return Promise.resolve(queryEncoder(1))
      }
    }
    const context = new Context()
    contexts.push(context)
    await context.plugin(TestKnowledge, {
      indexDir: await denseIndex(),
      defaultRetrieval: 'hybrid',
      defaultDenseIndex: 'auto',
      defaultRerank: 'off',
      allowedRetrieval: ['bm25', 'dense', 'hybrid'],
      allowedDenseIndexes: ['exact'],
      allowedRerank: false,
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
    })

    await expect(context.knowledge.search({
      query: 'alpha',
      maxResults: 1,
      strategy: { retrieval: 'dense', denseIndex: 'exact', rerank: 'off' },
    })).resolves.toMatchObject({
      strategy: { retrieval: 'dense', denseIndex: 'exact', rerank: false },
      hits: [{ documentId: 'doc-b' }],
    })
    await expect(context.knowledge.search({
      query: 'alpha',
      maxResults: 1,
      strategy: { retrieval: 'bm25', rerank: 'on' },
    })).rejects.toMatchObject({ code: 'KNOWLEDGE_STRATEGY_NOT_ALLOWED' })
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
      ...fixedStrategy('bm25', true),
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
      ...fixedStrategy('bm25', true),
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
      ...fixedStrategy('hybrid', true),
      modelCacheDir: '/unused-test-cache',
      candidateCount: 2,
    })
    const provider = context.knowledge
    await provider.search({ query: 'alpha', maxResults: 1 })
    await provider.search({ query: 'alpha', maxResults: 1 })
    await context.fiber.dispose()

    expect(denseDisposals).toBe(1)
    expect(rerankerDisposals).toBe(1)
    await expect(provider.search({ query: 'alpha', maxResults: 1 })).rejects.toThrow('closed')
  })
})
