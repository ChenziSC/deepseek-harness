/** Offline construction of immutable local knowledge indexes. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildBm25Index } from './bm25.ts'
import { chunkDocuments, type ChunkingOptions } from './chunker.ts'
import { parseCorpusJsonl, parseSciFactCorpusJsonl } from './corpus.ts'
import { DENSE_DIMENSIONS, validateDenseVectors } from './dense.ts'
import type { DenseIndexManifest, KnowledgeIndexManifest, PayloadManifest } from './index-format.ts'
import type { DenseEncoder } from './model-runtime.ts'
import {
  BGE_SMALL_EN_MODEL_ID,
  BGE_SMALL_EN_REVISION,
  type ChunkTokenizer,
} from './tokenizer.ts'

const CHUNKS_FILE = 'chunks.jsonl'
const BM25_FILE = 'bm25.json'
const DENSE_FILE = 'dense.f32le'
const MANIFEST_FILE = 'manifest.json'

/** Inputs shared by BM25-only and BM25-plus-Dense index builds. */
export interface BuildBm25IndexOptions {
  readonly corpusText: string
  readonly corpusSource?: string
  readonly corpusFormat?: 'generic' | 'scifact'
  readonly outputDir: string
  readonly tokenizer: ChunkTokenizer
  readonly chunking: ChunkingOptions
  readonly bm25K1: number
  readonly bm25B: number
  readonly tokenizerModelId?: string
  readonly tokenizerRevision?: string
}

/** Dense component configuration for one index build. */
export interface BuildDenseIndexOptions {
  readonly encoder: Pick<DenseEncoder, 'embedDocuments'>
  readonly batchSize: number
  readonly modelId: string
  readonly revision: string
  readonly dtype: 'q8'
}

/** Complete local index construction inputs. */
export interface BuildKnowledgeIndexOptions extends BuildBm25IndexOptions {
  readonly dense?: BuildDenseIndexOptions
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function prepareOutputDirectory(outputDir: string): Promise<void> {
  try {
    const entries = await readdir(outputDir)
    if (entries.length > 0) throw new Error(`knowledge-local: output directory is not empty: ${outputDir}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(outputDir, { recursive: true })
  }
}

async function packageVersion(): Promise<string> {
  const text = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const value = JSON.parse(text) as { version?: unknown }
  if (typeof value.version !== 'string') throw new TypeError('knowledge-local: package version is unavailable')
  return value.version
}

async function writePayload(outputDir: string, path: string, data: string | Uint8Array): Promise<PayloadManifest> {
  await writeFile(join(outputDir, path), data, { flag: 'wx' })
  return {
    path,
    bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength,
    sha256: sha256(data),
  }
}

function denseBytes(vectors: Float32Array): Buffer {
  const data = Buffer.allocUnsafe(vectors.length * Float32Array.BYTES_PER_ELEMENT)
  for (let index = 0; index < vectors.length; index += 1) {
    data.writeFloatLE(vectors[index] ?? 0, index * Float32Array.BYTES_PER_ELEMENT)
  }
  return data
}

async function buildDenseVectors(
  texts: readonly string[],
  options: BuildDenseIndexOptions,
): Promise<Float32Array> {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) {
    throw new TypeError('knowledge-local: Dense batchSize must be a positive safe integer')
  }
  if (options.modelId.trim().length === 0) throw new TypeError('knowledge-local: Dense modelId must be non-empty')
  if (!/^[a-f0-9]{40}$/u.test(options.revision)) {
    throw new TypeError('knowledge-local: Dense revision must be a full lowercase commit SHA')
  }
  const vectors = new Float32Array(texts.length * DENSE_DIMENSIONS)
  for (let start = 0; start < texts.length; start += options.batchSize) {
    const batch = texts.slice(start, start + options.batchSize)
    const embedded = await options.encoder.embedDocuments(batch)
    validateDenseVectors(embedded, batch.length, DENSE_DIMENSIONS, 'knowledge-local: Dense build output')
    vectors.set(embedded, start * DENSE_DIMENSIONS)
  }
  return vectors
}

/**
 * Build a complete local index and write the manifest last.
 * @param options - corpus, tokenizer, output, retrieval, and optional Dense settings.
 * @returns the manifest written after all payloads succeed.
 */
export async function buildKnowledgeIndex(options: BuildKnowledgeIndexOptions): Promise<KnowledgeIndexManifest> {
  if (!Number.isFinite(options.bm25K1) || options.bm25K1 <= 0) {
    throw new TypeError('knowledge-local: bm25K1 must be a positive finite number')
  }
  if (!Number.isFinite(options.bm25B) || options.bm25B < 0 || options.bm25B > 1) {
    throw new TypeError('knowledge-local: bm25B must be a finite number from 0 through 1')
  }
  await prepareOutputDirectory(options.outputDir)
  const startedAt = performance.now()
  const documents = options.corpusFormat === 'scifact'
    ? parseSciFactCorpusJsonl(options.corpusText, options.corpusSource)
    : parseCorpusJsonl(options.corpusText, options.corpusSource)
  const chunks = chunkDocuments(documents, options.tokenizer, options.chunking)
  const retrievalTexts = chunks.map(chunk => chunk.title === undefined ? chunk.text : `${chunk.title}\n${chunk.text}`)
  const bm25 = buildBm25Index(retrievalTexts)
  const denseVectors = options.dense === undefined ? undefined : await buildDenseVectors(retrievalTexts, options.dense)
  const chunksText = chunks.map(chunk => `${JSON.stringify(chunk)}\n`).join('')
  const bm25Text = `${JSON.stringify(bm25)}\n`
  const payloads = [
    await writePayload(options.outputDir, CHUNKS_FILE, chunksText),
    await writePayload(options.outputDir, BM25_FILE, bm25Text),
  ]
  if (denseVectors !== undefined) payloads.push(await writePayload(options.outputDir, DENSE_FILE, denseBytes(denseVectors)))
  const dense: DenseIndexManifest | undefined = options.dense === undefined
    ? undefined
    : {
      modelId: options.dense.modelId,
      revision: options.dense.revision,
      dtype: options.dense.dtype,
      pooling: 'cls',
      normalized: true,
      dimensions: DENSE_DIMENSIONS,
    }
  const manifest: KnowledgeIndexManifest = {
    formatVersion: 1,
    createdBy: {
      package: '@deepseek-ai/dsh-experimental-knowledge-local',
      version: await packageVersion(),
    },
    build: { durationMs: performance.now() - startedAt },
    corpus: {
      sha256: sha256(options.corpusText),
      documentCount: documents.length,
      chunkCount: chunks.length,
    },
    chunking: {
      tokenizerModelId: options.tokenizerModelId ?? BGE_SMALL_EN_MODEL_ID,
      tokenizerRevision: options.tokenizerRevision ?? BGE_SMALL_EN_REVISION,
      maxTokens: options.chunking.maxTokens,
      overlapTokens: options.chunking.overlapTokens,
    },
    bm25: { analyzer: 'english-v1', k1: options.bm25K1, b: options.bm25B },
    ...(dense === undefined ? {} : { dense }),
    payloads,
  }
  await writeFile(join(options.outputDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  return manifest
}

/**
 * Build the BM25-only form of the local index.
 * @param options - corpus, tokenizer, output, chunking, and BM25 settings.
 * @returns the manifest written after both BM25 payloads succeed.
 */
export function buildBm25KnowledgeIndex(options: BuildBm25IndexOptions): Promise<KnowledgeIndexManifest> {
  return buildKnowledgeIndex(options)
}
