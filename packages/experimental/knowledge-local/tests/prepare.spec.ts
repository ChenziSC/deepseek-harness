import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  md5: '5f7d1de60b170fc8027bb7898e2efca1',
  denseDispose: vi.fn(() => Promise.resolve()),
  rerankerDispose: vi.fn(() => Promise.resolve()),
  loadDenseEncoder: vi.fn(),
  loadReranker: vi.fn(),
  parquetRows: [] as unknown[][],
  asyncBufferFromFile: vi.fn((path: string) => Promise.resolve({ path })),
  parquetReadObjects: vi.fn(() => Promise.resolve(mocks.parquetRows.shift() ?? [])),
}))

vi.mock('node:crypto', () => ({
  createHash: (algorithm: string) => {
    const hash = {
      update: () => hash,
      digest: () => algorithm === 'md5' ? mocks.md5 : 'a'.repeat(64),
    }
    return hash
  },
}))

vi.mock('../src/model-runtime.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/model-runtime.ts')>(),
  loadDenseEncoder: mocks.loadDenseEncoder,
}))

vi.mock('../src/reranker.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/reranker.ts')>(),
  loadReranker: mocks.loadReranker,
}))

vi.mock('hyparquet', () => ({
  asyncBufferFromFile: mocks.asyncBufferFromFile,
  parquetReadObjects: mocks.parquetReadObjects,
}))
import {
  extractSciFactArchive,
  convertMlqaRetrievalRows,
  downloadDatasetFile,
  prepareMldr,
  prepareMlqaEngZho,
  prepareSciFact,
  prepareT2Ranking,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  mocks.parquetRows.splice(0)
  mocks.md5 = '5f7d1de60b170fc8027bb7898e2efca1'
})

describe('SciFact preparation', () => {
  it('extracts expected files and rejects traversal paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-scifact-'))
    temporaryDirectories.push(directory)
    await extractSciFactArchive(zipSync({
      'scifact/': new Uint8Array(),
      'scifact/corpus.jsonl': new TextEncoder().encode('{"_id":"1","text":"body"}\n'),
      'scifact/qrels/test.tsv': new TextEncoder().encode('query-id\tcorpus-id\tscore\n'),
    }), directory)
    await expect(readFile(join(directory, 'scifact/corpus.jsonl'), 'utf8'))
      .resolves.toBe('{"_id":"1","text":"body"}\n')

    await expect(extractSciFactArchive(zipSync({
      '../escape.txt': new Uint8Array([1]),
    }), directory)).rejects.toThrow('unsafe SciFact archive path')

    for (const entry of ['\\escape.txt', '/escape.txt', 'C:/escape.txt', './escape.txt', '']) {
      await expect(extractSciFactArchive(zipSync({ [entry]: new Uint8Array([1]) }), directory))
        .rejects.toThrow('unsafe SciFact archive path')
    }
  })

  it('rejects an archive checksum mismatch before preparing models', async () => {
    mocks.md5 = 'mismatch'
    const prepareDenseModel = vi.fn(() => Promise.resolve())
    const prepareRerankerModel = vi.fn(() => Promise.resolve())
    await expect(prepareSciFact('/unused-data', '/unused-models', {
      download: () => Promise.resolve(new Uint8Array([1, 2, 3])),
      prepareDenseModel,
      prepareRerankerModel,
    })).rejects.toThrow('MD5 mismatch')
    expect(prepareDenseModel).not.toHaveBeenCalled()
    expect(prepareRerankerModel).not.toHaveBeenCalled()
  })

  it('downloads, verifies, extracts, and prepares both default models', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-scifact-'))
    temporaryDirectories.push(directory)
    const archive = zipSync({
      'scifact/corpus.jsonl': new TextEncoder().encode('{"_id":"1","text":"body"}\n'),
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(archive.buffer.slice(
        archive.byteOffset,
        archive.byteOffset + archive.byteLength,
      )),
    })))
    mocks.loadDenseEncoder.mockResolvedValue({ dispose: mocks.denseDispose })
    mocks.loadReranker.mockResolvedValue({ dispose: mocks.rerankerDispose })

    const result = await prepareSciFact(directory, '/models')
    expect(result.archiveMd5).toBe('5f7d1de60b170fc8027bb7898e2efca1')
    expect(result.archiveSha256).toBe('a'.repeat(64))
    expect(result.models).toHaveLength(2)
    expect(mocks.loadDenseEncoder).toHaveBeenCalledWith({ cacheDir: '/models', localFilesOnly: false })
    expect(mocks.loadReranker).toHaveBeenCalledWith({ cacheDir: '/models', localFilesOnly: false })
    expect(mocks.denseDispose).toHaveBeenCalled()
    expect(mocks.rerankerDispose).toHaveBeenCalled()
  })

  it('reports failed downloads and invalid destinations', async () => {
    await expect(prepareSciFact(' ', '/models')).rejects.toThrow('dataDir must be non-empty')
    await expect(prepareSciFact('/data', ' ')).rejects.toThrow('modelCacheDir must be non-empty')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 503,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    })))
    await expect(prepareSciFact('/data', '/models')).rejects.toThrow('download failed with HTTP 503')
  })
})

describe('large benchmark preparation', () => {
  it('streams downloads and removes partial files after reader failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-download-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'success.bin')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('fixture'))))
    await expect(downloadDatasetFile('https://example.test/file', path)).resolves.toEqual({
      bytes: 7,
      sha256: 'a'.repeat(64),
    })
    await expect(readFile(path, 'utf8')).resolves.toBe('fixture')

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, body: null })))
    await expect(downloadDatasetFile('https://example.test/fail', join(directory, 'failed.bin')))
      .rejects.toThrow('download failed with HTTP 503')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, body: null })))
    await expect(downloadDatasetFile('https://example.test/empty', join(directory, 'empty.bin')))
      .rejects.toThrow('download failed with HTTP 200')

    const partial = join(directory, 'partial.bin')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => ({
        read: async () => {
          await unlink(partial)
          throw new Error('stream failed')
        },
      }) },
    })))
    await expect(downloadDatasetFile('https://example.test/partial', partial)).rejects.toThrow('stream failed')
    await expect(readFile(partial)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records fixed MLDR source files and digests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mldr-'))
    temporaryDirectories.push(directory)
    const download = vi.fn(async (_url: string, path: string) => {
      await writeFile(path, 'fixture')
      return { bytes: 7, sha256: 'e'.repeat(64) }
    })

    const result = await prepareMldr(directory, 'zh', 'https://mirror.example', download)
    expect(result).toMatchObject({
      dataset: 'mldr-zh',
      revision: 'd67138e705d963e346253a80e59676ddb418810a',
      license: 'MIT',
    })
    expect(result.files.map(file => file.path)).toEqual(['corpus.jsonl.gz', 'queries.jsonl.gz', 'qrels.tsv'])
    expect(result.files[0]?.url).toContain('/datasets/Shitao/MLDR/resolve/')
    expect(JSON.parse(await readFile(join(result.datasetDir, 'source.json'), 'utf8'))).toEqual(result)
  })

  it('records T2Ranking files and rejects a non-empty target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-t2ranking-'))
    temporaryDirectories.push(directory)
    const download = vi.fn(async (_url: string, path: string) => {
      await writeFile(path, 'fixture')
      return { bytes: 7, sha256: 'f'.repeat(64) }
    })

    const result = await prepareT2Ranking(directory, 'https://mirror.example/', download)
    expect(result).toMatchObject({ dataset: 't2ranking', license: 'Apache-2.0' })
    expect(result.files.map(file => file.path)).toEqual([
      'collection.tsv',
      'queries.dev.tsv',
      'qrels.retrieval.dev.tsv',
    ])
    expect(result.files[0]?.url).not.toContain('//datasets')
    await expect(prepareT2Ranking(directory, 'https://mirror.example', download))
      .rejects.toThrow('dataset directory is not empty')
  })

  it('uses the default endpoint and streaming downloader for MLDR and T2Ranking', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('fixture'))))
    const mldrRoot = await mkdtemp(join(tmpdir(), 'dsh-mldr-default-'))
    const t2Root = await mkdtemp(join(tmpdir(), 'dsh-t2-default-'))
    temporaryDirectories.push(mldrRoot, t2Root)
    const mldr = await prepareMldr(mldrRoot, 'en')
    const t2 = await prepareT2Ranking(t2Root)
    expect(mldr.files).toHaveLength(3)
    expect(t2.files).toHaveLength(3)
    expect(mldr.files[0]?.url).toMatch(/^https:\/\/huggingface\.co\//u)
    expect(t2.files[0]?.url).toMatch(/^https:\/\/huggingface\.co\//u)
  })

  it('rejects blank dataset roots, endpoints, and non-directory parents', async () => {
    const download = vi.fn(() => Promise.resolve({ bytes: 0, sha256: 'a'.repeat(64) }))
    await expect(prepareMldr(' ', 'en', 'https://example.test', download)).rejects.toThrow('dataDir must be non-empty')
    await expect(prepareT2Ranking('/data', ' ', download)).rejects.toThrow('endpoint must be non-empty')
    const root = await mkdtemp(join(tmpdir(), 'dsh-invalid-parent-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'file')
    await writeFile(parent, 'not a directory')
    await expect(prepareT2Ranking(parent, 'https://example.test', download)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('converts MLQA Retrieval English corpus and Chinese queries with qrels validation', () => {
    const converted = convertMlqaRetrievalRows(
      [{ id: 'C1', title: '', text: 'English evidence' }],
      [{ id: 'Q1', text: '中文问题' }],
      [{ 'query-id': 'Q1', 'corpus-id': 'C1', score: 1n }],
    )
    expect(converted.corpusText).toBe('{"id":"C1","text":"English evidence"}\n')
    expect(converted.queriesText).toBe('{"_id":"Q1","text":"中文问题"}\n')
    expect(converted.qrelsText).toBe('query-id\tcorpus-id\tscore\nQ1\tC1\t1\n')

    expect(() => convertMlqaRetrievalRows(
      [{ id: 'C1', title: '', text: 'English evidence' }],
      [{ id: 'Q1', text: '中文问题' }],
      [{ 'query-id': 'Q1', 'corpus-id': 'missing', score: 1n }],
    )).toThrow('unknown document id "missing"')
  })

  it('validates every MLQA parquet field and preserves non-empty titles', () => {
    const validCorpus = [{ id: 'C1', title: 'Title', text: 'English evidence' }]
    const validQueries = [{ id: 'Q1', text: '中文问题' }]
    const validQrels = [{ 'query-id': 'Q1', 'corpus-id': 'C1', score: 1 }]
    expect(convertMlqaRetrievalRows(validCorpus, validQueries, validQrels).corpusText)
      .toBe('{"id":"C1","text":"English evidence","title":"Title"}\n')
    for (const [corpus, queries, qrels, message] of [
      [[null], validQueries, validQrels, 'MLQA corpus[0] row must be an object'],
      [[{ id: '', title: '', text: 'body' }], validQueries, validQrels, 'MLQA corpus[0].id must be a non-empty string'],
      [[{ id: 'C1', title: '', text: 1 }], validQueries, validQrels, 'MLQA corpus[0].text must be a non-empty string'],
      [[{ id: 'C1', title: 1, text: 'body' }], validQueries, validQrels, 'MLQA corpus[0].title must be a string'],
      [validCorpus, [{ id: '', text: 'query' }], validQrels, 'MLQA queries[0].id must be a non-empty string'],
      [validCorpus, validQueries, [null], 'MLQA qrels[0] row must be an object'],
      [validCorpus, validQueries, [{ ...validQrels[0], score: 1.5 }], 'MLQA qrels[0].score must be a safe integer'],
      [validCorpus, validQueries, [{ ...validQrels[0], 'query-id': '' }], 'MLQA qrels[0].query-id must be a non-empty string'],
      [validCorpus, validQueries, [{ ...validQrels[0], 'corpus-id': '' }], 'MLQA qrels[0].corpus-id must be a non-empty string'],
    ] as const) {
      expect(() => convertMlqaRetrievalRows(corpus, queries, qrels)).toThrow(message)
    }
  })

  it('sorts MLQA documents, queries, and same-query qrels deterministically', () => {
    const converted = convertMlqaRetrievalRows(
      [
        { id: 'C2', title: '', text: 'second' },
        { id: 'C1', title: '', text: 'first' },
      ],
      [
        { id: 'Q2', text: 'second query' },
        { id: 'Q1', text: 'first query' },
      ],
      [
        { 'query-id': 'Q1', 'corpus-id': 'C2', score: 1 },
        { 'query-id': 'Q2', 'corpus-id': 'C2', score: 1 },
        { 'query-id': 'Q1', 'corpus-id': 'C1', score: 1 },
      ],
    )
    expect(converted.corpusText).toBe('{"id":"C1","text":"first"}\n{"id":"C2","text":"second"}\n')
    expect(converted.queriesText).toBe('{"_id":"Q1","text":"first query"}\n{"_id":"Q2","text":"second query"}\n')
    expect(converted.qrelsText).toContain('Q1\tC1\t1\nQ1\tC2\t1\nQ2\tC2\t1')
  })

  it('prepares and converts the MLQA English-Chinese files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mlqa-'))
    temporaryDirectories.push(directory)
    const download = vi.fn(async (_url: string, path: string) => {
      await writeFile(path, 'fixture')
      return { bytes: 7, sha256: 'b'.repeat(64) }
    })
    mocks.parquetRows.push(
      [{ id: 'C1', title: '', text: 'English evidence' }],
      [{ id: 'Q1', text: '中文问题' }],
      [{ 'query-id': 'Q1', 'corpus-id': 'C1', score: 1n }],
    )
    const result = await prepareMlqaEngZho(directory, 'https://mirror.example', download)
    expect(result.outputs?.map(output => output.path)).toEqual(['corpus.jsonl', 'queries.jsonl', 'qrels.tsv'])
    expect(await readFile(join(result.datasetDir, 'corpus.jsonl'), 'utf8'))
      .toBe('{"id":"C1","text":"English evidence"}\n')
    expect(JSON.parse(await readFile(join(result.datasetDir, 'source.json'), 'utf8'))).toEqual(result)
    expect(mocks.asyncBufferFromFile).toHaveBeenCalledTimes(3)
  })
})
