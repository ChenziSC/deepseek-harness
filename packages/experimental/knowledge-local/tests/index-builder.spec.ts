import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeChunkId, KnowledgeDocumentId } from '@deepseek-ai/dsh-experimental-knowledge'
import {
  buildBm25KnowledgeIndex,
  buildKnowledgeIndex,
  createDenseIndexBuildPlan,
  DENSE_DIMENSIONS,
  loadDenseVectors,
  loadKnowledgeIndex,
  type ChunkTokenizer,
} from '@deepseek-ai/dsh-experimental-knowledge-local'
import { deriveKnowledgeIndexFromExact } from '../src/index-builder.ts'
import { KnowledgeSqliteWriter } from '../src/sqlite-index.ts'

const temporaryDirectories: string[] = []
const whitespaceTokenizer: ChunkTokenizer = {
  countTokens(text) {
    return text.match(/\S+/gu)?.length ?? 0
  },
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('SQLite index construction', () => {
  it('streams a corpus file into the version-three SQLite payload', async () => {
    const root = await temporaryDirectory()
    const corpusPath = join(root, 'corpus.jsonl')
    const corpusText = [
      '{"id":"doc-b","text":"delta"}',
      '{"id":"doc-a","title":"Alpha","text":"alpha beta gamma"}',
    ].join('\n')
    await writeFile(corpusPath, corpusText)
    const outputDir = join(root, 'index')
    const manifest = await buildBm25KnowledgeIndex({
      corpusPath,
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      sqliteBatchSize: 1,
    })
    const loaded = await loadKnowledgeIndex(outputDir)

    expect(manifest).toMatchObject({
      formatVersion: 3,
      corpus: {
        sha256: createHash('sha256').update(corpusText).digest('hex'),
        documentCount: 2,
        chunkCount: 3,
        scriptProfile: 'latin',
      },
      chunking: { strategy: 'markdown-structure-v1' },
      bm25: { analyzer: 'mixed-zh-en-v1', implementation: 'sqlite-fts5' },
      payloads: [{ path: 'knowledge.sqlite' }],
    })
    expect(loaded.sqlite.allChunks().map(chunk => chunk.chunkId)).toEqual([
      'doc-a:0-2',
      'doc-a:2-3',
      'doc-b:0-1',
    ])
    const matches = loaded.sqlite.searchBm25('alpha', 2)
    expect(matches.map(match => match.ordinal)).toEqual([0, 1])
    expect(matches.every(match => Number.isFinite(match.score))).toBe(true)
    expect(await readdir(outputDir)).toEqual(['knowledge.sqlite', 'manifest.json'])
    loaded.sqlite.close()
  })

  it('streams a gzipped corpus without an expanded temporary copy', async () => {
    const root = await temporaryDirectory()
    const corpusPath = join(root, 'corpus.jsonl.gz')
    const corpusText = '{"docid":"doc","text":"long document"}\n'
    await writeFile(corpusPath, gzipSync(corpusText))
    const outputDir = join(root, 'index')
    const manifest = await buildBm25KnowledgeIndex({
      corpusPath,
      corpusFormat: 'mldr',
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
    })
    const loaded = await loadKnowledgeIndex(outputDir)

    expect(manifest.corpus).toMatchObject({
      sha256: createHash('sha256').update(corpusText).digest('hex'),
      documentCount: 1,
      chunkCount: 1,
    })
    expect(loaded.sqlite.allChunks()).toMatchObject([{ documentId: 'doc', text: 'long document' }])
    loaded.sqlite.close()
  })

  it('indexes Markdown section paths and records a mixed corpus script profile', async () => {
    const outputDir = join(await temporaryDirectory(), 'markdown-index')
    const text = '# Guide\n\n## Install\nalpha beta gamma delta epsilon\n\n这是用于安装步骤的中文详细说明'
    const manifest = await buildBm25KnowledgeIndex({
      corpusText: `${JSON.stringify({ id: 'guide', text })}\n`,
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 4, overlapTokens: 0 },
    })
    const loaded = await loadKnowledgeIndex(outputDir)
    const matches = loaded.sqlite.searchBm25('install', 10)

    expect(manifest.corpus.scriptProfile).toBe('mixed')
    expect(matches.length).toBeGreaterThan(1)
    expect(loaded.sqlite.chunks(matches.map(match => match.ordinal)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ sectionPath: 'Guide > Install' })]))
    loaded.sqlite.close()
  })

  it('skips a T2Ranking header and accepts a final row without a newline', async () => {
    const outputDir = join(await temporaryDirectory(), 't2ranking-index')
    const manifest = await buildBm25KnowledgeIndex({
      corpusText: 'pid\ttext\np-1\talpha',
      corpusFormat: 't2ranking',
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
    })
    expect(manifest.corpus).toMatchObject({ documentCount: 1, chunkCount: 1 })

    const headerlessDir = join(await temporaryDirectory(), 't2ranking-headerless')
    const headerless = await buildBm25KnowledgeIndex({
      corpusText: 'p-1\talpha',
      corpusFormat: 't2ranking',
      outputDir: headerlessDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
    })
    expect(headerless.corpus.documentCount).toBe(1)
  })

  it('rejects a non-empty target and duplicate streamed document ids', async () => {
    const root = await temporaryDirectory()
    const occupied = join(root, 'occupied')
    await buildBm25KnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: occupied,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
    })
    await expect(buildBm25KnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: occupied,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
    })).rejects.toThrow('output directory is not empty')

    await expect(buildBm25KnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}\n{"id":"doc","text":"beta"}',
      corpusSource: 'fixture.jsonl',
      outputDir: join(root, 'duplicate'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      sqliteBatchSize: 1,
    })).rejects.toThrow('fixture.jsonl:2: duplicate document id "doc"')
  })

  it('writes Dense vectors in bounded batches and validates them lazily', async () => {
    const outputDir = join(await temporaryDirectory(), 'dense-index')
    const batchSizes: number[] = []
    const manifest = await buildKnowledgeIndex({
      corpusText: [
        '{"id":"doc-b","text":"delta"}',
        '{"id":"doc-a","title":"Alpha","text":"alpha beta"}',
      ].join('\n'),
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      dense: {
        encoder: {
          embedDocuments(texts) {
            batchSizes.push(texts.length)
            const vectors = new Float32Array(texts.length * DENSE_DIMENSIONS)
            for (const [row, text] of texts.entries()) {
              vectors[row * DENSE_DIMENSIONS + (text.startsWith('Alpha\n') ? 0 : 1)] = 1
            }
            return Promise.resolve(vectors)
          },
        },
        batchSize: 1,
        modelId: 'onnx-community/bge-small-en-v1.5-ONNX',
        revision: '4a9a46c7b88fa408e650a571a1800243f26309bd',
        dtype: 'q8',
      },
    })
    const loaded = await loadKnowledgeIndex(outputDir)
    const vectors = await loadDenseVectors(loaded)

    expect(manifest.payloads.map(payload => payload.path)).toEqual(['knowledge.sqlite', 'dense.f32le'])
    expect(batchSizes).toEqual([1, 1])
    expect(loaded.dense?.dimensions).toBe(DENSE_DIMENSIONS)
    expect(vectors[0]).toBe(1)
    expect(vectors[DENSE_DIMENSIONS]).toBe(0)
    expect(vectors[DENSE_DIMENSIONS + 1]).toBe(1)
    loaded.sqlite.close()

    const densePath = join(outputDir, 'dense.f32le')
    const data = await readFile(densePath)
    data.writeFloatLE(2, 0)
    await writeFile(densePath, data)
    const manifestPath = join(outputDir, 'manifest.json')
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      payloads: Array<{ path: string; sha256: string }>
    }
    const densePayload = parsed.payloads.find(payload => payload.path === 'dense.f32le')
    if (densePayload === undefined) throw new TypeError('expected dense payload')
    densePayload.sha256 = createHash('sha256').update(data).digest('hex')
    await writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`)
    const corrupted = await loadKnowledgeIndex(outputDir)
    await expect(loadDenseVectors(corrupted)).rejects.toThrow('not L2-normalized')
    corrupted.sqlite.close()
  })

  it('selects Exact at the scan threshold and HNSW above it', async () => {
    const build = async (threshold: number, outputDir: string) => buildKnowledgeIndex({
      corpusText: '{"id":"doc-a","text":"alpha"}\n{"id":"doc-b","text":"beta"}',
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      dense: {
        encoder: {
          embedDocuments(texts) {
            const vectors = new Float32Array(texts.length * 4)
            for (let row = 0; row < texts.length; row += 1) vectors[row * 4 + row] = 1
            return Promise.resolve(vectors)
          },
        },
        batchSize: 2,
        modelId: 'test-model',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        dimensions: 4,
        exactScanMaxElements: threshold,
      },
    })
    const exact = await build(8, join(await temporaryDirectory(), 'exact'))
    const hnsw = await build(7, join(await temporaryDirectory(), 'hnsw'))

    expect(exact.dense).toMatchObject({ scanElements: 8, autoDenseIndex: 'exact' })
    expect(exact.hnsw).toBeUndefined()
    expect(exact.payloads.map(payload => payload.path)).toEqual(['knowledge.sqlite', 'dense.f32le'])
    expect(hnsw.dense).toMatchObject({
      scanElements: 8,
      recommendedIndex: 'hnsw',
      resolvedIndex: 'hnsw',
      autoDenseIndex: 'hnsw',
    })
    expect(hnsw.hnsw).toMatchObject({ library: 'usearch', connectivity: 16, expansionAdd: 128 })
    expect(hnsw.payloads.map(payload => payload.path)).toEqual([
      'knowledge.sqlite',
      'dense.usearch',
    ])
  })

  it('reports the Dense storage plan and retains both payloads only after an explicit selection', async () => {
    const plans: unknown[] = []
    const outputDir = join(await temporaryDirectory(), 'both')
    const manifest = await buildKnowledgeIndex({
      corpusText: '{"id":"doc-a","text":"alpha"}\n{"id":"doc-b","text":"beta"}',
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      dense: {
        encoder: {
          embedDocuments(texts) {
            const vectors = new Float32Array(texts.length * 4)
            for (let row = 0; row < texts.length; row += 1) vectors[row * 4 + row] = 1
            return Promise.resolve(vectors)
          },
        },
        batchSize: 2,
        modelId: 'test-model',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        dimensions: 4,
        selectIndex(plan) {
          plans.push(plan)
          return 'both'
        },
      },
    })

    expect(plans).toEqual([createDenseIndexBuildPlan(2, 2, {
      encoder: { embedDocuments: () => Promise.resolve(new Float32Array()) },
      batchSize: 2,
      modelId: 'test-model',
      revision: 'a'.repeat(40),
      dtype: 'q8',
      dimensions: 4,
    })])
    expect(manifest.dense).toMatchObject({ requestedIndex: 'auto', resolvedIndex: 'both', autoDenseIndex: 'exact' })
    expect(manifest.payloads.map(payload => payload.path)).toEqual([
      'knowledge.sqlite',
      'dense.f32le',
      'dense.usearch',
    ])
  })

  it('builds directly from the BEIR SciFact corpus format', async () => {
    const outputDir = join(await temporaryDirectory(), 'scifact-index')
    const manifest = await buildBm25KnowledgeIndex({
      corpusText: '{"_id":"doc","title":"Claim","text":"evidence body"}\n',
      corpusSource: 'scifact/corpus.jsonl',
      corpusFormat: 'scifact',
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
    })
    const loaded = await loadKnowledgeIndex(outputDir)

    expect(manifest.corpus).toMatchObject({ documentCount: 1, chunkCount: 1 })
    expect(loaded.sqlite.allChunks()).toMatchObject([{ documentId: 'doc', title: 'Claim' }])
    loaded.sqlite.close()
  })

  it('accepts an existing empty output directory and explicit tokenizer metadata', async () => {
    const outputDir = await temporaryDirectory()
    const manifest = await buildBm25KnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      tokenizerModelId: 'fixture-tokenizer',
      tokenizerRevision: 'fixture-revision',
    })
    expect(manifest.chunking).toMatchObject({
      tokenizerModelId: 'fixture-tokenizer',
      tokenizerRevision: 'fixture-revision',
    })
  })

  it('accepts an empty corpus and skips blank JSONL lines', async () => {
    const emptyDir = join(await temporaryDirectory(), 'empty')
    await buildBm25KnowledgeIndex({
      corpusText: '',
      outputDir: emptyDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
    })
    const empty = await loadKnowledgeIndex(emptyDir)
    expect(empty.manifest.corpus).toMatchObject({ documentCount: 0, chunkCount: 0 })
    expect(empty.sqlite.allChunks()).toEqual([])
    empty.sqlite.close()

    const blankDir = join(await temporaryDirectory(), 'blank-lines')
    const blank = await buildBm25KnowledgeIndex({
      corpusText: '\r\n{"id":"doc","text":"alpha"}\r\n   ',
      outputDir: blankDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
    })
    expect(blank.corpus).toMatchObject({ documentCount: 1, chunkCount: 1 })
  })

  it('derives every Dense payload mode from a validated prefix without calling an encoder', async () => {
    const root = await temporaryDirectory()
    const sourceCorpus = [
      '{"id":"doc-a","title":"A","source":"fixture","text":"alpha one"}',
      '{"id":"doc-b","text":"beta two"}',
      '{"id":"doc-c","text":"gamma three"}',
    ].join('\n')
    const targetCorpus = sourceCorpus.split('\n').slice(0, 2).join('\n')
    const sourceDir = join(root, 'source')
    await buildKnowledgeIndex({
      corpusText: sourceCorpus,
      outputDir: sourceDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      analyzer: 'english-v1',
      tokenizerModelId: 'fixture-tokenizer',
      tokenizerRevision: 'fixture-revision',
      dense: {
        encoder: {
          embedDocuments(texts) {
            const vectors = new Float32Array(texts.length * 4)
            for (let row = 0; row < texts.length; row += 1) vectors[row * 4 + row] = 1
            return Promise.resolve(vectors)
          },
        },
        batchSize: 3,
        modelId: 'test-model',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        dimensions: 4,
        denseIndex: 'exact',
      },
    })
    const source = await loadKnowledgeIndex(sourceDir)
    const sourceVectors = await loadDenseVectors(source)
    for (const denseIndex of ['exact', 'hnsw', 'both'] as const) {
      const targetDir = join(root, denseIndex)
      const manifest = await deriveKnowledgeIndexFromExact({
        sourceIndexDir: sourceDir,
        corpusText: targetCorpus,
        outputDir: targetDir,
        tokenizer: whitespaceTokenizer,
        chunking: { maxTokens: 8, overlapTokens: 0 },
        sqliteBatchSize: 1,
        denseIndex,
        ...(denseIndex === 'exact' ? {
          analyzer: 'english-v1' as const,
          tokenizerModelId: 'fixture-tokenizer',
          tokenizerRevision: 'fixture-revision',
          exactScanMaxElements: 1,
          connectivity: 8,
          expansionAdd: 16,
        } : {}),
      })
      const target = await loadKnowledgeIndex(targetDir)

      expect(manifest).toMatchObject({
        formatVersion: 3,
        corpus: {
          sha256: createHash('sha256').update(targetCorpus).digest('hex'),
          documentCount: 2,
          chunkCount: 2,
        },
        dense: {
          modelId: 'test-model',
          dimensions: 4,
          vectorCount: 2,
          requestedIndex: denseIndex,
          resolvedIndex: denseIndex,
        },
      })
      expect(manifest.payloads.map(payload => payload.path)).toEqual([
        'knowledge.sqlite',
        ...(denseIndex === 'exact' || denseIndex === 'both' ? ['dense.f32le'] : []),
        ...(denseIndex === 'hnsw' || denseIndex === 'both' ? ['dense.usearch'] : []),
      ])
      if (denseIndex === 'exact' || denseIndex === 'both') {
        const targetVectors = await loadDenseVectors(target)
        expect(targetVectors).toEqual(sourceVectors.slice(0, targetVectors.length))
      }
      expect(target.sqlite.denseInputs(-1, 10)).toEqual(source.sqlite.denseInputs(-1, 2))
      target.sqlite.close()
    }
    source.sqlite.close()
  })

  it('rejects a target whose Dense inputs are not an ordinal prefix of the source', async () => {
    const root = await temporaryDirectory()
    const sourceDir = join(root, 'source')
    await buildKnowledgeIndex({
      corpusText: '{"id":"doc-a","text":"alpha"}\n{"id":"doc-b","text":"beta"}',
      outputDir: sourceDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      dense: {
        encoder: {
          embedDocuments(texts) {
            const vectors = new Float32Array(texts.length * 2)
            for (let row = 0; row < texts.length; row += 1) vectors[row * 2 + row] = 1
            return Promise.resolve(vectors)
          },
        },
        batchSize: 2,
        modelId: 'test-model',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        dimensions: 2,
        denseIndex: 'exact',
      },
    })

    await expect(deriveKnowledgeIndexFromExact({
      sourceIndexDir: sourceDir,
      corpusText: '{"id":"doc-a","text":"changed"}',
      outputDir: join(root, 'target'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      denseIndex: 'hnsw',
    })).rejects.toThrow('target Dense input at ordinal 0 does not match the source index prefix')

    await expect(deriveKnowledgeIndexFromExact({
      sourceIndexDir: sourceDir,
      corpusText: [
        '{"id":"doc-a","text":"alpha"}',
        '{"id":"doc-b","text":"beta"}',
        '{"id":"doc-c","text":"gamma"}',
      ].join('\n'),
      outputDir: join(root, 'too-long'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      denseIndex: 'exact',
    })).rejects.toThrow('target Dense input at ordinal 2 does not match the source index prefix')

    await expect(deriveKnowledgeIndexFromExact({
      sourceIndexDir: sourceDir,
      corpusText: '{"id":"doc-z","text":"alpha"}',
      outputDir: join(root, 'different-identity'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      denseIndex: 'exact',
    })).rejects.toThrow('target Dense input at ordinal 0 does not match the source index prefix')

    const database = new DatabaseSync(join(sourceDir, 'knowledge.sqlite'))
    database.prepare("UPDATE chunks SET document_id = 'doc-z' WHERE ordinal = 0").run()
    database.close()
    await expect(deriveKnowledgeIndexFromExact({
      sourceIndexDir: sourceDir,
      corpusText: '{"id":"doc-a","text":"alpha"}',
      outputDir: join(root, 'different-document'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      denseIndex: 'exact',
    })).rejects.toThrow('target Dense input at ordinal 0 does not match the source index prefix')
  })

  it('rejects derived retrieval and chunking metadata that differ from the source', async () => {
    const root = await temporaryDirectory()
    const sourceDir = join(root, 'source')
    await buildKnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha beta"}',
      outputDir: sourceDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      analyzer: 'english-v1',
      tokenizerModelId: 'fixture-tokenizer',
      tokenizerRevision: 'fixture-revision',
      dense: {
        encoder: { embedDocuments: () => Promise.resolve(new Float32Array([1, 0])) },
        batchSize: 1,
        modelId: 'test-model',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        dimensions: 2,
        denseIndex: 'exact',
      },
    })
    const cases = [
      [{ analyzer: 'mixed-zh-en-v1' as const }, 'derived analyzer must match'],
      [{ chunking: { maxTokens: 4, overlapTokens: 0 } }, 'derived chunking must match'],
      [{ chunking: { maxTokens: 8, overlapTokens: 1 } }, 'derived chunking must match'],
      [{ tokenizerModelId: 'other' }, 'derived tokenizer must match'],
      [{ tokenizerRevision: 'other' }, 'derived tokenizer must match'],
    ] as const
    for (const [caseIndex, [override, message]] of cases.entries()) {
      await expect(deriveKnowledgeIndexFromExact({
        sourceIndexDir: sourceDir,
        corpusText: '{"id":"doc","text":"alpha beta"}',
        outputDir: join(root, `target-${caseIndex}`),
        tokenizer: whitespaceTokenizer,
        chunking: { maxTokens: 8, overlapTokens: 0 },
        denseIndex: 'exact',
        ...override,
      })).rejects.toThrow(message)
    }
  })

  it('requires an Exact source payload when deriving vectors', async () => {
    const root = await temporaryDirectory()
    const sourceDir = join(root, 'source')
    await buildKnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: sourceDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      dense: {
        encoder: {
          embedDocuments() {
            return Promise.resolve(new Float32Array([1, 0]))
          },
        },
        batchSize: 1,
        modelId: 'test-model',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        dimensions: 2,
        denseIndex: 'hnsw',
      },
    })

    await expect(deriveKnowledgeIndexFromExact({
      sourceIndexDir: sourceDir,
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: join(root, 'target'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      denseIndex: 'exact',
    })).rejects.toThrow('source index must retain dense.f32le')

    const bm25Dir = join(root, 'bm25-source')
    await buildBm25KnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: bm25Dir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
    })
    await expect(deriveKnowledgeIndexFromExact({
      sourceIndexDir: bm25Dir,
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: join(root, 'bm25-target'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      denseIndex: 'exact',
    })).rejects.toThrow('source index must retain dense.f32le')
  })

  it.each([
    [{ sqliteBatchSize: 0 }, 'sqliteBatchSize must be a positive safe integer'],
    [{ sqliteBatchSize: 1.5 }, 'sqliteBatchSize must be a positive safe integer'],
    [{ exactScanMaxElements: 0 }, 'Dense exactScanMaxElements must be a positive safe integer'],
    [{ exactScanMaxElements: 1.5 }, 'Dense exactScanMaxElements must be a positive safe integer'],
    [{ connectivity: 0 }, 'Dense connectivity must be positive'],
    [{ connectivity: 1.5 }, 'Dense connectivity must be positive'],
    [{ expansionAdd: 0 }, 'Dense expansionAdd must be positive'],
    [{ expansionAdd: 1.5 }, 'Dense expansionAdd must be positive'],
  ])('rejects invalid Dense derivation settings %j', async (override, message) => {
    await expect(deriveKnowledgeIndexFromExact({
      sourceIndexDir: '/missing',
      corpusText: '',
      outputDir: join(await temporaryDirectory(), 'target'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
      denseIndex: 'exact',
      ...override,
    })).rejects.toThrow(message)
  })

  it('rolls back failed SQLite writer batches and closes idempotently', async () => {
    const path = join(await temporaryDirectory(), 'knowledge.sqlite')
    const writer = new KnowledgeSqliteWriter(path, 'english-v1')
    const chunk = {
      ordinal: 0,
      id: KnowledgeChunkId('doc:0-1'),
      documentId: KnowledgeDocumentId('doc'),
      text: 'alpha',
      startToken: 0,
      endToken: 1,
    }
    writer.insert([chunk])
    expect(() => { writer.insert([chunk]) }).toThrow('UNIQUE constraint failed')
    expect(writer.denseInputs(-1, 10)).toEqual([{
      ordinal: 0,
      chunkId: 'doc:0-1',
      documentId: 'doc',
      text: 'alpha',
    }])
    writer.close()
    writer.close()
    expect(() => new KnowledgeSqliteWriter(path, 'english-v1')).toThrow('already exists')
  })

  it('rejects invalid source and batch settings', async () => {
    const base = {
      outputDir: join(await temporaryDirectory(), 'index'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
    }
    await expect(buildBm25KnowledgeIndex({ ...base })).rejects.toThrow('exactly one of corpusText or corpusPath')
    await expect(buildBm25KnowledgeIndex({ ...base, outputDir: `${base.outputDir}-both`, corpusText: '', corpusPath: '/x' }))
      .rejects.toThrow('exactly one of corpusText or corpusPath')
    await expect(buildBm25KnowledgeIndex({ ...base, outputDir: `${base.outputDir}-batch`, corpusText: '', sqliteBatchSize: 0 }))
      .rejects.toThrow('sqliteBatchSize must be a positive safe integer')
    await expect(buildBm25KnowledgeIndex({
      ...base,
      outputDir: `${base.outputDir}-missing`,
      corpusPath: `${base.outputDir}-missing.jsonl`,
    })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    [{ batchSize: 0 }, 'Dense batchSize must be a positive safe integer'],
    [{ batchSize: 1.5 }, 'Dense batchSize must be a positive safe integer'],
    [{ modelId: ' ' }, 'Dense modelId must be non-empty'],
    [{ revision: 'main' }, 'Dense revision must be a full lowercase commit SHA'],
    [{ dimensions: 0 }, 'Dense dimensions must be a positive safe integer'],
    [{ dimensions: 1.5 }, 'Dense dimensions must be a positive safe integer'],
    [{ exactScanMaxElements: 0 }, 'Dense exactScanMaxElements must be a positive safe integer'],
    [{ exactScanMaxElements: 1.5 }, 'Dense exactScanMaxElements must be a positive safe integer'],
    [{ connectivity: 0 }, 'Dense connectivity must be positive'],
    [{ expansionAdd: 0 }, 'Dense expansionAdd must be positive'],
  ])('rejects invalid Dense build settings %j', async (override, message) => {
    await expect(buildKnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: join(await temporaryDirectory(), 'index'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      dense: {
        encoder: { embedDocuments: () => Promise.resolve(new Float32Array(DENSE_DIMENSIONS)) },
        batchSize: 1,
        modelId: 'model',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        ...override,
      },
    })).rejects.toThrow(message)
  })

  it('rejects an invalid interactive Dense payload selection before embedding', async () => {
    await expect(buildKnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: join(await temporaryDirectory(), 'invalid-selection'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      dense: {
        encoder: { embedDocuments: () => Promise.reject(new Error('must not embed')) },
        batchSize: 1,
        modelId: 'model',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        selectIndex: () => 'invalid' as 'exact',
      },
    })).rejects.toThrow('Dense index selection must be exact, hnsw, or both')
  })

  it('rejects a Dense scan size beyond the safe integer range before embedding', async () => {
    await expect(buildKnowledgeIndex({
      corpusText: '{"id":"a","text":"alpha"}\n{"id":"b","text":"beta"}',
      outputDir: join(await temporaryDirectory(), 'overflow'),
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      dense: {
        encoder: { embedDocuments: () => Promise.reject(new Error('must not embed')) },
        batchSize: 1,
        modelId: 'model',
        revision: 'a'.repeat(40),
        dtype: 'q8',
        dimensions: Number.MAX_SAFE_INTEGER,
      },
    })).rejects.toThrow('Dense scanElements exceeds safe integer range')
  })
})
