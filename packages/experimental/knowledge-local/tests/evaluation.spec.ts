import { describe, expect, it } from 'vitest'
import {
  calculateMetrics,
  evaluateMatrix,
  nearestRank,
  renderEvaluationReport,
  type EvaluationReport,
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
  })

  it('runs all six configurations and isolates one failed combination', async () => {
    const created: string[] = []
    const runs = await evaluateMatrix(queries, 20, 1, (mode, rerank) => {
      created.push(`${mode}:${String(rerank)}`)
      if (mode === 'dense' && rerank) return Promise.reject(new Error('fixture failure'))
      return Promise.resolve({
        search(query: string) {
          const documentId = query === 'first query' ? 'a' : 'c'
          return Promise.resolve({
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
      'bm25:false',
      'bm25:true',
      'dense:false',
      'dense:true',
      'hybrid:false',
      'hybrid:true',
    ])
    expect(runs).toHaveLength(6)
    expect(runs.find(run => run.mode === 'dense' && run.rerank)).toMatchObject({
      status: 'failed',
      error: 'fixture failure',
    })
    expect(runs.filter(run => run.status === 'success')).toHaveLength(5)
  })

  it('renders Markdown only from report fields', () => {
    const report: EvaluationReport = {
      schemaVersion: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
      platform: { os: 'test', release: 'test', arch: 'test', node: 'test' },
      corpusSha256: 'a'.repeat(64),
      indexFingerprint: 'b'.repeat(64),
      models: {
        dense: { modelId: 'dense', revision: 'c'.repeat(40), dtype: 'q8' },
        reranker: { modelId: 'reranker', revision: 'd'.repeat(40), dtype: 'q8' },
      },
      config: {
        candidateCount: 50,
        maxResults: 20,
        warmupQueries: 10,
        bm25K1: 1.2,
        bm25B: 0.75,
        rrfK: 60,
        chunkMaxTokens: 384,
        chunkOverlapTokens: 64,
        denseMaxTokens: 512,
        rerankerBatchSize: 8,
        rerankerMaxTokens: 512,
        hybridExecution: 'sequential',
      },
      runs: [{
        mode: 'bm25',
        rerank: false,
        status: 'success',
        queryCount: 2,
        metrics: {
          recallAt1: 0.5,
          recallAt5: 1,
          recallAt10: 1,
          recallAt20: 1,
          mrrAt10: 0.75,
          ndcgAt10: 0.8,
          successAt1: 0.5,
          successAt5: 1,
          successAt10: 1,
          successAt20: 1,
        },
        latencyMs: { p50: 1.25, p95: 2.5 },
      }],
      build: { durationMs: 5, indexBytes: 100 },
    }

    const markdown = renderEvaluationReport(report)
    expect(markdown).toContain('| bm25 | false | success | 50.00% | 100.00%')
    expect(markdown).toContain('Index bytes: 100')
  })
})
