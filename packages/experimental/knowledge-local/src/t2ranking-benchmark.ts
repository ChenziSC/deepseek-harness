/** Deterministic nested T2Ranking slices for Exact versus HNSW threshold calibration. */

import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { once } from 'node:events'
import { KnowledgeDocumentId } from '@deepseek-ai/dsh-experimental-knowledge'
import { chunkDocuments } from './chunker.ts'
import { CorpusFormatError, parseCorpusDocumentLine } from './corpus.ts'
import type { ChunkTokenizer } from './tokenizer.ts'
import { prepareEmptyDirectory } from './filesystem.ts'

/** Token limit used by the threshold-calibration corpus. */
const T2RANKING_BENCHMARK_MAX_TOKENS = 384
/** Token overlap used by the threshold-calibration corpus. */
const T2RANKING_BENCHMARK_OVERLAP_TOKENS = 64
/** Default nested chunk-count targets around the initial Exact/HNSW threshold. */
export const DEFAULT_T2RANKING_CHUNK_TARGETS = [10_000, 25_000, 50_000, 100_000] as const

/** Inputs for constructing nested T2Ranking threshold-calibration slices. */
export interface T2RankingBenchmarkOptions {
  readonly collectionPath: string
  readonly queriesPath: string
  readonly qrelsPath: string
  readonly bm25Path: string
  readonly tokenizer: ChunkTokenizer
  readonly outputDir: string
  readonly queryLimit?: number
  readonly chunkTargets?: readonly number[]
}

/** One completed nested T2Ranking slice. */
interface T2RankingBenchmarkSlice {
  readonly chunkTarget: number
  readonly chunkCount: number
  readonly documentCount: number
  readonly directory: string
}

/** Summary of one deterministic slice-construction run. */
export interface T2RankingBenchmarkResult {
  readonly queryCount: number
  readonly slices: readonly T2RankingBenchmarkSlice[]
}

interface Query {
  readonly id: string
  readonly text: string
}

interface CandidateReason {
  readonly kind: 'positive' | 'bm25'
  readonly queryId: string
  readonly rank?: number
}

interface Candidate {
  readonly sourcePid: string
  readonly reason: CandidateReason
}

interface LoadedDocument extends Candidate {
  readonly text: string
}

interface SelectedDocument extends LoadedDocument {
  readonly chunkCount: number
}

interface SourceFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

interface WrittenFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

function twoColumnRow(
  value: string,
  source: string,
  line: number,
  leftName: string,
  rightName: string,
): readonly [string, string] | undefined {
  const row = value.replace(/\r$/u, '')
  if (row.trim().length === 0) return undefined
  const cells = row.split('\t')
  if (cells.length !== 2) {
    throw new CorpusFormatError(source, line, `expected ${leftName} and ${rightName} separated by one tab`)
  }
  return [requiredCell(cells[0], leftName, source, line), requiredCell(cells[1], rightName, source, line)]
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`knowledge-local: ${name} must be a positive safe integer`)
  }
  return value
}

function resolveTargets(targets: readonly number[] | undefined): number[] {
  const resolved = [...(targets ?? DEFAULT_T2RANKING_CHUNK_TARGETS)]
  if (resolved.length === 0) throw new TypeError('knowledge-local: chunkTargets must not be empty')
  resolved.forEach(target => positiveSafeInteger(target, 'chunk target'))
  resolved.sort((left, right) => left - right)
  if (resolved.some((target, index) => index > 0 && target === resolved[index - 1])) {
    throw new TypeError('knowledge-local: chunkTargets must be unique')
  }
  return resolved
}

function requiredCell(value: string | undefined, field: string, source: string, line: number): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CorpusFormatError(source, line, `${field} must be a non-empty string`)
  }
  return value
}

async function sourceText(path: string): Promise<{ readonly text: string; readonly source: SourceFile }> {
  const data = await readFile(path)
  return {
    text: data.toString('utf8'),
    source: { path, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') },
  }
}

function judgedQueryIds(text: string, source: string): ReadonlySet<string> {
  const rows = text.split('\n')
  if (rows[0]?.replace(/\r$/u, '') !== 'qid\tpid') {
    throw new CorpusFormatError(source, 1, 'expected header qid, pid')
  }
  const ids = new Set<string>()
  for (let index = 1; index < rows.length; index += 1) {
    const cells = twoColumnRow(rows[index] as string, source, index + 1, 'qid', 'pid')
    if (cells !== undefined) ids.add(cells[0])
  }
  return ids
}

function selectQueries(text: string, source: string, judgedIds: ReadonlySet<string>, limit: number): Query[] {
  const rows = text.split('\n')
  if (rows[0]?.replace(/\r$/u, '') !== 'qid\ttext') {
    throw new CorpusFormatError(source, 1, 'expected header qid, text')
  }
  const queries: Query[] = []
  const ids = new Set<string>()
  for (let index = 1; index < rows.length && queries.length < limit; index += 1) {
    const row = (rows[index] as string).replace(/\r$/u, '')
    if (row.trim().length === 0) continue
    const separator = row.indexOf('\t')
    if (separator < 1) throw new CorpusFormatError(source, index + 1, 'expected qid and text separated by one tab')
    const id = requiredCell(row.slice(0, separator), 'qid', source, index + 1)
    if (ids.has(id)) throw new CorpusFormatError(source, index + 1, `duplicate query id ${JSON.stringify(id)}`)
    ids.add(id)
    if (!judgedIds.has(id)) continue
    queries.push({ id, text: requiredCell(row.slice(separator + 1), 'text', source, index + 1) })
  }
  if (queries.length === 0) throw new CorpusFormatError(source, 1, 'no queries were selected')
  return queries
}

function selectPositivePids(
  text: string,
  source: string,
  queries: readonly Query[],
): ReadonlyMap<string, readonly string[]> {
  const rows = text.split('\n')
  /* v8 ignore next -- judgedQueryIds validates the same qrels header before this function runs. */
  if (rows[0]?.replace(/\r$/u, '') !== 'qid\tpid') {
    throw new CorpusFormatError(source, 1, 'expected header qid, pid')
  }
  const selected = new Set(queries.map(query => query.id))
  const positives = new Map(queries.map(query => [query.id, [] as string[]]))
  const pairs = new Set<string>()
  for (let index = 1; index < rows.length; index += 1) {
    /* v8 ignore next -- judgedQueryIds validates every non-empty row in this same qrels file. */
    const cells = twoColumnRow(rows[index] as string, source, index + 1, 'qid', 'pid')
    if (cells === undefined) continue
    const [queryId, pid] = cells
    if (!selected.has(queryId)) continue
    const pair = `${queryId}\u0000${pid}`
    if (pairs.has(pair)) throw new CorpusFormatError(source, index + 1, 'duplicate query and passage judgment')
    pairs.add(pair)
    ;(positives.get(queryId) as string[]).push(pid)
  }
  for (const query of queries) {
    /* v8 ignore next -- query selection is derived from this same qrels file. */
    if ((positives.get(query.id) as string[]).length === 0) {
      throw new CorpusFormatError(source, 1, `query ${JSON.stringify(query.id)} has no positive judgment`)
    }
  }
  return positives
}

async function* lines(path: string, digest: Hash): AsyncGenerator<{ readonly line: number; readonly text: string }> {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let line = 0
  for await (const value of createReadStream(path)) {
    const chunk = Buffer.from(value as Uint8Array)
    digest.update(chunk)
    pending += decoder.write(chunk)
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      line += 1
      yield { line, text: pending.slice(0, newline).replace(/\r$/u, '') }
      pending = pending.slice(newline + 1)
    }
  }
  pending += decoder.end()
  if (pending.length > 0) yield { line: line + 1, text: pending.replace(/\r$/u, '') }
}

async function bm25Candidates(
  path: string,
  queries: readonly Query[],
): Promise<{ readonly candidates: readonly Candidate[]; readonly source: SourceFile }> {
  const digest = createHash('sha256')
  const queryIds = new Set(queries.map(query => query.id))
  const byQuery = new Map(queries.map(query => [query.id, new Map<number, string>()]))
  const selectedRanks = new Set<number>()
  for await (const input of lines(path, digest)) {
    if (input.text.trim().length === 0) continue
    const cells = input.text.split('\t')
    if (cells.length !== 3) throw new CorpusFormatError(path, input.line, 'expected qid, pid, and rank separated by tabs')
    const queryId = requiredCell(cells[0], 'qid', path, input.line)
    const pid = requiredCell(cells[1], 'pid', path, input.line)
    const rank = Number(cells[2])
    if (!Number.isSafeInteger(rank) || rank < 1) throw new CorpusFormatError(path, input.line, 'rank must be a positive safe integer')
    if (!queryIds.has(queryId)) continue
    const ranks = byQuery.get(queryId) as Map<number, string>
    if (ranks.has(rank)) throw new CorpusFormatError(path, input.line, `duplicate rank ${rank} for query ${JSON.stringify(queryId)}`)
    ranks.set(rank, pid)
    selectedRanks.add(rank)
  }
  const candidates: Candidate[] = []
  for (const rank of [...selectedRanks].sort((left, right) => left - right)) {
    for (const query of queries) {
      const pid = byQuery.get(query.id)?.get(rank)
      if (pid !== undefined) candidates.push({ sourcePid: pid, reason: { kind: 'bm25', queryId: query.id, rank } })
    }
  }
  const metadata = await stat(path)
  return { candidates, source: { path, bytes: metadata.size, sha256: digest.digest('hex') } }
}

function orderedCandidates(
  queries: readonly Query[],
  positives: ReadonlyMap<string, readonly string[]>,
  bm25: readonly Candidate[],
): Candidate[] {
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  for (const query of queries) {
    for (const pid of positives.get(query.id) as readonly string[]) {
      if (seen.has(pid)) continue
      seen.add(pid)
      candidates.push({ sourcePid: pid, reason: { kind: 'positive', queryId: query.id } })
    }
  }
  for (const candidate of bm25) {
    if (seen.has(candidate.sourcePid)) continue
    seen.add(candidate.sourcePid)
    candidates.push(candidate)
  }
  return candidates
}

async function loadCandidateDocuments(
  path: string,
  candidates: readonly Candidate[],
): Promise<{ readonly documents: ReadonlyMap<string, LoadedDocument>; readonly source: SourceFile }> {
  const wanted = new Map(candidates.map(candidate => [candidate.sourcePid, candidate]))
  const documents = new Map<string, LoadedDocument>()
  const digest = createHash('sha256')
  let header = false
  for await (const input of lines(path, digest)) {
    if (input.line === 1) {
      if (input.text !== 'pid\ttext') throw new CorpusFormatError(path, 1, 'expected header pid, text')
      header = true
      continue
    }
    if (input.text.trim().length === 0) continue
    const separator = input.text.indexOf('\t')
    const pid = separator < 0 ? '' : input.text.slice(0, separator)
    const candidate = wanted.get(pid)
    if (candidate === undefined) continue
    if (documents.has(pid)) throw new CorpusFormatError(path, input.line, `duplicate passage id ${JSON.stringify(pid)}`)
    const document = parseCorpusDocumentLine(input.text, 't2ranking', path, input.line)
    documents.set(pid, { ...candidate, text: document.text })
  }
  /* v8 ignore next -- the first iteration handles every non-empty collection stream. */
  if (!header) throw new CorpusFormatError(path, 1, 'expected header pid, text')
  const metadata = await stat(path)
  return { documents, source: { path, bytes: metadata.size, sha256: digest.digest('hex') } }
}

function sliceDocuments(
  candidates: readonly Candidate[],
  documents: ReadonlyMap<string, LoadedDocument>,
  targets: readonly number[],
  collectionPath: string,
  tokenizer: ChunkTokenizer,
): Array<{ readonly target: number; readonly chunkCount: number; readonly documents: readonly SelectedDocument[] }> {
  const slices: Array<{ target: number; chunkCount: number; documents: readonly SelectedDocument[] }> = []
  const selected: SelectedDocument[] = []
  let chunkCount = 0
  let candidateIndex = 0
  for (const target of targets) {
    const minimumDocuments = slices.length === 0 ? 1 : (slices.at(-1)?.documents.length as number) + 1
    while (chunkCount < target || selected.length < minimumDocuments) {
      const candidate = candidates[candidateIndex]
      if (candidate === undefined) {
        throw new Error(`knowledge-local: BM25 candidates provide only ${chunkCount} chunks, below target ${target}`)
      }
      candidateIndex += 1
      const document = documents.get(candidate.sourcePid)
      if (document === undefined) {
        throw new CorpusFormatError(collectionPath, 1, `missing selected passage ${JSON.stringify(candidate.sourcePid)}`)
      }
      const documentChunkCount = chunkDocuments([{
        id: KnowledgeDocumentId(syntheticPid(selected.length, 6)),
        text: document.text,
      }], tokenizer, {
        maxTokens: T2RANKING_BENCHMARK_MAX_TOKENS,
        overlapTokens: T2RANKING_BENCHMARK_OVERLAP_TOKENS,
      }).length
      selected.push({ ...document, chunkCount: documentChunkCount })
      chunkCount += documentChunkCount
    }
    slices.push({ target, chunkCount, documents: [...selected] })
  }
  return slices
}

async function writeLines(path: string, rows: Iterable<string>): Promise<WrittenFile> {
  const output = createWriteStream(path, { encoding: 'utf8' })
  const digest = createHash('sha256')
  let bytes = 0
  for (const row of rows) {
    const data = `${row}\n`
    bytes += Buffer.byteLength(data)
    digest.update(data)
    if (!output.write(data)) await once(output, 'drain')
  }
  output.end()
  await finished(output)
  return { path: basename(path), bytes, sha256: digest.digest('hex') }
}

function syntheticPid(index: number, width: number): string {
  return `d${index.toString().padStart(width, '0')}`
}

function* corpusRows(documents: readonly SelectedDocument[], pidWidth: number): Generator<string> {
  yield 'pid\ttext'
  for (const [index, document] of documents.entries()) {
    yield `${syntheticPid(index, pidWidth)}\t${document.text}`
  }
}

function* queryRows(queries: readonly Query[]): Generator<string> {
  yield 'qid\ttext'
  for (const query of queries) yield `${query.id}\t${query.text}`
}

function* qrelsRows(
  queries: readonly Query[],
  positives: ReadonlyMap<string, readonly string[]>,
  pidBySource: ReadonlyMap<string, string>,
): Generator<string> {
  yield 'qid\tpid'
  for (const query of queries) {
    for (const sourcePid of positives.get(query.id) as readonly string[]) {
      const pid = pidBySource.get(sourcePid)
      /* v8 ignore next -- positive documents are the first globally selected candidates. */
      if (pid === undefined) throw new Error(`knowledge-local: positive passage is absent from slice: ${sourcePid}`)
      yield `${query.id}\t${pid}`
    }
  }
}

function* selectionRows(documents: readonly SelectedDocument[], pidWidth: number): Generator<string> {
  let cumulativeChunkCount = 0
  for (const [index, document] of documents.entries()) {
    cumulativeChunkCount += document.chunkCount
    yield JSON.stringify({
      ordinal: index,
      pid: syntheticPid(index, pidWidth),
      sourcePid: document.sourcePid,
      chunkCount: document.chunkCount,
      cumulativeChunkCount,
      ...document.reason,
    })
  }
}

async function writeSlice(
  outputDir: string,
  slice: { readonly target: number; readonly chunkCount: number; readonly documents: readonly SelectedDocument[] },
  queries: readonly Query[],
  positives: ReadonlyMap<string, readonly string[]>,
  sources: readonly SourceFile[],
  pidWidth: number,
): Promise<T2RankingBenchmarkSlice> {
  const directory = join(outputDir, `chunks-${slice.target}`)
  await mkdir(directory)
  const pidBySource = new Map(slice.documents.map((document, index) => [document.sourcePid, syntheticPid(index, pidWidth)]))
  const corpus = await writeLines(join(directory, 'corpus.tsv'), corpusRows(slice.documents, pidWidth))
  const queryFile = await writeLines(join(directory, 'queries.tsv'), queryRows(queries))
  const qrels = await writeLines(join(directory, 'qrels.tsv'), qrelsRows(queries, positives, pidBySource))
  const selection = await writeLines(join(directory, 'selection.jsonl'), selectionRows(slice.documents, pidWidth))
  const source = {
    dataset: 't2ranking',
    kind: 'exact-hnsw-threshold-calibration-slice',
    selection: 'all positives, then globally deduplicated BM25 passages by ascending rank and fixed query order',
    queryCount: queries.length,
    chunkTarget: slice.target,
    chunkCount: slice.chunkCount,
    documentCount: slice.documents.length,
    chunking: {
      maxTokens: T2RANKING_BENCHMARK_MAX_TOKENS,
      overlapTokens: T2RANKING_BENCHMARK_OVERLAP_TOKENS,
    },
    sources,
    outputs: [corpus, queryFile, qrels, selection],
  }
  await writeFileJson(join(directory, 'source.json'), source)
  return { chunkTarget: slice.target, chunkCount: slice.chunkCount, documentCount: slice.documents.length, directory }
}

async function writeFileJson(path: string, value: unknown): Promise<void> {
  const output = createWriteStream(path, { encoding: 'utf8' })
  output.end(`${JSON.stringify(value, undefined, 2)}\n`)
  await finished(output)
}

/**
 * Construct deterministic nested T2Ranking slices without loading the full collection into memory.
 * @param options - source files, tokenizer, output directory, and optional query and chunk limits.
 * @returns selected query count and one summary per ascending chunk target.
 */
export async function buildT2RankingBenchmarkSlices(
  options: T2RankingBenchmarkOptions,
): Promise<T2RankingBenchmarkResult> {
  const queryLimit = positiveSafeInteger(options.queryLimit ?? 100, 'queryLimit')
  const targets = resolveTargets(options.chunkTargets)
  await prepareEmptyDirectory(
    options.outputDir,
    `knowledge-local: output directory is not empty: ${options.outputDir}`,
  )
  const queryInput = await sourceText(options.queriesPath)
  const qrelsInput = await sourceText(options.qrelsPath)
  const queries = selectQueries(
    queryInput.text,
    options.queriesPath,
    judgedQueryIds(qrelsInput.text, options.qrelsPath),
    queryLimit,
  )
  const positives = selectPositivePids(qrelsInput.text, options.qrelsPath, queries)
  const bm25 = await bm25Candidates(options.bm25Path, queries)
  const candidates = orderedCandidates(queries, positives, bm25.candidates)
  const collection = await loadCandidateDocuments(options.collectionPath, candidates)
  const selectedSlices = sliceDocuments(candidates, collection.documents, targets, options.collectionPath, options.tokenizer)
  const sources = [collection.source, queryInput.source, qrelsInput.source, bm25.source]
  const largestDocumentCount = selectedSlices.at(-1)?.documents.length as number
  const pidWidth = Math.max(6, String(largestDocumentCount - 1).length)
  const slices: T2RankingBenchmarkSlice[] = []
  for (const slice of selectedSlices) {
    slices.push(await writeSlice(options.outputDir, slice, queries, positives, sources, pidWidth))
  }
  return { queryCount: queries.length, slices }
}
