import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChunkTokenizer } from '../src/tokenizer.ts'
import { buildT2RankingBenchmarkSlices } from '../src/t2ranking-benchmark.ts'

const temporaryDirectories: string[] = []
const whitespaceTokenizer: ChunkTokenizer = {
  countTokens(text) {
    return text.match(/\S+/gu)?.length ?? 0
  },
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-t2ranking-benchmark-'))
  temporaryDirectories.push(directory)
  return directory
}

interface FixtureOptions {
  readonly collection?: string
  readonly queries?: string
  readonly qrels?: string
  readonly bm25?: string
}

async function fixture(options: FixtureOptions = {}): Promise<{
  readonly root: string
  readonly collectionPath: string
  readonly queriesPath: string
  readonly qrelsPath: string
  readonly bm25Path: string
  readonly outputDir: string
}> {
  const root = await temporaryDirectory()
  const collectionPath = join(root, 'collection.tsv')
  const queriesPath = join(root, 'queries.dev.tsv')
  const qrelsPath = join(root, 'qrels.retrieval.dev.tsv')
  const bm25Path = join(root, 'dev.bm25.tsv')
  await Promise.all([
    writeFile(collectionPath, options.collection ?? 'pid\ttext\np6\tsix\np3\tthree\np4\tfour\np2\ttwo\np5\tfive\np1\tone'),
    writeFile(queriesPath, options.queries ?? 'qid\ttext\nq2\tsecond\nq1\tfirst\nq3\tignored'),
    writeFile(qrelsPath, options.qrels ?? 'qid\tpid\nq1\tp4\nq2\tp5\nq1\tp5\nq3\tp6'),
    writeFile(bm25Path, options.bm25 ?? [
      'q1\tp2\t1',
      'q2\tp1\t1',
      'q2\tp2\t2',
      'q1\tp3\t2',
      'q2\tp4\t3',
      'q1\tp6\t3',
      'q3\tp6\t1',
    ].join('\n')),
  ])
  return { root, collectionPath, queriesPath, qrelsPath, bm25Path, outputDir: join(root, 'slices') }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('T2Ranking threshold-calibration slices', () => {
  it('writes strict nested prefixes with positive-first and rank-round-robin selection', async () => {
    const paths = await fixture()
    const result = await buildT2RankingBenchmarkSlices({
      ...paths,
      tokenizer: whitespaceTokenizer,
      queryLimit: 2,
      chunkTargets: [5, 3],
    })

    expect(result).toEqual({
      queryCount: 2,
      slices: [
        { chunkTarget: 3, chunkCount: 3, documentCount: 3, directory: join(paths.outputDir, 'chunks-3') },
        { chunkTarget: 5, chunkCount: 5, documentCount: 5, directory: join(paths.outputDir, 'chunks-5') },
      ],
    })
    const smaller = await readFile(join(paths.outputDir, 'chunks-3/corpus.tsv'), 'utf8')
    const larger = await readFile(join(paths.outputDir, 'chunks-5/corpus.tsv'), 'utf8')
    expect(smaller).toBe('pid\ttext\nd000000\tfive\nd000001\tfour\nd000002\tone\n')
    expect(larger.startsWith(smaller)).toBe(true)
    expect(larger).toBe(`${smaller}d000003\ttwo\nd000004\tthree\n`)
    expect(await readFile(join(paths.outputDir, 'chunks-3/queries.tsv'), 'utf8'))
      .toBe('qid\ttext\nq2\tsecond\nq1\tfirst\n')
    expect(await readFile(join(paths.outputDir, 'chunks-3/qrels.tsv'), 'utf8'))
      .toBe('qid\tpid\nq2\td000000\nq1\td000001\nq1\td000000\n')

    const selection = (await readFile(join(paths.outputDir, 'chunks-5/selection.jsonl'), 'utf8'))
      .trim().split('\n').map(row => JSON.parse(row) as unknown)
    expect(selection).toEqual([
      { ordinal: 0, pid: 'd000000', sourcePid: 'p5', chunkCount: 1, cumulativeChunkCount: 1, kind: 'positive', queryId: 'q2' },
      { ordinal: 1, pid: 'd000001', sourcePid: 'p4', chunkCount: 1, cumulativeChunkCount: 2, kind: 'positive', queryId: 'q1' },
      { ordinal: 2, pid: 'd000002', sourcePid: 'p1', chunkCount: 1, cumulativeChunkCount: 3, kind: 'bm25', queryId: 'q2', rank: 1 },
      { ordinal: 3, pid: 'd000003', sourcePid: 'p2', chunkCount: 1, cumulativeChunkCount: 4, kind: 'bm25', queryId: 'q1', rank: 1 },
      { ordinal: 4, pid: 'd000004', sourcePid: 'p3', chunkCount: 1, cumulativeChunkCount: 5, kind: 'bm25', queryId: 'q1', rank: 2 },
    ])
    const metadata = JSON.parse(await readFile(join(paths.outputDir, 'chunks-5/source.json'), 'utf8')) as {
      chunking: unknown
      sources: Array<{ path: string; bytes: number; sha256: string }>
      outputs: Array<{ path: string; bytes: number; sha256: string }>
    }
    expect(metadata.chunking).toEqual({ maxTokens: 384, overlapTokens: 64 })
    expect(metadata.sources).toHaveLength(4)
    expect(metadata.sources[0]).toMatchObject({
      path: paths.collectionPath,
      bytes: Buffer.byteLength(await readFile(paths.collectionPath, 'utf8')),
      sha256: createHash('sha256').update(await readFile(paths.collectionPath)).digest('hex'),
    })
    expect(metadata.outputs.map(output => output.path)).toEqual(['corpus.tsv', 'queries.tsv', 'qrels.tsv', 'selection.jsonl'])
  })

  it('adds another document when one long positive crosses two adjacent targets', async () => {
    const long = Array.from({ length: 500 }, (_, index) => `t${index}`).join(' ')
    const paths = await fixture({
      collection: `pid\ttext\nlong\t${long}\nshort\tshort`,
      queries: 'qid\ttext\nq\tquery',
      qrels: 'qid\tpid\nq\tlong',
      bm25: 'q\tshort\t1',
    })
    const result = await buildT2RankingBenchmarkSlices({
      ...paths,
      tokenizer: whitespaceTokenizer,
      chunkTargets: [1, 2],
    })

    expect(result.slices).toMatchObject([
      { chunkTarget: 1, chunkCount: 2, documentCount: 1 },
      { chunkTarget: 2, chunkCount: 3, documentCount: 2 },
    ])
  })

  it('skips source-order queries that have no retrieval judgment', async () => {
    const paths = await fixture({
      queries: 'qid\ttext\nmissing\tunjudged\nq2\tsecond\nq1\tfirst',
    })
    const result = await buildT2RankingBenchmarkSlices({
      ...paths,
      tokenizer: whitespaceTokenizer,
      queryLimit: 2,
      chunkTargets: [2],
    })

    expect(result.queryCount).toBe(2)
    expect(await readFile(join(paths.outputDir, 'chunks-2/queries.tsv'), 'utf8'))
      .toBe('qid\ttext\nq2\tsecond\nq1\tfirst\n')
  })

  it('accepts an existing empty output directory and trailing blank rows', async () => {
    const paths = await fixture({
      collection: 'pid\ttext\np1\tone\n\np2\ttwo\n',
      queries: 'qid\ttext\n\nq1\tfirst\n',
      qrels: 'qid\tpid\n\nq1\tp1\n',
      bm25: '\nq1\tp2\t1\n',
    })
    await mkdir(paths.outputDir)
    await expect(buildT2RankingBenchmarkSlices({
      ...paths,
      tokenizer: whitespaceTokenizer,
      chunkTargets: [1],
    })).resolves.toMatchObject({ queryCount: 1 })
  })

  it('uses the default targets when the caller omits them', async () => {
    const paths = await fixture()
    await expect(buildT2RankingBenchmarkSlices({ ...paths, tokenizer: whitespaceTokenizer }))
      .rejects.toThrow('BM25 candidates provide only 6 chunks, below target 10000')
  })

  it.each([
    [{ qrels: 'wrong\nq1\tp1' }, 'expected header qid, pid'],
    [{ qrels: 'qid\tpid\nq1' }, 'expected qid and pid separated by one tab'],
    [{ qrels: 'qid\tpid\n \tp1' }, 'qid must be a non-empty string'],
    [{ qrels: 'qid\tpid\nq1\t ' }, 'pid must be a non-empty string'],
    [{ queries: 'wrong\nq1\tfirst' }, 'expected header qid, text'],
    [{ queries: 'qid\ttext\nq1' }, 'expected qid and text separated by one tab'],
    [{ queries: 'qid\ttext\n \tfirst', qrels: 'qid\tpid\n \tp1' }, 'qid must be a non-empty string'],
    [{ queries: 'qid\ttext\nq1\t ', qrels: 'qid\tpid\nq1\tp1' }, 'text must be a non-empty string'],
    [{ queries: 'qid\ttext\nq1\tfirst\nq1\tagain', qrels: 'qid\tpid\nq1\tp1' }, 'duplicate query id "q1"'],
    [{ queries: 'qid\ttext\nq3\tignored', qrels: 'qid\tpid\nq1\tp1' }, 'no queries were selected'],
    [{ qrels: 'qid\tpid\nq1\tp1\nq1\tp1' }, 'duplicate query and passage judgment'],
    [{ bm25: 'q1\tp2' }, 'expected qid, pid, and rank separated by tabs'],
    [{ bm25: ' \tp2\t1' }, 'qid must be a non-empty string'],
    [{ bm25: 'q1\t \t1' }, 'pid must be a non-empty string'],
    [{ bm25: 'q1\tp2\t1\nq1\tp3\t1' }, 'duplicate rank 1 for query "q1"'],
    [{ collection: 'wrong\np1\tone' }, 'expected header pid, text'],
    [{ collection: 'pid\ttext\np5\tfive\np5\tagain\np4\tfour\np1\tone\np2\ttwo\np3\tthree\np6\tsix' }, 'duplicate passage id "p5"'],
    [{ collection: 'pid\ttext\np4\tfour' }, 'missing selected passage "p5"'],
  ] satisfies ReadonlyArray<readonly [FixtureOptions, string]>)('rejects malformed source input %#', async (options, message) => {
    const paths = await fixture(options)
    await expect(buildT2RankingBenchmarkSlices({
      ...paths,
      tokenizer: whitespaceTokenizer,
      queryLimit: 2,
      chunkTargets: [1],
    })).rejects.toThrow(message)
  })

  it('ignores unrelated collection rows and handles output stream backpressure', async () => {
    const large = 'x'.repeat(100_000)
    const paths = await fixture({
      collection: `pid\ttext\nunrelated row without a tab\np1\t${large}`,
      queries: 'qid\ttext\nq1\tfirst',
      qrels: 'qid\tpid\nq1\tp1',
      bm25: '',
    })
    const result = await buildT2RankingBenchmarkSlices({
      ...paths,
      tokenizer: whitespaceTokenizer,
      chunkTargets: [1],
    })

    expect(result.slices).toMatchObject([{ chunkCount: 1, documentCount: 1 }])
  })

  it('rejects invalid limits, occupied outputs, malformed ranking rows, and insufficient passages', async () => {
    const paths = await fixture()
    await expect(buildT2RankingBenchmarkSlices({ ...paths, tokenizer: whitespaceTokenizer, queryLimit: 0 }))
      .rejects.toThrow('queryLimit must be a positive safe integer')
    await expect(buildT2RankingBenchmarkSlices({ ...paths, tokenizer: whitespaceTokenizer, queryLimit: Number.NaN }))
      .rejects.toThrow('queryLimit must be a positive safe integer')
    await expect(buildT2RankingBenchmarkSlices({ ...paths, tokenizer: whitespaceTokenizer, chunkTargets: [0] }))
      .rejects.toThrow('chunk target must be a positive safe integer')
    await expect(buildT2RankingBenchmarkSlices({ ...paths, tokenizer: whitespaceTokenizer, chunkTargets: [] }))
      .rejects.toThrow('chunkTargets must not be empty')
    await expect(buildT2RankingBenchmarkSlices({ ...paths, tokenizer: whitespaceTokenizer, chunkTargets: [1, 1] }))
      .rejects.toThrow('chunkTargets must be unique')

    const occupied = await fixture()
    await mkdir(occupied.outputDir)
    await writeFile(join(occupied.outputDir, 'keep'), 'occupied')
    await expect(buildT2RankingBenchmarkSlices({ ...occupied, tokenizer: whitespaceTokenizer, chunkTargets: [1] }))
      .rejects.toThrow('output directory is not empty')

    const malformed = await fixture({ bm25: 'q2\tp1\tnot-a-rank' })
    await expect(buildT2RankingBenchmarkSlices({ ...malformed, tokenizer: whitespaceTokenizer, chunkTargets: [1] }))
      .rejects.toThrow('rank must be a positive safe integer')

    const insufficient = await fixture({
      collection: 'pid\ttext\np4\tfour\np5\tfive',
      bm25: '',
    })
    await expect(buildT2RankingBenchmarkSlices({
      ...insufficient,
      tokenizer: whitespaceTokenizer,
      queryLimit: 2,
      chunkTargets: [3],
    })).rejects.toThrow('BM25 candidates provide only 2 chunks, below target 3')
  })
})
