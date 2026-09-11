#!/usr/bin/env node
/** Build one deterministic, qrels-complete corpus subset for the phase-six contextual-prefix evaluation. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { gunzip as gunzipCallback, createGunzip } from 'node:zlib'
import { parseArgs, promisify } from 'node:util'
import { compareCodePoints } from '../packages/experimental/knowledge-local/src/ordering.ts'
import { chunkDocuments } from '../packages/experimental/knowledge-local/src/chunker.ts'
import {
  parseCorpusDocumentLine,
  corpusDocumentSourceMetadata,
  parseMldrQueriesJsonl,
  parseSciFactQueriesJsonl,
  parseT2RankingQueriesTsv,
  type CorpusDocument,
  type SciFactQuery,
} from '../packages/experimental/knowledge-local/src/corpus.ts'
import { detectContextualAmbiguity } from '../packages/experimental/knowledge-local/src/offline/contextual-prefix/contextual-prefix.ts'
import {
  BGE_M3_MODEL_ID,
  BGE_M3_REVISION,
  loadBgeChunkTokenizer,
} from '../packages/experimental/knowledge-local/src/tokenizer.ts'
import { positiveInteger, prepareOutputDirectory, required } from './rag-contextual-common.ts'

type Dataset = 'scifact' | 'mlqa' | 'mldr' | 't2ranking'

interface Relevance {
  readonly documentId: string
  readonly relevance: number
}

interface CandidateDocument {
  readonly document: CorpusDocument
  readonly chunkCount: number
  readonly ambiguousChunkCount: number
  readonly distractorEligible: boolean
  readonly order: string
}

const gunzip = promisify(gunzipCallback)

function dataset(value: string | undefined): Dataset {
  if (value === 'scifact' || value === 'mlqa' || value === 'mldr' || value === 't2ranking') return value
  throw new TypeError('--dataset must be scifact, mlqa, mldr, or t2ranking')
}

async function readText(path: string): Promise<string> {
  const data = await readFile(path)
  return (path.endsWith('.gz') ? await gunzip(data) : data).toString('utf8')
}

function parseQueries(value: Dataset, text: string, source: string): SciFactQuery[] {
  if (value === 'scifact' || value === 'mlqa') return parseSciFactQueriesJsonl(text, source)
  if (value === 'mldr') return parseMldrQueriesJsonl(text, source)
  return parseT2RankingQueriesTsv(text, source)
}

function parseQrels(value: Dataset, text: string, source: string): ReadonlyMap<string, readonly Relevance[]> {
  const values = new Map<string, Relevance[]>()
  const rows = text.split(/\r?\n/gu)
  const offset = value === 'scifact' || value === 'mlqa' || value === 't2ranking' ? 1 : 0
  for (let index = offset; index < rows.length; index += 1) {
    const row = rows[index] as string
    if (row.trim().length === 0) continue
    const cells = row.split(/\s+/u)
    const queryId = cells[0]
    const documentId = value === 'mldr' ? cells[2] : cells[1]
    const relevance = value === 't2ranking' ? 1 : Number(value === 'mldr' ? cells[3] : cells[2])
    if (queryId === undefined || queryId.length === 0 || documentId === undefined || documentId.length === 0) {
      throw new TypeError(`${source}:${index + 1}: qrels identifiers must be non-empty`)
    }
    if (!Number.isFinite(relevance)) throw new TypeError(`${source}:${index + 1}: relevance must be finite`)
    if (relevance <= 0) continue
    const current = values.get(queryId) ?? []
    if (current.some(entry => entry.documentId === documentId)) {
      throw new TypeError(`${source}:${index + 1}: duplicate query and document judgment`)
    }
    current.push({ documentId, relevance })
    values.set(queryId, current)
  }
  return values
}

function inputStream(path: string): Readable {
  const stream = createReadStream(path)
  return path.endsWith('.gz') ? stream.pipe(createGunzip()) : stream
}

function sampled(id: string, modulus: number): string | undefined {
  const digest = createHash('sha256').update(id).digest('hex')
  return Number.parseInt(digest.slice(0, 8), 16) % modulus === 0 ? digest : undefined
}

function corpusFormat(value: Dataset): 'generic' | 'scifact' | 'mldr' | 't2ranking' {
  return value === 'mlqa' ? 'generic' : value
}

function serializeDocument(document: CorpusDocument): string {
  return JSON.stringify({
    ...corpusDocumentSourceMetadata(document),
    text: document.text,
    ...(document.supersedes === undefined ? {} : { supersedes: document.supersedes }),
  })
}

function serializeQueries(value: Dataset, queries: readonly SciFactQuery[]): string {
  if (value === 't2ranking') return `qid\ttext\n${queries.map(query => `${query.id}\t${query.text}`).join('\n')}\n`
  if (value === 'mldr') return `${queries.map(query => JSON.stringify({
    query_id: query.id,
    query: query.text,
    positive_passages: [],
    negative_passages: [],
  })).join('\n')}\n`
  return `${queries.map(query => JSON.stringify({ _id: query.id, text: query.text, metadata: {} })).join('\n')}\n`
}

function serializeQrels(
  value: Dataset,
  queries: readonly SciFactQuery[],
  qrels: ReadonlyMap<string, readonly Relevance[]>,
): string {
  const rows = queries.flatMap(query => (qrels.get(query.id) as readonly Relevance[]).map((relevance) => {
    if (value === 't2ranking') return `${query.id}\t${relevance.documentId}`
    if (value === 'mldr') return `${query.id}\tQ0\t${relevance.documentId}\t${relevance.relevance}`
    return `${query.id}\t${relevance.documentId}\t${relevance.relevance}`
  }))
  const header = value === 't2ranking'
    ? 'qid\tpid\n'
    : value === 'mldr'
      ? ''
      : 'query-id\tcorpus-id\tscore\n'
  return `${header}${rows.join('\n')}\n`
}

const { values } = parseArgs({
  strict: true,
  allowPositionals: false,
  options: {
    dataset: { type: 'string' },
    corpus: { type: 'string' },
    queries: { type: 'string' },
    qrels: { type: 'string' },
    output: { type: 'string' },
    'model-cache-dir': { type: 'string' },
    'query-limit': { type: 'string', default: '40' },
    'distractor-modulus': { type: 'string' },
    'chunk-limit': { type: 'string', default: '10000' },
  },
})

const selectedDataset = dataset(values.dataset)
const corpusPath = required(values.corpus, 'corpus')
const queriesPath = required(values.queries, 'queries')
const qrelsPath = required(values.qrels, 'qrels')
const outputDir = required(values.output, 'output')
const queryLimit = positiveInteger(values['query-limit'], 'query-limit')
const distractorModulus = positiveInteger(values['distractor-modulus'], 'distractor-modulus')
const chunkLimit = positiveInteger(values['chunk-limit'], 'chunk-limit')
const tokenizer = await loadBgeChunkTokenizer({
  cacheDir: required(values['model-cache-dir'], 'model-cache-dir'),
  localFilesOnly: true,
})
const queryText = await readText(queriesPath)
const qrelsText = await readText(qrelsPath)
const allQueries = parseQueries(selectedDataset, queryText, queriesPath)
const allQrels = parseQrels(selectedDataset, qrelsText, qrelsPath)
const judgedQueries = allQueries.filter(query => allQrels.has(query.id))
if (judgedQueries.length < queryLimit) throw new TypeError(`only ${judgedQueries.length} judged queries are available`)
const allRelevantDocumentIds = new Set([...allQrels.values()].flatMap(values => values.map(value => value.documentId)))
const candidates: CandidateDocument[] = []
const foundRelevant = new Set<string>()
const digest = createHash('sha256')
const stream = inputStream(corpusPath)
stream.on('data', chunk => digest.update(chunk as Buffer))
const lines = createInterface({ input: stream, crlfDelay: Infinity })
let line = 0
let fullDocumentCount = 0
try {
  for await (const text of lines) {
    line += 1
    if (text.trim().length === 0 || (selectedDataset === 't2ranking' && line === 1 && text === 'pid\ttext')) continue
    const document = parseCorpusDocumentLine(text, corpusFormat(selectedDataset), corpusPath, line)
    fullDocumentCount += 1
    const relevantDocument = allRelevantDocumentIds.has(document.id)
    const sampleOrder = sampled(document.id, distractorModulus)
    if (!relevantDocument && sampleOrder === undefined) continue
    const chunks = chunkDocuments([document], tokenizer, {
      maxTokens: 384,
      overlapTokens: 64,
      strategy: 'markdown-structure-v1',
    })
    candidates.push({
      document,
      chunkCount: chunks.length,
      ambiguousChunkCount: chunks.filter(chunk => detectContextualAmbiguity(chunk).candidate).length,
      distractorEligible: sampleOrder !== undefined,
      order: sampleOrder ?? createHash('sha256').update(document.id).digest('hex'),
    })
    if (relevantDocument) foundRelevant.add(document.id)
  }
} finally {
  lines.close()
}
const missing = [...allRelevantDocumentIds].filter(id => !foundRelevant.has(id))
if (missing.length > 0) throw new TypeError(`qrels documents are missing: ${missing.slice(0, 5).join(', ')}`)
const ambiguousDocumentIds = new Set(
  candidates.filter(value => value.ambiguousChunkCount > 0).map(value => value.document.id as string),
)
const queryHasAmbiguousEvidence = (query: SciFactQuery): boolean => (
  (allQrels.get(query.id) as readonly Relevance[]).some(value => ambiguousDocumentIds.has(value.documentId))
)
const ambiguousQueries = judgedQueries.filter(queryHasAmbiguousEvidence)
const ordinaryQueries = judgedQueries.filter(query => !queryHasAmbiguousEvidence(query))
const ambiguousTarget = Math.min(Math.ceil(queryLimit / 2), ambiguousQueries.length)
const selectedQueries = [
  ...ambiguousQueries.slice(0, ambiguousTarget),
  ...ordinaryQueries.slice(0, queryLimit - ambiguousTarget),
]
if (selectedQueries.length < queryLimit) {
  selectedQueries.push(...ambiguousQueries.slice(ambiguousTarget, ambiguousTarget + queryLimit - selectedQueries.length))
}
selectedQueries.sort((left, right) => compareCodePoints(left.id, right.id))
const selectedQrels = new Map(selectedQueries.map(query => [query.id, allQrels.get(query.id) as readonly Relevance[]]))
const requiredDocumentIds = new Set([...selectedQrels.values()].flatMap(values => values.map(value => value.documentId)))
const requiredDocuments = candidates.filter(value => requiredDocumentIds.has(value.document.id))
  .sort((left, right) => compareCodePoints(left.document.id, right.document.id))
const distractors = candidates.filter(value => (
  !requiredDocumentIds.has(value.document.id) && value.distractorEligible
))
  .sort((left, right) => compareCodePoints(left.order, right.order) || compareCodePoints(left.document.id, right.document.id))
const selectedDocuments = [...requiredDocuments]
let chunkCount = requiredDocuments.reduce((sum, value) => sum + value.chunkCount, 0)
if (chunkCount > chunkLimit) throw new TypeError(`required documents produce ${chunkCount} chunks, above limit ${chunkLimit}`)
for (const candidate of distractors) {
  if (chunkCount + candidate.chunkCount > chunkLimit) continue
  selectedDocuments.push(candidate)
  chunkCount += candidate.chunkCount
}
selectedDocuments.sort((left, right) => compareCodePoints(left.document.id, right.document.id))
const ambiguousQueryIds = selectedQueries.filter(query => (
  (selectedQrels.get(query.id) as readonly Relevance[]).some(value => ambiguousDocumentIds.has(value.documentId))
)).map(query => query.id)
await prepareOutputDirectory(outputDir)
const corpusOutput = `${selectedDocuments.map(value => serializeDocument(value.document)).join('\n')}\n`
const queriesOutput = serializeQueries(selectedDataset, selectedQueries)
const qrelsOutput = serializeQrels(selectedDataset, selectedQueries, selectedQrels)
await Promise.all([
  writeFile(join(outputDir, 'corpus.jsonl'), corpusOutput, { flag: 'wx' }),
  writeFile(join(outputDir, selectedDataset === 't2ranking' ? 'queries.tsv' : 'queries.jsonl'), queriesOutput, { flag: 'wx' }),
  writeFile(join(outputDir, 'qrels.tsv'), qrelsOutput, { flag: 'wx' }),
])
const summary = {
  schemaVersion: 1,
  dataset: selectedDataset,
  sourceCorpusSha256: digest.digest('hex'),
  fullDocumentCount,
  queryCount: selectedQueries.length,
  ambiguousQueryCount: ambiguousQueryIds.length,
  relevantDocumentCount: requiredDocuments.length,
  distractorDocumentCount: selectedDocuments.length - requiredDocuments.length,
  documentCount: selectedDocuments.length,
  chunkCount,
  chunkLimit,
  distractorModulus,
  tokenizer: { modelId: BGE_M3_MODEL_ID, revision: BGE_M3_REVISION },
  chunking: { maxTokens: 384, overlapTokens: 64, strategy: 'markdown-structure-v1' },
  queryIds: selectedQueries.map(query => query.id),
  ambiguousQueryIds,
  corpusSha256: createHash('sha256').update(corpusOutput).digest('hex'),
  queriesSha256: createHash('sha256').update(queriesOutput).digest('hex'),
  qrelsSha256: createHash('sha256').update(qrelsOutput).digest('hex'),
}
await writeFile(join(outputDir, 'selection-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
process.stdout.write(`${JSON.stringify({ outputDir, ...summary, queryIds: undefined, ambiguousQueryIds: undefined })}\n`)
