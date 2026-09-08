import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

const transformerMocks = vi.hoisted(() => {
  const featureTokenizer = vi.fn(() => ({}))
  const featureExtractor = Object.assign(vi.fn((texts: string[]) => {
    const vectors = new Float32Array(texts.length * DENSE_DIMENSIONS)
    for (const [row, text] of texts.entries()) vectors[row * DENSE_DIMENSIONS + (text.includes('beta') ? 1 : 0)] = 1
    return Promise.resolve({ type: 'float32', dims: [texts.length, DENSE_DIMENSIONS], data: vectors })
  }), { tokenizer: featureTokenizer, dispose: vi.fn(() => Promise.resolve()) })
  const rerankerTokenizer = Object.assign(vi.fn((_queries: string[], options: { text_pair: string[] }) => ({
    documents: options.text_pair,
  })), { padding_side: 'left' })
  const rerankerModel = Object.assign(vi.fn((inputs: { documents: string[] }) => Promise.resolve({
    logits: {
      type: 'float32',
      dims: [inputs.documents.length, 1],
      data: Float32Array.from(inputs.documents.map(document => document.includes('alpha') ? 1 : 0)),
    },
  })), { dispose: vi.fn(() => Promise.resolve()) })
  return {
    featureExtractor,
    rerankerTokenizer,
    rerankerModel,
    pipeline: vi.fn(() => Promise.resolve(featureExtractor)),
    tokenizerFromPretrained: vi.fn(() => Promise.resolve(rerankerTokenizer)),
    modelFromPretrained: vi.fn(() => Promise.resolve(rerankerModel)),
  }
})

vi.mock('@huggingface/transformers', () => ({
  pipeline: transformerMocks.pipeline,
  AutoTokenizer: { from_pretrained: transformerMocks.tokenizerFromPretrained },
  AutoModelForSequenceClassification: { from_pretrained: transformerMocks.modelFromPretrained },
}))
import {
  calculateMetrics,
  buildBm25KnowledgeIndex,
  buildKnowledgeIndex,
  BGE_M3_MODEL_ID,
  BGE_M3_REVISION,
  DENSE_DIMENSIONS,
  evaluateDataset,
  evaluateMatrix,
  nearestRank,
  renderEvaluationReport,
  type EvaluationReport,
  type EvaluationQueryDetail,
} from '@deepseek-ai/dsh-experimental-knowledge-local'
import { KnowledgeChunkId, KnowledgeDocumentId } from '@deepseek-ai/dsh-experimental-knowledge'

const queries = [
  {
    id: 'q1',
    text: 'first query',
    relevantDocuments: [
      { documentId: KnowledgeDocumentId('a'), relevance: 2 },
      { documentId: KnowledgeDocumentId('b'), relevance: 1 },
    ],
  },
  {
    id: 'q2',
    text: 'second query',
    relevantDocuments: [{ documentId: KnowledgeDocumentId('c'), relevance: 1 }],
  },
] as const

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('SciFact evaluation', () => {
  it('distinguishes Recall from Success and calculates graded ranking metrics', () => {
    const metrics = calculateMetrics([
      { query: queries[0], documentIds: ['b', 'x', 'a'] },
      { query: queries[1], documentIds: ['x', 'c'] },
    ])

    expect(metrics.recallAt1).toBe(0.25)
    expect(metrics.recallAt5).toBe(1)
    expect(metrics.successAt1).toBe(0.5)
    expect(metrics.mrrAt10).toBe(0.75)
    const firstNdcg = (1 + 3 / Math.log2(4)) / (3 + 1 / Math.log2(3))
    const secondNdcg = 1 / Math.log2(3)
    expect(metrics.ndcgAt10).toBeCloseTo((firstNdcg + secondNdcg) / 2)
  })

  it('uses nearest-rank percentiles', () => {
    expect(nearestRank([5, 1, 4, 2, 3], 0.5)).toBe(3)
    expect(nearestRank([5, 1, 4, 2, 3], 0.95)).toBe(5)
    expect(() => nearestRank([], 0.5)).toThrow('percentile requires at least one value')
  })

  it('rejects an empty metric set and scores absent judgments as zero', () => {
    expect(() => calculateMetrics([])).toThrow('evaluation requires at least one query')
    const metrics = calculateMetrics([{
      query: { id: 'q', text: 'query', relevantDocuments: [] },
      documentIds: ['missing'],
    }])
    expect(metrics.mrrAt10).toBe(0)
    expect(metrics.ndcgAt10).toBe(0)
    expect(metrics.successAt20).toBe(0)
  })

  it('runs all nine configurations and isolates one failed combination', async () => {
    const created: string[] = []
    const runs = await evaluateMatrix(queries, 20, 1, (mode, rerank) => {
      created.push(`${mode}:${rerank}`)
      if (mode === 'dense' && rerank === 'on') return Promise.reject(new Error('fixture failure'))
      return Promise.resolve({
        search(query: string) {
          const documentId = query === 'first query' ? 'a' : 'c'
          const retrieval = mode === 'auto' ? 'hybrid' : mode
          return Promise.resolve({
            strategy: {
              retrieval,
              ...(retrieval === 'bm25' ? {} : { denseIndex: 'exact' as const }),
              rerank: rerank === 'on' || (rerank === 'auto' && query === 'first query'),
            },
            hits: [{
              documentId: KnowledgeDocumentId(documentId),
              chunkId: KnowledgeChunkId(`${documentId}:0-1`),
              text: 'fixture',
              score: 1,
            }],
          })
        },
        dispose: () => Promise.resolve(),
      })
    })

    expect(created).toEqual([
      'bm25:off',
      'bm25:auto',
      'bm25:on',
      'dense:off',
      'dense:auto',
      'dense:on',
      'hybrid:off',
      'hybrid:auto',
      'hybrid:on',
    ])
    expect(runs).toHaveLength(9)
    expect(runs.find(run => run.mode === 'dense' && run.rerank === 'on')).toMatchObject({
      status: 'failed',
      error: 'fixture failure',
    })
    expect(runs.filter(run => run.status === 'success')).toHaveLength(8)
    expect(runs.find(run => run.mode === 'bm25' && run.rerank === 'auto')).toMatchObject({
      rerankAppliedRate: 0.5,
      resolvedRetrievalCounts: { bm25: 2, dense: 0, hybrid: 0 },
    })

    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- covers normalization of external rejections.
    const nonErrorRuns = await evaluateMatrix([], 20, 1, () => Promise.reject('string failure'))
    expect(nonErrorRuns.every(run => run.error === 'string failure')).toBe(true)

    const emptyRuns = await evaluateMatrix([], 20, 1, () => Promise.resolve({
      search: () => Promise.resolve({ hits: [], strategy: { retrieval: 'bm25', rerank: false } }),
      dispose: () => Promise.resolve(),
    }))
    expect(emptyRuns.every(run => run.error?.includes('at least one query'))).toBe(true)

    const foldedDetails: EvaluationQueryDetail[] = []
    const foldedRuns = await evaluateMatrix([queries[0]], 2, 0, () => Promise.resolve({
      search: () => Promise.resolve({
        strategy: { retrieval: 'bm25', rerank: false },
        hits: [
          { documentId: KnowledgeDocumentId('a'), chunkId: KnowledgeChunkId('a:0'), text: 'a1', score: 3 },
          { documentId: KnowledgeDocumentId('a'), chunkId: KnowledgeChunkId('a:1'), text: 'a2', score: 2 },
          { documentId: KnowledgeDocumentId('b'), chunkId: KnowledgeChunkId('b:0'), text: 'b', score: 1 },
        ],
      }),
      dispose: () => Promise.resolve(),
    }), ['exact'], ['bm25'], ['off'], (detail) => {
      foldedDetails.push(detail)
    })
    expect(foldedRuns[0]?.metrics?.recallAt5).toBe(1)
    expect(foldedDetails).toHaveLength(1)
    expect(foldedDetails[0]).toMatchObject({
      schemaVersion: 1,
      queryId: 'q1',
      queryText: 'first query',
      requestedStrategy: { retrieval: 'bm25', rerank: 'off' },
      relevantDocuments: [
        { documentId: 'a', relevance: 2 },
        { documentId: 'b', relevance: 1 },
      ],
      status: 'success',
      resolvedStrategy: { retrieval: 'bm25', rerank: false },
      recallTopScoreGapRatio: 1 / 3,
      rankedDocuments: [
        { documentId: 'a', score: 3 },
        { documentId: 'b', score: 1 },
      ],
      metrics: { recallAt1: 0.5, recallAt5: 1 },
    })

    const failedDetails: EvaluationQueryDetail[] = []
    const queryFailure = await evaluateMatrix([queries[0]], 20, 0, () => Promise.resolve({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- covers normalization of provider rejections.
      search: () => Promise.reject('query failure'),
      dispose: () => Promise.resolve(),
    }), ['exact'], ['bm25'], ['off'], (detail) => {
      failedDetails.push(detail)
    })
    expect(queryFailure[0]).toMatchObject({ status: 'failed', error: 'query failure' })
    expect(failedDetails[0]).toMatchObject({
      schemaVersion: 1,
      queryId: 'q1',
      queryText: 'first query',
      status: 'failed',
      error: 'query failure',
    })

    const errorFailure = await evaluateMatrix([queries[0]], 20, 0, () => Promise.resolve({
      search: () => Promise.reject(new Error('query error')),
      dispose: () => Promise.resolve(),
    }), ['exact'], ['bm25'], ['off'], () => undefined)
    expect(errorFailure[0]).toMatchObject({ status: 'failed', error: 'query error' })

    const approximateRuns = await evaluateMatrix([queries[0]], 20, 0, (_mode, _rerank, denseIndex) => Promise.resolve({
      search: () => Promise.resolve({
        strategy: { retrieval: 'dense', denseIndex, rerank: false },
        hits: (denseIndex === 'exact' ? ['a', 'b'] : ['a', 'x']).map((documentId, index) => ({
          documentId: KnowledgeDocumentId(documentId),
          chunkId: KnowledgeChunkId(`${documentId}:0`),
          text: documentId,
          score: 2 - index,
        })),
      }),
      dispose: () => Promise.resolve(),
    }), ['exact', 'hnsw'], ['dense'], ['off'])
    expect(approximateRuns[1]?.approximation).toEqual({ recallAt10: 0.5, recallAt100: 0.5 })

    const reversedApproximateRuns = await evaluateMatrix([queries[0]], 20, 0, (_mode, _rerank, denseIndex) => Promise.resolve({
      search: () => Promise.resolve({
        strategy: { retrieval: 'dense', denseIndex, rerank: false },
        hits: (denseIndex === 'exact' ? ['a', 'b'] : ['a', 'x']).map((documentId, index) => ({
          documentId: KnowledgeDocumentId(documentId),
          chunkId: KnowledgeChunkId(`${documentId}:0`),
          text: documentId,
          score: 2 - index,
        })),
      }),
      dispose: () => Promise.resolve(),
    }), ['hnsw', 'exact'], ['dense'], ['off'])
    expect(reversedApproximateRuns[0]?.approximation).toEqual({ recallAt10: 0.5, recallAt100: 0.5 })

    const emptyApproximation = await evaluateMatrix([queries[0]], 20, 0, () => Promise.resolve({
      search: () => Promise.resolve({
        strategy: { retrieval: 'dense', denseIndex: 'exact', rerank: false },
        hits: [],
      }),
      dispose: () => Promise.resolve(),
    }), ['exact', 'hnsw'], ['dense'], ['off'])
    expect(emptyApproximation[1]?.approximation).toEqual({ recallAt10: 1, recallAt100: 1 })
  })

  it('loads a complete local experiment and measures nested index bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evaluation-'))
    temporaryDirectories.push(root)
    const indexDir = join(root, 'index')
    const encoder = {
      embedDocuments(texts: readonly string[]): Promise<Float32Array> {
        const vectors = new Float32Array(texts.length * DENSE_DIMENSIONS)
        for (const [row, text] of texts.entries()) vectors[row * DENSE_DIMENSIONS + (text.includes('beta') ? 1 : 0)] = 1
        return Promise.resolve(vectors)
      },
    }
    await buildKnowledgeIndex({
      corpusText: [
        '{"id":"doc-a","text":"alpha one. alpha two."}',
        '{"id":"doc-b","text":"beta"}',
      ].join('\n'),
      outputDir: indexDir,
      tokenizer: { countTokens: text => text.match(/\S+/gu)?.length ?? 0 },
      chunking: { maxTokens: 8, overlapTokens: 0 },
      dense: {
        encoder,
        batchSize: 2,
        modelId: BGE_M3_MODEL_ID,
        revision: BGE_M3_REVISION,
        dtype: 'q8',
      },
    })
    const nested = join(indexDir, 'extra')
    await mkdir(nested)
    await writeFile(join(nested, 'bytes.bin'), 'extra')
    const queriesPath = join(root, 'queries.jsonl')
    const qrelsPath = join(root, 'qrels.tsv')
    await writeFile(queriesPath, [
      '{"_id":"q-1","text":"alpha"}',
      '{"_id":"q-2","text":"ABC_DEF"}',
    ].join('\n'))
    await writeFile(qrelsPath, [
      'query-id\tcorpus-id\tscore',
      'q-1\tdoc-a\t1',
      'q-2\tdoc-a\t1',
    ].join('\n'))

    const details: EvaluationQueryDetail[] = []
    const report = await evaluateDataset({
      indexDir,
      queriesPath,
      qrelsPath,
      modelCacheDir: '/cache',
      maxResults: 20,
      warmupQueries: 1,
      modes: ['auto', 'bm25', 'dense', 'hybrid'],
      onQueryDetail: (detail) => {
        details.push(detail)
      },
    })
    expect(report.runs).toHaveLength(12)
    expect(report.runs.every(run => run.status === 'success')).toBe(true)
    expect(report.inputs.queriesSha256).toHaveLength(64)
    expect(report.inputs.qrelsSha256).toHaveLength(64)
    expect(report.runs.find(run => run.mode === 'auto' && run.rerank === 'off')).toMatchObject({
      resolvedRetrievalCounts: { bm25: 1, dense: 1, hybrid: 0 },
    })
    expect(details).toHaveLength(24)
    expect(details.find(detail => detail.requestedStrategy.retrieval === 'auto')).toMatchObject({
      resolvedStrategy: { retrieval: 'dense' },
    })
    expect(report.build.indexBytes).toBeGreaterThan(5)

    await writeFile(qrelsPath, 'query-id\tcorpus-id\tscore\n')
    await expect(evaluateDataset({
      indexDir,
      queriesPath,
      qrelsPath,
      modelCacheDir: '/cache',
      maxResults: 20,
      warmupQueries: 0,
    })).rejects.toThrow('qrels contain no evaluation queries')
    await writeFile(qrelsPath, [
      'query-id\tcorpus-id\tscore',
      'q-1\tdoc-a\t1',
      'q-2\tdoc-a\t1',
    ].join('\n'))

  })

  it('validates complete evaluation inputs', async () => {
    await expect(evaluateDataset({
      indexDir: '/unused',
      queriesPath: '/unused',
      qrelsPath: '/unused',
      modelCacheDir: '/unused',
      maxResults: 19,
      warmupQueries: 0,
    })).rejects.toThrow('maxResults must be an integer from 20 through 100')
    await expect(evaluateDataset({
      indexDir: '/unused',
      queriesPath: '/unused',
      qrelsPath: '/unused',
      modelCacheDir: '/unused',
      maxResults: 20,
      candidateCount: 19,
      warmupQueries: 0,
    })).rejects.toThrow('candidateCount must be a safe integer no smaller than maxResults')
    await expect(evaluateDataset({
      indexDir: '/unused',
      queriesPath: '/unused',
      qrelsPath: '/unused',
      modelCacheDir: '/unused',
      maxResults: 20,
      rerankerCandidateCount: 0,
      warmupQueries: 0,
    })).rejects.toThrow('rerankerCandidateCount must be a positive safe integer')
    for (const adaptiveRerankMinScoreGapRatio of [Number.NaN, -0.1, 1.1]) {
      await expect(evaluateDataset({
        indexDir: '/unused',
        queriesPath: '/unused',
        qrelsPath: '/unused',
        modelCacheDir: '/unused',
        maxResults: 20,
        warmupQueries: 0,
        adaptiveRerankMinScoreGapRatio,
      })).rejects.toThrow('adaptiveRerankMinScoreGapRatio must be from 0 through 1')
    }
    await expect(evaluateDataset({
      indexDir: '/unused',
      queriesPath: '/unused',
      qrelsPath: '/unused',
      modelCacheDir: '/unused',
      maxResults: 20,
      warmupQueries: -1,
    })).rejects.toThrow('warmupQueries must be a non-negative safe integer')
    for (const queryLimit of [0, 1.5]) {
      await expect(evaluateDataset({
        indexDir: '/unused',
        queriesPath: '/unused',
        qrelsPath: '/unused',
        modelCacheDir: '/unused',
        maxResults: 20,
        warmupQueries: 0,
        queryLimit,
      })).rejects.toThrow('queryLimit must be a positive safe integer')
    }
    for (const hnswExpansionSearch of [0, 1.5]) {
      await expect(evaluateDataset({
        indexDir: '/unused',
        queriesPath: '/unused',
        qrelsPath: '/unused',
        modelCacheDir: '/unused',
        maxResults: 20,
        warmupQueries: 0,
        hnswExpansionSearch,
      })).rejects.toThrow('hnswExpansionSearch must be a positive safe integer')
    }
    await expect(evaluateDataset({
      indexDir: '/unused',
      queriesPath: '/unused',
      qrelsPath: '/unused',
      modelCacheDir: '/unused',
      maxResults: 20,
      warmupQueries: 0,
      modes: [],
    })).rejects.toThrow('modes must not be empty')
    await expect(evaluateDataset({
      indexDir: '/unused',
      queriesPath: '/unused',
      qrelsPath: '/unused',
      modelCacheDir: '/unused',
      maxResults: 20,
      warmupQueries: 0,
      modes: ['dense'],
      denseIndexes: [],
    })).rejects.toThrow('denseIndexes must not be empty')
    await expect(evaluateDataset({
      indexDir: '/unused',
      queriesPath: '/unused',
      qrelsPath: '/unused',
      modelCacheDir: '/unused',
      maxResults: 20,
      warmupQueries: 0,
      rerankValues: [],
    })).rejects.toThrow('rerankValues must not be empty')

    const root = await mkdtemp(join(tmpdir(), 'dsh-evaluation-invalid-'))
    temporaryDirectories.push(root)
    const indexDir = join(root, 'index')
    await buildBm25KnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: indexDir,
      tokenizer: { countTokens: text => text.match(/\S+/gu)?.length ?? 0 },
      chunking: { maxTokens: 8, overlapTokens: 0 },
    })
    const queriesPath = join(root, 'queries.jsonl')
    const qrelsPath = join(root, 'qrels.tsv')
    await writeFile(queriesPath, '{"_id":"q","text":"alpha"}\n')
    await writeFile(qrelsPath, 'query-id\tcorpus-id\tscore\nq\tdoc\t1\n')
    const bm25Only = await evaluateDataset({
      indexDir,
      queriesPath,
      qrelsPath,
      modelCacheDir: '/cache',
      maxResults: 20,
      warmupQueries: 0,
      modes: ['bm25'],
      denseIndexes: [],
      rerankValues: ['off'],
    })
    expect(bm25Only.models).toEqual({})
    expect(bm25Only.runs).toHaveLength(1)
    expect(bm25Only.runs[0]?.status).toBe('success')
    await expect(evaluateDataset({
      indexDir,
      queriesPath,
      qrelsPath,
      modelCacheDir: '/cache',
      maxResults: 20,
      warmupQueries: 0,
      modes: ['dense'],
    })).rejects.toThrow('evaluation index must contain Dense embeddings')
  })

  it.each([
    {
      dataset: 'mlqa' as const,
      queriesName: 'queries.jsonl',
      queries: '{"_id":"q","text":"alpha"}\n',
      qrels: 'query-id\tcorpus-id\tscore\nq\tdoc\t1\n',
    },
    {
      dataset: 'mldr' as const,
      queriesName: 'queries.jsonl.gz',
      queries: '{"query_id":"q","query":"alpha","positive_passages":[],"negative_passages":[]}\n',
      qrels: 'q Q0 doc 1\n',
    },
    {
      dataset: 't2ranking' as const,
      queriesName: 'queries.tsv',
      queries: 'qid\ttext\nq\talpha\n',
      qrels: 'qid\tpid\nq\tdoc\n',
    },
  ])('loads and evaluates the $dataset adapter', async ({ dataset, queriesName, queries, qrels }) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-evaluation-${dataset}-`))
    temporaryDirectories.push(root)
    const indexDir = join(root, 'index')
    await buildBm25KnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: indexDir,
      tokenizer: { countTokens: text => text.match(/\S+/gu)?.length ?? 0 },
      chunking: { maxTokens: 8, overlapTokens: 0 },
    })
    const queriesPath = join(root, queriesName)
    await writeFile(queriesPath, queriesName.endsWith('.gz') ? gzipSync(queries) : queries)
    const qrelsPath = join(root, 'qrels.tsv')
    await writeFile(qrelsPath, qrels)
    const report = await evaluateDataset({
      indexDir,
      queriesPath,
      qrelsPath,
      modelCacheDir: '/cache',
      maxResults: 20,
      warmupQueries: 0,
      dataset,
      queryLimit: 1,
      modes: ['bm25'],
      denseIndexes: [],
      rerankValues: ['off'],
    })
    expect(report.dataset).toBe(dataset)
    expect(report.config.queryLimit).toBe(1)
    expect(report.runs[0]?.status).toBe('success')
  })

  it('uses a present HNSW payload by default and records provider activation failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evaluation-hnsw-'))
    temporaryDirectories.push(root)
    const indexDir = join(root, 'index')
    await buildKnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: indexDir,
      tokenizer: { countTokens: text => text.match(/\S+/gu)?.length ?? 0 },
      chunking: { maxTokens: 8, overlapTokens: 0 },
      dense: {
        encoder: {
          embedDocuments: () => {
            const vector = new Float32Array(DENSE_DIMENSIONS)
            vector[0] = 1
            return Promise.resolve(vector)
          },
        },
        batchSize: 1,
        modelId: BGE_M3_MODEL_ID,
        revision: BGE_M3_REVISION,
        dtype: 'q8',
        denseIndex: 'hnsw',
      },
    })
    const queriesPath = join(root, 'queries.jsonl')
    const qrelsPath = join(root, 'qrels.tsv')
    await writeFile(queriesPath, '{"_id":"q","text":"alpha"}\n')
    await writeFile(qrelsPath, 'query-id\tcorpus-id\tscore\nq\tdoc\t1\n')
    const hnsw = await evaluateDataset({
      indexDir,
      queriesPath,
      qrelsPath,
      modelCacheDir: '/cache',
      maxResults: 20,
      warmupQueries: 0,
      modes: ['dense'],
      rerankValues: ['off'],
    })
    expect(hnsw.config.denseIndexes).toEqual(['hnsw'])
    expect(hnsw.runs).toHaveLength(1)

    const failed = await evaluateDataset({
      indexDir,
      queriesPath,
      qrelsPath,
      modelCacheDir: '',
      maxResults: 20,
      warmupQueries: 0,
      modes: ['bm25'],
      denseIndexes: [],
      rerankValues: ['on'],
    })
    expect(failed.runs[0]?.status).toBe('failed')
    expect(failed.runs[0]?.error).toContain('modelCacheDir')
  })

  it('renders Markdown only from report fields', () => {
    const report: EvaluationReport = {
      schemaVersion: 2,
      createdAt: '2026-09-03T00:00:00.000Z',
      dataset: 'scifact',
      platform: { os: 'test', release: 'test', arch: 'test', node: 'test' },
      corpusSha256: 'a'.repeat(64),
      indexFingerprint: 'b'.repeat(64),
      inputs: { queriesSha256: 'e'.repeat(64), qrelsSha256: 'f'.repeat(64) },
      models: {
        dense: { modelId: 'dense', revision: 'c'.repeat(40), dtype: 'q8' },
        reranker: { modelId: 'reranker', revision: 'd'.repeat(40), dtype: 'q8' },
      },
      config: {
        candidateCount: 50,
        rerankerCandidateCount: 20,
        maxResults: 20,
        warmupQueries: 10,
        modes: ['bm25', 'dense', 'hybrid'],
        denseIndexes: ['exact'],
        rerankValues: ['off', 'auto', 'on'],
        adaptiveRerankMinScoreGapRatio: 0.15,
        bm25Implementation: 'sqlite-fts5',
        rrfK: 60,
        chunkMaxTokens: 384,
        chunkOverlapTokens: 64,
        denseMaxTokens: 512,
        hnswExpansionSearch: 512,
        rerankerBatchSize: 8,
        rerankerMaxTokens: 512,
        hybridExecution: 'sequential',
      },
      runs: [{
        mode: 'bm25',
        rerank: 'off',
        status: 'success',
        queryCount: 2,
        metrics: {
          recallAt1: 0.5,
          recallAt5: 1,
          recallAt10: 1,
          recallAt20: 1,
          recallAt100: 1,
          mrrAt10: 0.75,
          ndcgAt10: 0.8,
          successAt1: 0.5,
          successAt5: 1,
          successAt10: 1,
          successAt20: 1,
          successAt100: 1,
        },
        latencyMs: { p50: 1.25, p95: 2.5 },
      }],
      build: { durationMs: 5, indexBytes: 100, payloadBytes: { 'knowledge.sqlite': 80, 'dense.f32le': 20 } },
    }

    const markdown = renderEvaluationReport(report)
    expect(markdown).toContain('| bm25 | — | off | 0.00% | success | 50.00% | 100.00%')
    expect(markdown).toContain('Index bytes: 100')
    expect(markdown).toContain('- dense.f32le: 20')

    const approximate = renderEvaluationReport({
      ...report,
      runs: [{
        ...(report.runs[0] as NonNullable<EvaluationReport['runs'][number]>),
        denseIndex: 'hnsw',
        approximation: { recallAt10: 0.9, recallAt100: 0.8 },
      }],
    })
    expect(approximate).toContain('| 90.00% | 80.00% |')

    const failed = renderEvaluationReport({
      ...report,
      runs: [
        { mode: 'dense', rerank: 'on', status: 'failed', queryCount: 2, error: 'bad | model\nresult' },
        { mode: 'hybrid', rerank: 'off', status: 'success', queryCount: 2 },
      ],
    })
    expect(failed).toContain('failed: bad \\| model result')
    expect(failed).toContain('failed: unknown error')
  })
})
