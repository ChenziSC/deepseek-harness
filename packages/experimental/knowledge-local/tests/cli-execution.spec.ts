import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildKnowledgeIndex: vi.fn(),
  buildT2RankingBenchmarkSlices: vi.fn(),
  deriveKnowledgeIndexFromExact: vi.fn(),
  evaluateDataset: vi.fn(),
  renderEvaluationReport: vi.fn(() => '# report\n'),
  loadDenseEncoder: vi.fn(),
  prepareSciFact: vi.fn(),
  prepareMldr: vi.fn(),
  prepareMlqaEngZho: vi.fn(),
  prepareT2Ranking: vi.fn(),
  verifyKnowledgeIndex: vi.fn(),
  loadKnowledgeIndex: vi.fn(),
  loadBgeChunkTokenizer: vi.fn(),
  encoderDispose: vi.fn(() => Promise.resolve()),
}))

vi.mock('../src/index-builder.ts', () => ({
  DEFAULT_EXACT_SCAN_MAX_ELEMENTS: 50_000_000,
  buildKnowledgeIndex: mocks.buildKnowledgeIndex,
  deriveKnowledgeIndexFromExact: mocks.deriveKnowledgeIndexFromExact,
}))
vi.mock('../src/index-format.ts', () => ({
  loadKnowledgeIndex: mocks.loadKnowledgeIndex,
  verifyKnowledgeIndex: mocks.verifyKnowledgeIndex,
}))
vi.mock('../src/evaluation.ts', () => ({
  evaluateDataset: mocks.evaluateDataset,
  renderEvaluationReport: mocks.renderEvaluationReport,
}))
vi.mock('../src/model-runtime.ts', () => ({
  BGE_DENSE_DTYPE: 'q8',
  BGE_DENSE_MODEL_FILE: 'onnx/model_quantized.onnx',
  BGE_QUERY_PREFIX: '',
  DEFAULT_DENSE_MAX_TOKENS: 512,
  loadDenseEncoder: mocks.loadDenseEncoder,
}))
vi.mock('../src/prepare.ts', () => ({
  prepareMldr: mocks.prepareMldr,
  prepareMlqaEngZho: mocks.prepareMlqaEngZho,
  prepareSciFact: mocks.prepareSciFact,
  prepareT2Ranking: mocks.prepareT2Ranking,
}))
vi.mock('../src/tokenizer.ts', () => ({
  BGE_M3_MODEL_ID: 'dense-default',
  BGE_M3_REVISION: 'a'.repeat(40),
  loadBgeChunkTokenizer: mocks.loadBgeChunkTokenizer,
}))
vi.mock('../src/t2ranking-benchmark.ts', () => ({
  DEFAULT_T2RANKING_CHUNK_TARGETS: [10_000, 25_000, 50_000, 100_000],
  buildT2RankingBenchmarkSlices: mocks.buildT2RankingBenchmarkSlices,
}))

import { runCli } from '../src/cli.ts'

const temporaryDirectories: string[] = []

function sink(): { output: string; write: (chunk: string | Uint8Array) => boolean } {
  const target = {
    output: '',
    write(chunk: string | Uint8Array): boolean {
      target.output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    },
  }
  return target
}

function manifest() {
  return {
    formatVersion: 2 as const,
    createdBy: { package: '@deepseek-ai/dsh-experimental-knowledge-local' as const, version: 'test' },
    build: { durationMs: 1 },
    corpus: { sha256: 'a'.repeat(64), documentCount: 1, chunkCount: 1 },
    chunking: { tokenizerModelId: 'model', tokenizerRevision: 'revision', maxTokens: 8, overlapTokens: 0 },
    bm25: { analyzer: 'english-v1' as const, implementation: 'sqlite-fts5' as const },
    payloads: [{ path: 'knowledge.sqlite', bytes: 10, sha256: 'b'.repeat(64) }],
  }
}

function report(failed = false) {
  return {
    schemaVersion: 2 as const,
    createdAt: '2026-09-04T00:00:00.000Z',
    dataset: 'scifact' as const,
    platform: { os: 'test', release: 'test', arch: 'test', node: 'test' },
    corpusSha256: 'a'.repeat(64),
    indexFingerprint: 'b'.repeat(64),
    inputs: { queriesSha256: 'e'.repeat(64), qrelsSha256: 'f'.repeat(64) },
    models: {
      dense: { modelId: 'dense', revision: 'c'.repeat(40), dtype: 'q8' as const },
      reranker: { modelId: 'reranker', revision: 'd'.repeat(40), dtype: 'q8' as const },
    },
    config: {
      candidateCount: 50 as const,
      rerankerCandidateCount: 20 as const,
      maxResults: 20,
      warmupQueries: 0,
      modes: ['bm25', 'dense', 'hybrid'] as const,
      denseIndexes: ['exact'] as const,
      rerankValues: ['off', 'auto', 'on'] as const,
      adaptiveRerankMinScoreGapRatio: 0.15,
      bm25Implementation: 'sqlite-fts5' as const,
      rrfK: 60 as const,
      chunkMaxTokens: 8,
      chunkOverlapTokens: 0,
      denseMaxTokens: 512,
      hnswExpansionSearch: 1024,
      rerankerBatchSize: 8,
      rerankerMaxTokens: 512,
      hybridExecution: 'sequential' as const,
    },
    runs: failed
      ? [{ mode: 'dense' as const, rerank: 'on' as const, status: 'failed' as const, queryCount: 1, error: 'failed' }]
      : [{ mode: 'bm25' as const, rerank: 'off' as const, status: 'success' as const, queryCount: 1 }],
    build: { durationMs: 1, indexBytes: 10, payloadBytes: { 'knowledge.sqlite': 10 } },
  }
}

beforeEach(() => {
  mocks.buildKnowledgeIndex.mockResolvedValue(manifest())
  mocks.deriveKnowledgeIndexFromExact.mockResolvedValue(manifest())
  mocks.buildT2RankingBenchmarkSlices.mockResolvedValue({ queryCount: 100, slices: [] })
  mocks.evaluateDataset.mockImplementation(async (options: {
    onQueryDetail?: (detail: unknown) => void | Promise<void>
  }) => {
    await options.onQueryDetail?.({
      schemaVersion: 1,
      queryId: 'q',
      queryText: 'query',
      requestedStrategy: { retrieval: 'bm25', rerank: 'off' },
      relevantDocuments: [{ documentId: 'doc', relevance: 1 }],
      status: 'success',
      latencyMs: 1,
      resolvedStrategy: { retrieval: 'bm25', rerank: false },
      rankedDocuments: [{ documentId: 'doc', score: 1 }],
    })
    return report()
  })
  mocks.prepareSciFact.mockResolvedValue({ datasetDir: '/data/scifact', archiveMd5: 'md5', archiveSha256: 'sha', models: [] })
  mocks.prepareMldr.mockResolvedValue({ dataset: 'mldr-en', datasetDir: '/data/mldr-en', files: [] })
  mocks.prepareMlqaEngZho.mockResolvedValue({ dataset: 'mlqa-eng-zho', datasetDir: '/data/mlqa-eng-zho', files: [] })
  mocks.prepareT2Ranking.mockResolvedValue({ dataset: 't2ranking', datasetDir: '/data/t2ranking', files: [] })
  mocks.verifyKnowledgeIndex.mockResolvedValue(manifest())
  mocks.loadKnowledgeIndex.mockResolvedValue({
    manifest: manifest(),
    sqlite: { close: vi.fn() },
  })
  mocks.loadBgeChunkTokenizer.mockResolvedValue({ countTokens: () => 1 })
  mocks.loadDenseEncoder.mockResolvedValue({ embedDocuments: vi.fn(), dispose: mocks.encoderDispose })
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  vi.clearAllMocks()
})

async function fixtureFile(name: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-cli-'))
  temporaryDirectories.push(root)
  const path = join(root, name)
  await writeFile(path, content)
  return path
}

describe('dsh-knowledge command execution', () => {
  it.each([[[]], [['--help']], [['-h']]])('prints help for %j', async (argv) => {
    const stdout = sink()
    expect(await runCli(argv, stdout, sink())).toBe(0)
    expect(stdout.output).toContain('Usage: dsh-knowledge')
  })

  it('runs BM25 and Dense index builds without loading an unused encoder', async () => {
    const corpus = await fixtureFile('corpus.jsonl', '{"id":"doc","text":"body"}\n')
    const root = join(corpus, '..')
    const stdout = sink()
    expect(await runCli([
      'index', '--corpus', corpus, '--output', join(root, 'bm25'), '--model-cache-dir', '/models',
    ], stdout, sink())).toBe(0)
    expect(mocks.buildKnowledgeIndex.mock.calls[0]?.[0]).not.toHaveProperty('dense')
    expect(JSON.parse(stdout.output)).toMatchObject({ documentCount: 1, chunkCount: 1, payloadBytes: 10 })

    mocks.buildKnowledgeIndex.mockImplementationOnce(async (options: {
      dense?: { onVectorBuildStats?: (stats: unknown) => void }
    }) => {
      options.dense?.onVectorBuildStats?.({
        totalInputCount: 1,
        cacheHitCount: 1,
        encodedInputCount: 0,
        reuseRatio: 1,
        importedVectorCount: 1,
        timingsMs: {
          import: 1,
          cacheLookup: 1,
          embedding: 0,
          cacheWrite: 0,
          exactWrite: 1,
          hnswAdd: 0,
          hnswSave: 0,
        },
      })
      return manifest()
    })
    const denseStdout = sink()
    expect(await runCli([
      'index', '--corpus', corpus, '--corpus-format', 'scifact', '--output', join(root, 'dense'),
      '--model-cache-dir', '/models', '--components', 'bm25,dense', '--max-tokens', '8',
      '--overlap-tokens', '0', '--chunking-strategy', 'token-window-v1', '--sqlite-batch-size', '2',
      '--dense-model-id', 'dense-model', '--dense-model-revision', 'b'.repeat(40),
      '--dense-max-tokens', '64', '--embedding-batch-size', '4',
      '--vector-cache-dir', '/vectors', '--import-vectors-from', '/source-index',
    ], denseStdout, sink())).toBe(0)
    expect(mocks.buildKnowledgeIndex.mock.calls[1]?.[0]).toMatchObject({
      corpusFormat: 'scifact',
      corpusPath: corpus,
      chunking: { maxTokens: 8, overlapTokens: 0, strategy: 'token-window-v1' },
      sqliteBatchSize: 2,
      dense: {
        batchSize: 4,
        modelId: 'dense-model',
        revision: 'b'.repeat(40),
        dtype: 'q8',
        vectorCacheDir: '/vectors',
        importVectorsFrom: '/source-index',
      },
    })
    expect(JSON.parse(denseStdout.output)).toMatchObject({
      denseBuild: {
        cacheHitCount: 1,
        encodedInputCount: 0,
        reuseRatio: 1,
        importedVectorCount: 1,
        timingsMs: { modelLoad: 0 },
      },
    })
    expect(mocks.loadDenseEncoder).not.toHaveBeenCalled()

    mocks.buildKnowledgeIndex.mockRejectedValueOnce(new Error('build failed'))
    const stderr = sink()
    expect(await runCli([
      'index', '--corpus', corpus, '--output', join(root, 'failed'), '--model-cache-dir', '/models',
      '--components', 'bm25,dense',
    ], sink(), stderr)).toBe(2)
    expect(stderr.output).toContain('build failed')
    expect(mocks.encoderDispose).not.toHaveBeenCalled()
  })

  it('emits an interactive build plan and accepts a dual-payload override', async () => {
    const corpus = await fixtureFile('corpus.jsonl', '{"id":"doc","text":"body"}\n')
    const stdout = Object.assign(sink(), { isTTY: true })
    const stderr = sink()
    const stdin = Object.assign(Readable.from(['b\n']), { isTTY: true })
    mocks.buildKnowledgeIndex.mockImplementationOnce(async (options: {
      dense?: { selectIndex?: (plan: Record<string, unknown>) => Promise<string> }
    }) => {
      const selected = await options.dense?.selectIndex?.({
        documentCount: 1,
        chunkCount: 2,
        dimensions: 1024,
        scanElements: 2048,
        exactScanMaxElements: 50_000_000,
        requestedIndex: 'auto',
        recommendedIndex: 'exact',
        estimatedExactBytes: 8192,
        estimatedHnswBytes: 8448,
        estimatedBothBytes: 16_640,
      })
      expect(selected).toBe('both')
      return {
        ...manifest(),
        dense: {
          modelId: 'dense-default',
          revision: 'a'.repeat(40),
          dtype: 'q8' as const,
          modelFile: 'onnx/model_quantized.onnx' as const,
          pooling: 'cls' as const,
          normalized: true as const,
          dimensions: 1024,
          maxTokens: 512,
          queryPrefix: '',
          vectorCount: 2,
          scanElements: 2048,
          exactScanMaxElements: 50_000_000,
          requestedIndex: 'auto' as const,
          recommendedIndex: 'exact' as const,
          resolvedIndex: 'both' as const,
          autoDenseIndex: 'exact' as const,
        },
      }
    })

    expect(await runCli([
      'index', '--corpus', corpus, '--output', `${corpus}.index`, '--model-cache-dir', '/models',
      '--components', 'bm25,dense',
    ], stdout, stderr, stdin)).toBe(0)
    const lines = stdout.output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({ event: 'dense-index-plan', recommendedIndex: 'exact' })
    expect(lines[1]).toMatchObject({ denseIndex: 'both', recommendedDenseIndex: 'exact' })
    expect(stderr.output).toContain('Choose [Enter=exact')
    expect(mocks.loadDenseEncoder).not.toHaveBeenCalled()
  })

  it.each([
    ['\n', 'exact'],
    ['e\n', 'exact'],
    ['exact\n', 'exact'],
    ['h\n', 'hnsw'],
    ['hnsw\n', 'hnsw'],
    ['both\n', 'both'],
  ])('accepts interactive Dense choice %j', async (answer, expected) => {
    const corpus = await fixtureFile('corpus.jsonl', '{"id":"doc","text":"body"}\n')
    const stdout = Object.assign(sink(), { isTTY: true })
    const stdin = Object.assign(Readable.from([answer]), { isTTY: true })
    mocks.buildKnowledgeIndex.mockImplementationOnce(async (options: {
      dense?: { selectIndex?: (plan: Record<string, unknown>) => Promise<string> }
    }) => {
      const selected = await options.dense?.selectIndex?.({
        documentCount: 1,
        chunkCount: 1,
        dimensions: 1024,
        scanElements: 1024,
        exactScanMaxElements: 50_000_000,
        requestedIndex: 'auto',
        recommendedIndex: 'exact',
        estimatedExactBytes: 4096,
        estimatedHnswBytes: 4224,
        estimatedBothBytes: 8320,
      })
      expect(selected).toBe(expected)
      return manifest()
    })

    expect(await runCli([
      'index', '--corpus', corpus, '--output', `${corpus}.index`, '--model-cache-dir', '/models',
      '--components', 'bm25,dense',
    ], stdout, sink(), stdin)).toBe(0)
  })

  it.each([
    ['c\n', 'cancelled'],
    ['cancel\n', 'cancelled'],
    ['unknown\n', 'must be exact, hnsw, both, or cancel'],
    [undefined, 'cancelled'],
  ])('rejects interactive Dense choice %j', async (answer, message) => {
    const corpus = await fixtureFile('corpus.jsonl', '{"id":"doc","text":"body"}\n')
    const stdout = Object.assign(sink(), { isTTY: true })
    const stdin = Object.assign(answer === undefined ? Readable.from([]) : Readable.from([answer]), { isTTY: true })
    mocks.buildKnowledgeIndex.mockImplementationOnce(async (options: {
      dense?: { selectIndex?: (plan: Record<string, unknown>) => Promise<string> }
    }) => {
      await options.dense?.selectIndex?.({
        documentCount: 1,
        chunkCount: 1,
        dimensions: 1024,
        scanElements: 1024,
        exactScanMaxElements: 50_000_000,
        requestedIndex: 'auto',
        recommendedIndex: 'exact',
        estimatedExactBytes: 4096,
        estimatedHnswBytes: 4224,
        estimatedBothBytes: 8320,
      })
      return manifest()
    })
    const stderr = sink()

    expect(await runCli([
      'index', '--corpus', corpus, '--output', `${corpus}.index`, '--model-cache-dir', '/models',
      '--components', 'bm25,dense',
    ], stdout, stderr, stdin)).toBe(2)
    expect(stderr.output).toContain(message)
  })

  it('loads the Dense encoder only when embedding starts and reuses it for later batches', async () => {
    const corpus = await fixtureFile('corpus.jsonl', '{"id":"doc","text":"body"}\n')
    mocks.buildKnowledgeIndex.mockImplementationOnce(async (options: {
      dense?: { encoder: { embedDocuments(texts: readonly string[]): Promise<unknown> } }
    }) => {
      await options.dense?.encoder.embedDocuments(['first'])
      await options.dense?.encoder.embedDocuments(['second'])
      return manifest()
    })

    expect(await runCli([
      'index', '--corpus', corpus, '--output', `${corpus}.index`, '--model-cache-dir', '/models',
      '--components', 'bm25,dense',
    ], sink(), sink())).toBe(0)
    expect(mocks.loadDenseEncoder).toHaveBeenCalledTimes(1)
    expect(mocks.encoderDispose).toHaveBeenCalledTimes(1)
  })

  it.each([
    [['index', '--components', 'other'], '--components must be bm25 or bm25,dense'],
    [['index', '--corpus-format', 'other'], '--corpus-format must be generic, scifact, mldr, or t2ranking'],
    [['index', '--analyzer', 'other'], '--analyzer must be english-v1 or mixed-zh-en-v1'],
    [['index', '--chunking-strategy', 'other'], '--chunking-strategy must be token-window-v1 or markdown-structure-v1'],
    [['index', '--dense-index', 'other'], '--dense-index must be auto, exact, hnsw, or both'],
    [['index', '--corpus', 'x', '--output', 'y'], '--model-cache-dir is required'],
    [['index', '--corpus', 'x', '--output', 'y', '--model-cache-dir', 'm', '--components', 'bm25,dense', '--dense-model-id='], '--dense-model-id is required'],
    [['index', '--corpus', 'x', '--output', 'y', '--model-cache-dir', 'm', '--components', 'bm25,dense', '--dense-model-revision='], '--dense-model-revision is required'],
    [['index', '--corpus', 'x', '--output', 'y', '--model-cache-dir', 'm', '--vector-cache-dir', 'v'], '--vector-cache-dir and --import-vectors-from require --components bm25,dense'],
    [['index', '--corpus', 'x', '--output', 'y', '--model-cache-dir', 'm', '--components', 'bm25,dense', '--import-vectors-from', 'i'], '--import-vectors-from requires --vector-cache-dir'],
  ])('rejects invalid index arguments %j', async (argv, message) => {
    const stderr = sink()
    expect(await runCli(argv, sink(), stderr)).toBe(2)
    expect(stderr.output).toContain(message)
  })

  it('rejects non-numeric index options after reading the corpus', async () => {
    const corpus = await fixtureFile('corpus.jsonl', '{"id":"doc","text":"body"}\n')
    const stderr = sink()
    expect(await runCli([
      'index', '--corpus', corpus, '--output', `${corpus}.index`, '--model-cache-dir', '/models',
      '--max-tokens', 'NaN',
    ], sink(), stderr)).toBe(2)
    expect(stderr.output).toContain('--max-tokens must be a finite number')
  })

  it('runs SciFact preparation', async () => {
    const stdout = sink()
    expect(await runCli([
      'prepare', 'scifact', '--data-dir', '/data', '--model-cache-dir', '/models',
    ], stdout, sink())).toBe(0)
    expect(mocks.prepareSciFact).toHaveBeenCalledWith('/data', '/models')
    expect(JSON.parse(stdout.output)).toMatchObject({ datasetDir: '/data/scifact' })
  })

  it('prepares MLDR and T2Ranking from an explicit Hugging Face endpoint', async () => {
    expect(await runCli([
      'prepare', 'mldr', '--language', 'en', '--data-dir', '/data', '--hf-endpoint', 'https://mirror.example',
    ], sink(), sink())).toBe(0)
    expect(mocks.prepareMldr).toHaveBeenCalledWith('/data', 'en', 'https://mirror.example')

    expect(await runCli([
      'prepare', 't2ranking', '--data-dir', '/data', '--hf-endpoint', 'https://mirror.example',
    ], sink(), sink())).toBe(0)
    expect(mocks.prepareT2Ranking).toHaveBeenCalledWith('/data', 'https://mirror.example')

    expect(await runCli([
      'prepare', 'mlqa-eng-zho', '--data-dir', '/data', '--hf-endpoint', 'https://mirror.example',
    ], sink(), sink())).toBe(0)
    expect(mocks.prepareMlqaEngZho).toHaveBeenCalledWith('/data', 'https://mirror.example')
  })

  it('builds deterministic T2Ranking threshold slices', async () => {
    const stdout = sink()
    expect(await runCli([
      'slice', '--collection', '/data/collection.tsv', '--queries', '/data/queries.tsv',
      '--qrels', '/data/qrels.tsv', '--bm25-run', '/data/dev.bm25.tsv', '--output', '/slices',
      '--model-cache-dir', '/models', '--query-limit', '20', '--chunk-targets', '100,200',
    ], stdout, sink())).toBe(0)
    expect(mocks.buildT2RankingBenchmarkSlices).toHaveBeenCalledWith(expect.objectContaining({
      collectionPath: '/data/collection.tsv',
      queriesPath: '/data/queries.tsv',
      qrelsPath: '/data/qrels.tsv',
      bm25Path: '/data/dev.bm25.tsv',
      outputDir: '/slices',
      queryLimit: 20,
      chunkTargets: [100, 200],
    }))
    expect(JSON.parse(stdout.output)).toEqual({ queryCount: 100, slices: [] })
  })

  it('derives a prefix index without loading the Dense encoder', async () => {
    const sourceManifest = {
      ...manifest(),
      chunking: {
        tokenizerModelId: 'dense-model',
        tokenizerRevision: 'b'.repeat(40),
        maxTokens: 384,
        overlapTokens: 64,
        strategy: 'markdown-structure-v1' as const,
      },
    }
    mocks.loadKnowledgeIndex.mockResolvedValueOnce({ manifest: sourceManifest, sqlite: { close: vi.fn() } })
    mocks.deriveKnowledgeIndexFromExact.mockResolvedValueOnce({
      ...sourceManifest,
      dense: { resolvedIndex: 'both', recommendedIndex: 'exact' },
    })
    const stdout = sink()
    expect(await runCli([
      'derive', '--source-index', '/index-100k', '--corpus', '/slices/chunks-10000/corpus.tsv',
      '--output', '/index-10k', '--model-cache-dir', '/models', '--dense-index', 'both',
    ], stdout, sink())).toBe(0)
    expect(mocks.deriveKnowledgeIndexFromExact).toHaveBeenCalledWith(expect.objectContaining({
      sourceIndexDir: '/index-100k',
      corpusPath: '/slices/chunks-10000/corpus.tsv',
      corpusFormat: 't2ranking',
      outputDir: '/index-10k',
      chunking: { maxTokens: 384, overlapTokens: 64, strategy: 'markdown-structure-v1' },
      denseIndex: 'both',
    }))
    expect(mocks.loadDenseEncoder).not.toHaveBeenCalled()
    expect(JSON.parse(stdout.output)).toMatchObject({ denseIndex: 'both', recommendedDenseIndex: 'exact' })
  })

  it('passes explicit prefix-index format and HNSW options', async () => {
    const sourceManifest = {
      ...manifest(),
      chunking: {
        tokenizerModelId: 'dense-model',
        tokenizerRevision: 'b'.repeat(40),
        maxTokens: 384,
        overlapTokens: 64,
        strategy: 'markdown-structure-v1' as const,
      },
    }
    mocks.loadKnowledgeIndex.mockResolvedValueOnce({ manifest: sourceManifest, sqlite: { close: vi.fn() } })
    mocks.deriveKnowledgeIndexFromExact.mockResolvedValueOnce({
      ...sourceManifest,
      dense: { resolvedIndex: 'hnsw', recommendedIndex: 'hnsw' },
    })

    expect(await runCli([
      'derive', '--source-index', '/index-100k', '--corpus', '/slices/chunks-50000/corpus.tsv',
      '--corpus-format', 'generic', '--output', '/index-50k', '--model-cache-dir', '/models',
      '--dense-index', 'hnsw', '--exact-scan-max-elements', '1', '--connectivity', '2',
      '--expansion-add', '3',
    ], sink(), sink())).toBe(0)
    expect(mocks.deriveKnowledgeIndexFromExact).toHaveBeenCalledWith(expect.objectContaining({
      corpusFormat: 'generic',
      denseIndex: 'hnsw',
      exactScanMaxElements: 1,
      connectivity: 2,
      expansionAdd: 3,
    }))
  })

  it.each([
    [[
      'slice', '--collection', '/collection', '--queries', '/queries', '--qrels', '/qrels',
      '--bm25-run', '/bm25', '--output', '/output', '--model-cache-dir', '/models', '--chunk-targets', '1,NaN',
    ], '--chunk-targets must be a comma-separated list of positive integers'],
    [['derive', '--dense-index', 'auto'], '--dense-index must be exact, hnsw, or both'],
    [['derive', '--corpus-format', 'other'], '--corpus-format must be generic, scifact, mldr, or t2ranking'],
  ])('rejects invalid threshold-calibration arguments %j', async (argv, message) => {
    const stderr = sink()
    expect(await runCli(argv, sink(), stderr)).toBe(2)
    expect(stderr.output).toContain(message)
  })

  it('requires a supported dataset and MLDR language for preparation', async () => {
    const stderr = sink()
    expect(await runCli([
      'prepare', 'other', '--data-dir', '/data', '--model-cache-dir', '/models',
    ], sink(), stderr)).toBe(2)
    expect(stderr.output).toContain('prepare dataset must be scifact, mldr, t2ranking, or mlqa-eng-zho')
    const languageError = sink()
    expect(await runCli(['prepare', 'mldr', '--data-dir', '/data'], sink(), languageError)).toBe(2)
    expect(languageError.output).toContain('prepare mldr requires --language en or zh')
  })

  it('writes successful and failed evaluation reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-cli-report-'))
    temporaryDirectories.push(root)
    const stdout = sink()
    const args = [
      'evaluate', '--index', '/index', '--queries', '/queries', '--qrels', '/qrels',
      '--model-cache-dir', '/models', '--output', join(root, 'report'), '--max-results', '20', '--warmup-queries', '0',
    ]
    expect(await runCli(args, stdout, sink())).toBe(0)
    expect(await readFile(join(root, 'report', 'report.md'), 'utf8')).toBe('# report\n')
    expect(JSON.parse(await readFile(join(root, 'report', 'queries.jsonl'), 'utf8'))).toMatchObject({
      queryId: 'q',
      status: 'success',
    })
    expect(JSON.parse(stdout.output)).toMatchObject({
      queries: join(root, 'report', 'queries.jsonl'),
      failedRuns: 0,
    })
    expect(mocks.evaluateDataset).toHaveBeenCalledWith(expect.objectContaining({
      candidateCount: 50,
      rerankerCandidateCount: 20,
      adaptiveRerankMinScoreGapRatio: 0.15,
      modes: ['bm25', 'dense', 'hybrid'],
      rerankValues: ['off', 'auto', 'on'],
      hnswExpansionSearch: 1024,
    }))
    const evaluationOptions = mocks.evaluateDataset.mock.calls[0]?.[0] as { readonly onQueryDetail?: unknown }
    expect(typeof evaluationOptions.onQueryDetail).toBe('function')

    const selectedOutput = join(root, 'selected-report')
    expect(await runCli([
      ...args.slice(0, -6), '--output', selectedOutput, '--dataset', 'mlqa', '--query-limit', '3',
      '--modes', 'auto,dense', '--dense-indexes', 'exact,hnsw', '--rerank', 'off',
      '--adaptive-rerank-min-score-gap-ratio', '0.02',
    ], sink(), sink())).toBe(0)
    expect(mocks.evaluateDataset).toHaveBeenLastCalledWith(expect.objectContaining({
      dataset: 'mlqa',
      queryLimit: 3,
      modes: ['auto', 'dense'],
      denseIndexes: ['exact', 'hnsw'],
      rerankValues: ['off'],
      adaptiveRerankMinScoreGapRatio: 0.02,
    }))

    mocks.evaluateDataset.mockResolvedValueOnce(report(true))
    const failedOutput = join(root, 'failed-report')
    expect(await runCli([...args.slice(0, -6), '--output', failedOutput], sink(), sink())).toBe(2)
  })

  it('verifies all index payload hashes', async () => {
    const stdout = sink()
    expect(await runCli(['verify', '--index', '/index'], stdout, sink())).toBe(0)
    expect(mocks.verifyKnowledgeIndex).toHaveBeenCalledWith('/index')
    expect(JSON.parse(stdout.output)).toEqual({
      index: '/index',
      payloads: [{ path: 'knowledge.sqlite', bytes: 10, sha256: 'b'.repeat(64) }],
    })
  })

  it('rejects occupied and invalid report destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-cli-report-'))
    temporaryDirectories.push(root)
    const occupied = join(root, 'occupied')
    await mkdir(occupied)
    await writeFile(join(occupied, 'existing'), 'x')
    const base = ['evaluate', '--index', '/index', '--queries', '/queries', '--qrels', '/qrels', '--model-cache-dir', '/models']
    const occupiedError = sink()
    expect(await runCli([...base, '--output', occupied], sink(), occupiedError)).toBe(2)
    expect(occupiedError.output).toContain('report output directory is not empty')

    const file = join(root, 'file')
    await writeFile(file, 'x')
    expect(await runCli([...base, '--output', file], sink(), sink())).toBe(2)

    const datasetError = sink()
    expect(await runCli([...base, '--output', join(root, 'invalid-dataset'), '--dataset', 'other'], sink(), datasetError)).toBe(2)
    expect(datasetError.output).toContain('--dataset must be scifact, mldr, t2ranking, or mlqa')

    const modesError = sink()
    expect(await runCli([...base, '--output', join(root, 'invalid-modes'), '--modes', ''], sink(), modesError)).toBe(2)
    expect(modesError.output).toContain('--modes must be a comma-separated subset')
  })

  it('reports unknown commands and non-Error failures', async () => {
    const unknown = sink()
    expect(await runCli(['unknown'], sink(), unknown)).toBe(2)
    expect(unknown.output).toContain('unknown command')

    mocks.prepareSciFact.mockRejectedValueOnce('plain failure')
    const stderr = sink()
    expect(await runCli(['prepare', 'scifact', '--data-dir', '/data', '--model-cache-dir', '/models'], sink(), stderr)).toBe(2)
    expect(stderr.output).toContain('plain failure')

    const missingDataset = sink()
    expect(await runCli(['prepare', '--data-dir', '/data'], sink(), missingDataset)).toBe(2)
    expect(missingDataset.output).toContain('prepare requires one dataset name')
  })
})
