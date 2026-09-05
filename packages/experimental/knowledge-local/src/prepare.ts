/** Explicit dataset and local model preparation for offline experiments. */

import { createHash } from 'node:crypto'
import { mkdir, open, readdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compareCodePoints } from './bm25.ts'
import { parseCorpusJsonl, parseSciFactQrelsTsv, parseSciFactQueriesJsonl } from './corpus.ts'
import { loadDenseEncoder } from './model-runtime.ts'
import {
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  loadReranker,
} from './reranker.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION } from './tokenizer.ts'

/** Fixed BEIR SciFact archive URL. */
export const SCIFACT_URL = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip'
/** MD5 digest published by BEIR for the SciFact archive. */
export const SCIFACT_MD5 = '5f7d1de60b170fc8027bb7898e2efca1'
/** Immutable MLDR dataset revision used by the phase-two benchmark. */
export const MLDR_REVISION = 'd67138e705d963e346253a80e59676ddb418810a'
/** Immutable T2Ranking dataset revision used by the phase-two benchmark. */
export const T2RANKING_REVISION = '2a369a430a70979223f1b9a41b1919774d46b432'
/** Immutable MTEB MLQA Retrieval revision used by the cross-language benchmark. */
export const MLQA_RETRIEVAL_REVISION = 'cf59ddd8f4aaf39ce1869361e09252698c340945'
/** Default Hugging Face endpoint used by dataset preparation. */
export const HUGGING_FACE_ENDPOINT = 'https://huggingface.co'

/** Successful local preparation summary. */
export interface PrepareResult {
  readonly datasetDir: string
  readonly archiveMd5: string
  readonly archiveSha256: string
  readonly models: ReadonlyArray<{ readonly modelId: string; readonly revision: string }>
}

/** Dependencies replaceable by keyless preparation tests. */
export interface PrepareDependencies {
  readonly download: (url: string) => Promise<Uint8Array>
  readonly prepareDenseModel: (cacheDir: string) => Promise<void>
  readonly prepareRerankerModel: (cacheDir: string) => Promise<void>
}

/** Digest and provenance for one downloaded benchmark file. */
export interface PreparedDatasetFile {
  readonly path: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

/** Machine-readable provenance emitted by a large-dataset preparation. */
export interface PreparedDataset {
  readonly dataset: 'mldr-en' | 'mldr-zh' | 't2ranking' | 'mlqa-eng-zho'
  readonly revision: string
  readonly license: 'MIT' | 'Apache-2.0' | 'CC-BY-SA-3.0'
  readonly datasetDir: string
  readonly files: readonly PreparedDatasetFile[]
  readonly outputs?: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly sha256: string }>
}

/** Streaming downloader dependency used by large-dataset preparation tests. */
export type DatasetDownloader = (url: string, path: string) => Promise<Omit<PreparedDatasetFile, 'path' | 'url'>>

function digest(algorithm: 'md5' | 'sha256', data: Uint8Array): string {
  return createHash(algorithm).update(data).digest('hex')
}

function archivePath(root: string, entry: string): string {
  if (entry.includes('\\') || isAbsolute(entry) || /^[A-Za-z]:/u.test(entry)) {
    throw new TypeError(`knowledge-local: unsafe SciFact archive path ${JSON.stringify(entry)}`)
  }
  const segments = entry.split('/').filter(segment => segment.length > 0)
  if (segments.length === 0 || segments.some(segment => segment === '..' || segment === '.')) {
    throw new TypeError(`knowledge-local: unsafe SciFact archive path ${JSON.stringify(entry)}`)
  }
  const target = resolve(root, ...segments)
  const prefix = `${resolve(root)}${sep}`
  /* v8 ignore next -- sanitized relative segments cannot escape the resolved root. */
  if (!target.startsWith(prefix)) throw new TypeError(`knowledge-local: unsafe SciFact archive path ${JSON.stringify(entry)}`)
  return target
}

/**
 * Extract one verified SciFact archive while rejecting path traversal.
 * @param archive - complete ZIP archive bytes.
 * @param dataDir - destination parent directory.
 */
export async function extractSciFactArchive(archive: Uint8Array, dataDir: string): Promise<void> {
  const files = unzipSync(archive)
  for (const [entry, data] of Object.entries(files)) {
    const target = archivePath(dataDir, entry)
    if (entry.endsWith('/')) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, data)
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`knowledge-local: download failed with HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function prepareEmptyDirectory(path: string): Promise<void> {
  try {
    if ((await readdir(path)).length > 0) throw new TypeError(`knowledge-local: dataset directory is not empty: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(path, { recursive: true })
  }
}

/**
 * Download one dataset file without buffering it in memory.
 * @param url - immutable source URL.
 * @param path - new destination file.
 * @returns downloaded byte count and SHA-256.
 */
export async function downloadDatasetFile(
  url: string,
  path: string,
): Promise<Omit<PreparedDatasetFile, 'path' | 'url'>> {
  const response = await fetch(url)
  if (!response.ok || response.body === null) {
    throw new Error(`knowledge-local: download failed with HTTP ${response.status}`)
  }
  const file = await open(path, 'wx')
  const digest = createHash('sha256')
  let bytes = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      digest.update(result.value)
      bytes += result.value.byteLength
      await file.write(result.value)
    }
  } catch (error) {
    await file.close()
    await unlink(path).catch(() => undefined)
    throw error
  }
  await file.close()
  return { bytes, sha256: digest.digest('hex') }
}

function datasetUrl(endpoint: string, repository: string, revision: string, path: string): string {
  return `${endpoint.replace(/\/$/u, '')}/datasets/${repository}/resolve/${revision}/${path}`
}

async function prepareDataset(
  dataDir: string,
  dataset: PreparedDataset['dataset'],
  revision: string,
  license: PreparedDataset['license'],
  sources: ReadonlyArray<{ readonly repository: string; readonly sourcePath: string; readonly outputPath: string }>,
  endpoint: string,
  downloader: DatasetDownloader,
): Promise<PreparedDataset> {
  if (dataDir.trim().length === 0) throw new TypeError('knowledge-local: dataDir must be non-empty')
  if (endpoint.trim().length === 0) throw new TypeError('knowledge-local: endpoint must be non-empty')
  const datasetDir = join(dataDir, dataset)
  await prepareEmptyDirectory(datasetDir)
  const files: PreparedDatasetFile[] = []
  for (const source of sources) {
    const url = datasetUrl(endpoint, source.repository, revision, source.sourcePath)
    const metadata = await downloader(url, join(datasetDir, source.outputPath))
    files.push({ path: source.outputPath, url, ...metadata })
  }
  const result = { dataset, revision, license, datasetDir, files } satisfies PreparedDataset
  await writeFile(join(datasetDir, 'source.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  return result
}

/**
 * Prepare one fixed-revision MLDR language split.
 * @param dataDir - destination parent directory.
 * @param language - English or Chinese dataset split.
 * @param endpoint - Hugging Face endpoint.
 * @param downloader - streaming dataset downloader.
 * @returns prepared dataset paths, digests, and provenance.
 */
export function prepareMldr(
  dataDir: string,
  language: 'en' | 'zh',
  endpoint = HUGGING_FACE_ENDPOINT,
  downloader: DatasetDownloader = downloadDatasetFile,
): Promise<PreparedDataset> {
  const prefix = `mldr-v1.0-${language}`
  return prepareDataset(dataDir, `mldr-${language}`, MLDR_REVISION, 'MIT', [
    { repository: 'Shitao/MLDR', sourcePath: `${prefix}/corpus.jsonl.gz`, outputPath: 'corpus.jsonl.gz' },
    { repository: 'Shitao/MLDR', sourcePath: `${prefix}/dev.jsonl.gz`, outputPath: 'queries.jsonl.gz' },
    { repository: 'Shitao/MLDR', sourcePath: `qrels/qrels.${prefix}-dev.tsv`, outputPath: 'qrels.tsv' },
  ], endpoint, downloader)
}

/**
 * Prepare the fixed-revision T2Ranking retrieval development files.
 * @param dataDir - destination parent directory.
 * @param endpoint - Hugging Face endpoint.
 * @param downloader - streaming dataset downloader.
 * @returns prepared dataset paths, digests, and provenance.
 */
export function prepareT2Ranking(
  dataDir: string,
  endpoint = HUGGING_FACE_ENDPOINT,
  downloader: DatasetDownloader = downloadDatasetFile,
): Promise<PreparedDataset> {
  return prepareDataset(dataDir, 't2ranking', T2RANKING_REVISION, 'Apache-2.0', [
    { repository: 'THUIR/T2Ranking', sourcePath: 'data/collection.tsv', outputPath: 'collection.tsv' },
    { repository: 'THUIR/T2Ranking', sourcePath: 'data/queries.dev.tsv', outputPath: 'queries.dev.tsv' },
    { repository: 'THUIR/T2Ranking', sourcePath: 'data/qrels.retrieval.dev.tsv', outputPath: 'qrels.retrieval.dev.tsv' },
  ], endpoint, downloader)
}

function parquetRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`knowledge-local: ${label} row must be an object`)
  }
  return value as Record<string, unknown>
}

function parquetString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`knowledge-local: ${label} must be a non-empty string`)
  }
  return value
}

/**
 * Convert MLQA Retrieval parquet rows into the package's strict corpus, query, and qrels formats.
 * @param corpusRows - decoded corpus parquet rows.
 * @param queryRows - decoded query parquet rows.
 * @param qrelRows - decoded relevance parquet rows.
 * @returns validated text payloads for indexing and evaluation.
 */
export function convertMlqaRetrievalRows(
  corpusRows: readonly unknown[],
  queryRows: readonly unknown[],
  qrelRows: readonly unknown[],
): { readonly corpusText: string; readonly queriesText: string; readonly qrelsText: string } {
  const documents = corpusRows.map((row, index) => {
    const value = parquetRecord(row, `MLQA corpus[${index}]`)
    const id = parquetString(value['id'], `MLQA corpus[${index}].id`)
    const text = parquetString(value['text'], `MLQA corpus[${index}].text`)
    const title = value['title']
    if (typeof title !== 'string') throw new TypeError(`knowledge-local: MLQA corpus[${index}].title must be a string`)
    return { id, text, ...(title.length === 0 ? {} : { title }) }
  }).sort((left, right) => compareCodePoints(left.id, right.id))
  const queries = queryRows.map((row, index) => {
    const value = parquetRecord(row, `MLQA queries[${index}]`)
    return {
      id: parquetString(value['id'], `MLQA queries[${index}].id`),
      text: parquetString(value['text'], `MLQA queries[${index}].text`),
    }
  }).sort((left, right) => compareCodePoints(left.id, right.id))
  const qrels = qrelRows.map((row, index) => {
    const value = parquetRecord(row, `MLQA qrels[${index}]`)
    const rawScore = value['score']
    const score = typeof rawScore === 'bigint' ? Number(rawScore) : rawScore
    if (typeof score !== 'number' || !Number.isSafeInteger(score)) {
      throw new TypeError(`knowledge-local: MLQA qrels[${index}].score must be a safe integer`)
    }
    return {
      queryId: parquetString(value['query-id'], `MLQA qrels[${index}].query-id`),
      documentId: parquetString(value['corpus-id'], `MLQA qrels[${index}].corpus-id`),
      score,
    }
  }).sort((left, right) => compareCodePoints(left.queryId, right.queryId)
    || compareCodePoints(left.documentId, right.documentId))
  const corpusText = `${documents.map(document => JSON.stringify(document)).join('\n')}\n`
  const queriesText = `${queries.map(query => JSON.stringify({ _id: query.id, text: query.text })).join('\n')}\n`
  const qrelsText = `query-id\tcorpus-id\tscore\n${qrels.map(qrel => `${qrel.queryId}\t${qrel.documentId}\t${qrel.score}`).join('\n')}\n`
  const parsedDocuments = parseCorpusJsonl(corpusText, 'mlqa-eng-zho/corpus.jsonl')
  const parsedQueries = parseSciFactQueriesJsonl(queriesText, 'mlqa-eng-zho/queries.jsonl')
  parseSciFactQrelsTsv(qrelsText, parsedQueries, parsedDocuments, 'mlqa-eng-zho/qrels.tsv')
  return { corpusText, queriesText, qrelsText }
}

async function derivedFile(path: string, text: string): Promise<{ bytes: number; sha256: string }> {
  const data = Buffer.from(text)
  await writeFile(path, data, { flag: 'wx' })
  return { bytes: data.byteLength, sha256: digest('sha256', data) }
}

/**
 * Prepare MLQA Retrieval English corpus and Chinese test queries.
 * @param dataDir - destination parent directory.
 * @param endpoint - Hugging Face endpoint.
 * @param downloader - streaming dataset downloader.
 * @returns prepared dataset paths, digests, provenance, and converted files.
 */
export async function prepareMlqaEngZho(
  dataDir: string,
  endpoint = HUGGING_FACE_ENDPOINT,
  downloader: DatasetDownloader = downloadDatasetFile,
): Promise<PreparedDataset> {
  const result = await prepareDataset(dataDir, 'mlqa-eng-zho', MLQA_RETRIEVAL_REVISION, 'CC-BY-SA-3.0', [
    { repository: 'mteb/MLQARetrieval', sourcePath: 'eng-zho-corpus/test-00000-of-00001.parquet', outputPath: 'corpus.parquet' },
    { repository: 'mteb/MLQARetrieval', sourcePath: 'eng-zho-queries/test-00000-of-00001.parquet', outputPath: 'queries.parquet' },
    { repository: 'mteb/MLQARetrieval', sourcePath: 'eng-zho-qrels/test-00000-of-00001.parquet', outputPath: 'qrels.parquet' },
  ], endpoint, downloader)
  const readRows = async (path: string): Promise<Record<string, unknown>[]> => {
    const file = await asyncBufferFromFile(join(result.datasetDir, path))
    return parquetReadObjects({ file }) as Promise<Record<string, unknown>[]>
  }
  const corpusRows = await readRows('corpus.parquet')
  const queryRows = await readRows('queries.parquet')
  const qrelRows = await readRows('qrels.parquet')
  const converted = convertMlqaRetrievalRows(corpusRows, queryRows, qrelRows)
  const outputs = await Promise.all([
    derivedFile(join(result.datasetDir, 'corpus.jsonl'), converted.corpusText).then(metadata => ({ path: 'corpus.jsonl', ...metadata })),
    derivedFile(join(result.datasetDir, 'queries.jsonl'), converted.queriesText).then(metadata => ({ path: 'queries.jsonl', ...metadata })),
    derivedFile(join(result.datasetDir, 'qrels.tsv'), converted.qrelsText).then(metadata => ({ path: 'qrels.tsv', ...metadata })),
  ])
  const completed: PreparedDataset = { ...result, outputs }
  await writeFile(join(result.datasetDir, 'source.json'), `${JSON.stringify(completed, null, 2)}\n`)
  return completed
}

async function prepareDenseModel(cacheDir: string): Promise<void> {
  const encoder = await loadDenseEncoder({ cacheDir, localFilesOnly: false })
  await encoder.dispose()
}

async function prepareRerankerModel(cacheDir: string): Promise<void> {
  const reranker = await loadReranker({ cacheDir, localFilesOnly: false })
  await reranker.dispose()
}

const DEFAULT_DEPENDENCIES: PrepareDependencies = {
  download,
  prepareDenseModel,
  prepareRerankerModel,
}

/**
 * Download and verify SciFact, then populate the explicit Transformers.js cache.
 * @param dataDir - destination parent for the extracted `scifact` directory.
 * @param modelCacheDir - explicit cache shared by both fixed model revisions.
 * @param dependencies - replaceable network and model operations for tests.
 * @returns verified dataset digests and prepared model identities.
 */
export async function prepareSciFact(
  dataDir: string,
  modelCacheDir: string,
  dependencies: PrepareDependencies = DEFAULT_DEPENDENCIES,
): Promise<PrepareResult> {
  if (dataDir.trim().length === 0) throw new TypeError('knowledge-local: dataDir must be non-empty')
  if (modelCacheDir.trim().length === 0) throw new TypeError('knowledge-local: modelCacheDir must be non-empty')
  const archive = await dependencies.download(SCIFACT_URL)
  const archiveMd5 = digest('md5', archive)
  if (archiveMd5 !== SCIFACT_MD5) {
    throw new TypeError(`knowledge-local: SciFact archive MD5 mismatch: expected ${SCIFACT_MD5}, received ${archiveMd5}`)
  }
  const archiveSha256 = digest('sha256', archive)
  await extractSciFactArchive(archive, dataDir)
  await dependencies.prepareDenseModel(modelCacheDir)
  await dependencies.prepareRerankerModel(modelCacheDir)
  return {
    datasetDir: join(dataDir, 'scifact'),
    archiveMd5,
    archiveSha256,
    models: [
      { modelId: BGE_M3_MODEL_ID, revision: BGE_M3_REVISION },
      { modelId: BGE_RERANKER_MODEL_ID, revision: BGE_RERANKER_REVISION },
    ],
  }
}
