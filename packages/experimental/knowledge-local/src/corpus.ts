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
  fields: ReadonlySet<string>,
  idField: 'id' | '_id',
  includeSource: boolean,
): CorpusDocument[] {
  const documents: CorpusDocument[] = []
  const ids = new Set<string>()
  for (const input of nonBlankLines(text)) {
    const value = parseJsonLine(input.text, source, input.line)
    assertFields(value, fields, source, input.line)
    if ('metadata' in value && !isRecord(value['metadata'])) {
      throw new CorpusFormatError(source, input.line, 'metadata must be an object')
    }
    const id = requiredString(value[idField], idField, source, input.line)
    if (ids.has(id)) throw new CorpusFormatError(source, input.line, `duplicate document id ${JSON.stringify(id)}`)
    ids.add(id)
    const body = requiredString(value['text'], 'text', source, input.line)
    const title = optionalString(value['title'], 'title', source, input.line)
    const documentSource = includeSource ? optionalString(value['source'], 'source', source, input.line) : undefined
    documents.push({
      id: KnowledgeDocumentId(id),
      text: body,
      ...(title === undefined ? {} : { title }),
      ...(documentSource === undefined ? {} : { source: documentSource }),
    })
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
  return parseDocuments(text, source, new Set(['id', 'text', 'title', 'source']), 'id', true)
}

/**
 * Parse BEIR SciFact corpus JSONL into the generic document form.
 * @param text - complete SciFact corpus JSONL contents.
 * @param source - source label used in diagnostics.
 * @returns validated documents sorted by identifier.
 */
export function parseSciFactCorpusJsonl(text: string, source = 'corpus.jsonl'): CorpusDocument[] {
  return parseDocuments(text, source, new Set(['_id', 'text', 'title', 'metadata']), '_id', false)
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
    const raw = lines[index]?.replace(/\r$/u, '') ?? ''
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
    const relevantDocuments = judgments.get(queryId) ?? []
    if (relevantDocuments.length === 0) {
      throw new CorpusFormatError(source, 1, `query ${JSON.stringify(queryId)} has no positive judgment`)
    }
    relevantDocuments.sort((left, right) => compareCodePoints(left.documentId, right.documentId))
    const query = queryById.get(queryId)
    if (query === undefined) throw new CorpusFormatError(source, 1, `unknown query id ${JSON.stringify(queryId)}`)
    selected.push({ ...query, relevantDocuments })
  }
  return selected
}
