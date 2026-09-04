import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildBm25KnowledgeIndex,
  buildKnowledgeIndex,
  DENSE_DIMENSIONS,
  loadKnowledgeIndex,
  type ChunkTokenizer,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

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

describe('BM25 index format', () => {
  it('writes payloads first and loads the completed index', async () => {
    const outputDir = join(await temporaryDirectory(), 'index')
    const manifest = await buildBm25KnowledgeIndex({
      corpusText: [
        '{"id":"doc-b","text":"delta"}',
        '{"id":"doc-a","title":"Alpha","text":"alpha beta gamma"}',
      ].join('\n'),
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      bm25K1: 1.2,
      bm25B: 0.75,
    })
    const loaded = await loadKnowledgeIndex(outputDir)

    expect(manifest.corpus).toMatchObject({ documentCount: 2, chunkCount: 3 })
    expect(loaded.chunks.map(chunk => chunk.chunkId)).toEqual(['doc-a:0-2', 'doc-a:2-3', 'doc-b:0-1'])
    expect(loaded.bm25.documentLengths).toEqual([3, 2, 1])
  })

  it('rejects a non-empty target and a corrupted payload', async () => {
    const root = await temporaryDirectory()
    const occupied = join(root, 'occupied')
    await buildBm25KnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: occupied,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      bm25K1: 1.2,
      bm25B: 0.75,
    })
    await expect(buildBm25KnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: occupied,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      bm25K1: 1.2,
      bm25B: 0.75,
    })).rejects.toThrow('output directory is not empty')

    const chunksPath = join(occupied, 'chunks.jsonl')
    await writeFile(chunksPath, `${await readFile(chunksPath, 'utf8')}corruption`)
    await expect(loadKnowledgeIndex(occupied)).rejects.toThrow('chunks.jsonl size does not match manifest')
  })

  it('writes and validates ordinal-aligned little-endian Dense vectors', async () => {
    const outputDir = join(await temporaryDirectory(), 'dense-index')
    const encoder = {
      embedDocuments(texts: readonly string[]): Promise<Float32Array> {
        const vectors = new Float32Array(texts.length * DENSE_DIMENSIONS)
        for (const [row, text] of texts.entries()) {
          vectors[row * DENSE_DIMENSIONS + (text.startsWith('Alpha\n') ? 0 : 1)] = 1
        }
        return Promise.resolve(vectors)
      },
    }
    const manifest = await buildKnowledgeIndex({
      corpusText: [
        '{"id":"doc-b","text":"delta"}',
        '{"id":"doc-a","title":"Alpha","text":"alpha beta"}',
      ].join('\n'),
      outputDir,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 2, overlapTokens: 0 },
      bm25K1: 1.2,
      bm25B: 0.75,
      dense: {
        encoder,
        batchSize: 1,
        modelId: 'onnx-community/bge-small-en-v1.5-ONNX',
        revision: '4a9a46c7b88fa408e650a571a1800243f26309bd',
        dtype: 'q8',
      },
    })
    const loaded = await loadKnowledgeIndex(outputDir)

    expect(manifest.payloads.map(payload => payload.path)).toEqual(['chunks.jsonl', 'bm25.json', 'dense.f32le'])
    expect(loaded.dense?.dimensions).toBe(DENSE_DIMENSIONS)
    expect(loaded.dense?.vectors[0]).toBe(1)
    expect(loaded.dense?.vectors[DENSE_DIMENSIONS]).toBe(0)
    expect(loaded.dense?.vectors[DENSE_DIMENSIONS + 1]).toBe(1)

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
    await expect(loadKnowledgeIndex(outputDir)).rejects.toThrow('not L2-normalized')
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
      bm25K1: 1.2,
      bm25B: 0.75,
    })

    expect(manifest.corpus).toMatchObject({ documentCount: 1, chunkCount: 1 })
    await expect(loadKnowledgeIndex(outputDir)).resolves.toMatchObject({
      chunks: [{ documentId: 'doc', title: 'Claim' }],
    })
  })
})
