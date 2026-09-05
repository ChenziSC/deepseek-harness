/** Strict JSONL and SciFact input parsing for offline knowledge indexing. */

import {
  KnowledgeDocumentId,
  type KnowledgeDocumentId as KnowledgeDocumentIdType,
} from '@deepseek-ai/dsh-experimental-knowledge'
import { compareCodePoints } from './bm25.ts'

/** One validated source document before chunking. */
export interface CorpusDocument {
  readonly id: KnowledgeDocumentIdType
  readonly text: string
  readonly title?: string
  readonly source?: string
}

/** One validated SciFact query. */
export interface SciFactQuery {
  readonly id: string
  readonly text: string
}

/** One relevant source document and its graded relevance. */
export interface SciFactRelevance {
  readonly documentId: KnowledgeDocumentIdType
  readonly relevance: number
}

/** One SciFact test query with all positive judgments. */
export interface SciFactEvaluationQuery extends SciFactQuery {
  readonly relevantDocuments: readonly SciFactRelevance[]
}

/** Input error carrying the source file and one-based line number. */
export class CorpusFormatError extends Error {
  constructor(source: string, line: number, message: string, options?: ErrorOptions) {
    super(`${source}:${line}: ${message}`, options)
    this.name = 'CorpusFormatError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, source: string, line: number): void {
  const unknown = Object.keys(value).find(field => !allowed.has(field))
  if (unknown !== undefined) throw new CorpusFormatError(source, line, `unknown field ${JSON.stringify(unknown)}`)
}

function parseJsonLine(lineText: string, source: string, line: number): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(lineText) as unknown
  } catch (error) {
    throw new CorpusFormatError(source, line, 'invalid JSON', { cause: error })
  }
  if (!isRecord(value)) throw new CorpusFormatError(source, line, 'expected a JSON object')
  return value
}

/**
 * Parse one corpus JSONL record without retaining earlier documents.
 * @param lineText - one non-blank JSONL line.
 * @param format - accepted generic, SciFact, or MLDR field set.
 * @param source - source label used in diagnostics.
 * @param line - one-based source line number.
 * @returns one validated source document.
 */
export function parseCorpusDocumentLine(
  lineText: string,
  format: 'generic' | 'scifact' | 'mldr' | 't2ranking',
  source: string,
  line: number,
): CorpusDocument {
  if (format === 't2ranking') {
    const cells = lineText.split('\t')
    if (line === 1 && cells[0] === 'pid' && cells[1] === 'text') {
      throw new CorpusFormatError(source, line, 'T2Ranking header must be skipped by the stream reader')
    }
    if (cells.length !== 2) throw new CorpusFormatError(source, line, 'expected pid and text separated by one tab')
    return {
      id: KnowledgeDocumentId(requiredString(cells[0], 'pid', source, line)),
      text: requiredString(cells[1], 'text', source, line),
    }
  }
  const value = parseJsonLine(lineText, source, line)
  const sciFact = format === 'scifact'
  const mldr = format === 'mldr'
  assertFields(
    value,
    sciFact
      ? new Set(['_id', 'text', 'title', 'metadata'])
      : mldr ? new Set(['docid', 'text']) : new Set(['id', 'text', 'title', 'source']),
    source,
    line,
  )
  if ('metadata' in value && !isRecord(value['metadata'])) {
    throw new CorpusFormatError(source, line, 'metadata must be an object')
  }
  const idField = sciFact ? '_id' : mldr ? 'docid' : 'id'
  const id = requiredString(value[idField], idField, source, line)
  const title = optionalString(value['title'], 'title', source, line)
  const documentSource = sciFact || mldr ? undefined : optionalString(value['source'], 'source', source, line)
  return {
    id: KnowledgeDocumentId(id),
    text: requiredString(value['text'], 'text', source, line),
    ...(title === undefined ? {} : { title }),
    ...(documentSource === undefined ? {} : { source: documentSource }),
  }
}

/**
 * Parse two-column T2Ranking query TSV with its required header.
 * @param text - complete query TSV contents.
 * @param source - source label used in diagnostics.
 * @returns validated queries sorted by identifier.
 */
export function parseT2RankingQueriesTsv(text: string, source = 'queries.dev.tsv'): SciFactQuery[] {
  const lines = text.split('\n')
  if (lines[0]?.replace(/\r$/u, '') !== 'qid\ttext') {
    throw new CorpusFormatError(source, 1, 'expected header qid, text')
  }
  const queries: SciFactQuery[] = []
  const ids = new Set<string>()
  for (let index = 1; index < lines.length; index += 1) {
    const raw = (lines[index] as string).replace(/\r$/u, '')
    if (raw.trim().length === 0) continue
    const separator = raw.indexOf('\t')
    if (separator < 1) throw new CorpusFormatError(source, index + 1, 'expected qid and text separated by one tab')
    const id = requiredString(raw.slice(0, separator), 'qid', source, index + 1)
    if (ids.has(id)) throw new CorpusFormatError(source, index + 1, `duplicate query id ${JSON.stringify(id)}`)
    ids.add(id)
    queries.push({ id, text: requiredString(raw.slice(separator + 1), 'text', source, index + 1) })
  }
  return queries.sort((left, right) => compareCodePoints(left.id, right.id))
}

/**
 * Parse two-column T2Ranking retrieval qrels with binary relevance.
 * @param text - complete retrieval qrels TSV contents.
 * @param queries - queries accepted by the evaluation run.
 * @param documentIds - source-document identifiers present in the index.
 * @param source - source label used in diagnostics.
 * @returns judged queries with positive relevant documents.
 */
export function parseT2RankingQrelsTsv(
  text: string,
  queries: readonly SciFactQuery[],
  documentIds: ReadonlySet<string>,
  source = 'qrels.retrieval.dev.tsv',
): SciFactEvaluationQuery[] {
  const lines = text.split('\n')
  if (lines[0]?.replace(/\r$/u, '') !== 'qid\tpid') {
    throw new CorpusFormatError(source, 1, 'expected header qid, pid')
  }
  const trec = lines.slice(1).filter(line => line.trim().length > 0).map((line) => {
    const cells = line.replace(/\r$/u, '').split('\t')
    return cells.length === 2 ? `${cells[0]} Q0 ${cells[1]} 1` : line
  }).join('\n')
  return parseTrecQrelsTsv(trec, queries, documentIds, source)
}

function requiredString(value: unknown, field: string, source: string, line: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CorpusFormatError(source, line, `${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string, source: string, line: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new CorpusFormatError(source, line, `${field} must be a string`)
  return value
}

function nonBlankLines(text: string): Array<{ line: number; text: string }> {
  const lines: Array<{ line: number; text: string }> = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length > 0) lines.push({ line: index + 1, text: line })
  }
  return lines
}

function parseDocuments(
  text: string,
  source: string,
  idField: 'id' | '_id',
): CorpusDocument[] {
  const documents: CorpusDocument[] = []
  const ids = new Set<string>()
  for (const input of nonBlankLines(text)) {
    const document = parseCorpusDocumentLine(input.text, idField === '_id' ? 'scifact' : 'generic', source, input.line)
    if (ids.has(document.id)) {
      throw new CorpusFormatError(source, input.line, `duplicate document id ${JSON.stringify(document.id)}`)
    }
    ids.add(document.id)
    documents.push(document)
  }
  return documents.sort((left, right) => compareCodePoints(left.id, right.id))
}

/**
 * Parse the generic strict knowledge corpus JSONL format.
 * @param text - complete JSONL contents.
 * @param source - source label used in diagnostics.
 * @returns validated documents sorted by identifier.
 */
export function parseCorpusJsonl(text: string, source = 'corpus.jsonl'): CorpusDocument[] {
  return parseDocuments(text, source, 'id')
}

/**
 * Parse BEIR SciFact corpus JSONL into the generic document form.
 * @param text - complete SciFact corpus JSONL contents.
 * @param source - source label used in diagnostics.
 * @returns validated documents sorted by identifier.
 */
export function parseSciFactCorpusJsonl(text: string, source = 'corpus.jsonl'): CorpusDocument[] {
  return parseDocuments(text, source, '_id')
}

/**
 * Parse BEIR SciFact query JSONL.
 * @param text - complete SciFact query JSONL contents.
 * @param source - source label used in diagnostics.
 * @returns validated queries sorted by identifier.
 */
export function parseSciFactQueriesJsonl(text: string, source = 'queries.jsonl'): SciFactQuery[] {
  const queries: SciFactQuery[] = []
  const ids = new Set<string>()
  for (const input of nonBlankLines(text)) {
    const value = parseJsonLine(input.text, source, input.line)
    assertFields(value, new Set(['_id', 'text', 'metadata']), source, input.line)
    if ('metadata' in value && !isRecord(value['metadata'])) {
      throw new CorpusFormatError(source, input.line, 'metadata must be an object')
    }
    const id = requiredString(value['_id'], '_id', source, input.line)
    if (ids.has(id)) throw new CorpusFormatError(source, input.line, `duplicate query id ${JSON.stringify(id)}`)
    ids.add(id)
    queries.push({ id, text: requiredString(value['text'], 'text', source, input.line) })
  }
  return queries.sort((left, right) => compareCodePoints(left.id, right.id))
}

/**
 * Parse MLDR query JSONL while discarding embedded positive passage text.
 * @param text - complete MLDR query JSONL contents.
 * @param source - source label used in diagnostics.
 * @returns validated queries sorted by identifier.
 */
export function parseMldrQueriesJsonl(text: string, source = 'dev.jsonl'): SciFactQuery[] {
  const queries: SciFactQuery[] = []
  const ids = new Set<string>()
  for (const input of nonBlankLines(text)) {
    const value = parseJsonLine(input.text, source, input.line)
    assertFields(value, new Set(['query_id', 'query', 'positive_passages', 'negative_passages']), source, input.line)
    const id = requiredString(value['query_id'], 'query_id', source, input.line)
    if (ids.has(id)) throw new CorpusFormatError(source, input.line, `duplicate query id ${JSON.stringify(id)}`)
    ids.add(id)
    queries.push({ id, text: requiredString(value['query'], 'query', source, input.line) })
  }
  return queries.sort((left, right) => compareCodePoints(left.id, right.id))
}

/**
 * Parse and validate the SciFact test qrels against known queries and documents.
 * @param text - complete tab-separated qrels contents.
 * @param queries - queries accepted by the evaluation run.
 * @param documents - corpus documents accepted by the evaluation run.
 * @param source - source label used in diagnostics.
 * @returns judged queries with positive relevant documents.
 */
export function parseSciFactQrelsTsv(
  text: string,
  queries: readonly SciFactQuery[],
  documents: readonly CorpusDocument[],
  source = 'qrels/test.tsv',
): SciFactEvaluationQuery[] {
  const lines = text.split('\n')
  if (lines[0]?.replace(/\r$/u, '') !== 'query-id\tcorpus-id\tscore') {
    throw new CorpusFormatError(source, 1, 'expected header query-id, corpus-id, score')
  }
  const queryById = new Map(queries.map(query => [query.id, query]))
  const documentIds = new Set(documents.map(document => document.id as string))
  const judgments = new Map<string, SciFactRelevance[]>()
  const pairs = new Set<string>()
  for (let index = 1; index < lines.length; index += 1) {
    const raw = (lines[index] as string).replace(/\r$/u, '')
    if (raw.trim().length === 0) continue
    const line = index + 1
    const cells = raw.split('\t')
    if (cells.length !== 3) throw new CorpusFormatError(source, line, 'expected three tab-separated fields')
    const queryId = requiredString(cells[0], 'query-id', source, line)
    const documentId = requiredString(cells[1], 'corpus-id', source, line)
    const relevance = Number(cells[2])
    if (!Number.isFinite(relevance)) throw new CorpusFormatError(source, line, 'score must be a finite number')
    if (!queryById.has(queryId)) throw new CorpusFormatError(source, line, `unknown query id ${JSON.stringify(queryId)}`)
    if (!documentIds.has(documentId)) throw new CorpusFormatError(source, line, `unknown document id ${JSON.stringify(documentId)}`)
    const pair = `${queryId}\u0000${documentId}`
    if (pairs.has(pair)) throw new CorpusFormatError(source, line, 'duplicate query and document judgment')
    pairs.add(pair)
    const current = judgments.get(queryId) ?? []
    if (relevance > 0) current.push({ documentId: KnowledgeDocumentId(documentId), relevance })
    judgments.set(queryId, current)
  }
  const selected: SciFactEvaluationQuery[] = []
  for (const queryId of [...judgments.keys()].sort(compareCodePoints)) {
    const relevantDocuments = judgments.get(queryId) as SciFactRelevance[]
    if (relevantDocuments.length === 0) {
      throw new CorpusFormatError(source, 1, `query ${JSON.stringify(queryId)} has no positive judgment`)
    }
    relevantDocuments.sort((left, right) => compareCodePoints(left.documentId, right.documentId))
    const query = queryById.get(queryId) as SciFactQuery
    selected.push({ ...query, relevantDocuments })
  }
  return selected
}

/**
 * Parse four-column TREC qrels used by MLDR and T2Ranking.
 * @param text - complete TREC qrels contents.
 * @param queries - queries accepted by the evaluation run.
 * @param documentIds - source-document identifiers present in the index.
 * @param source - source label used in diagnostics.
 * @returns judged queries with positive relevant documents.
 */
export function parseTrecQrelsTsv(
  text: string,
  queries: readonly SciFactQuery[],
  documentIds: ReadonlySet<string>,
  source = 'qrels.tsv',
): SciFactEvaluationQuery[] {
  const queryById = new Map(queries.map(query => [query.id, query]))
  const judgments = new Map<string, SciFactRelevance[]>()
  const pairs = new Set<string>()
  for (const [index, rawLine] of text.split('\n').entries()) {
    const raw = rawLine.replace(/\r$/u, '')
    if (raw.trim().length === 0) continue
    const cells = raw.split(/\s+/u)
    if (cells.length !== 4) throw new CorpusFormatError(source, index + 1, 'expected four TREC qrels fields')
    const queryId = requiredString(cells[0], 'query id', source, index + 1)
    const documentId = requiredString(cells[2], 'document id', source, index + 1)
    const relevance = Number(cells[3])
    if (!Number.isFinite(relevance)) throw new CorpusFormatError(source, index + 1, 'score must be finite')
    if (!queryById.has(queryId)) throw new CorpusFormatError(source, index + 1, `unknown query id ${JSON.stringify(queryId)}`)
    if (!documentIds.has(documentId)) throw new CorpusFormatError(source, index + 1, `unknown document id ${JSON.stringify(documentId)}`)
    const pair = `${queryId}\u0000${documentId}`
    if (pairs.has(pair)) throw new CorpusFormatError(source, index + 1, 'duplicate query and document judgment')
    pairs.add(pair)
    if (relevance > 0) {
      const current = judgments.get(queryId) ?? []
      current.push({ documentId: KnowledgeDocumentId(documentId), relevance })
      judgments.set(queryId, current)
    }
  }
  return [...judgments.entries()].sort(([left], [right]) => compareCodePoints(left, right)).map(([queryId, relevantDocuments]) => ({
    ...(queryById.get(queryId) as SciFactQuery),
    relevantDocuments: relevantDocuments.sort((left, right) => compareCodePoints(left.documentId, right.documentId)),
  }))
}
