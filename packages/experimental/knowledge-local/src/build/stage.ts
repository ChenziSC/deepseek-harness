/** Stream a source corpus into the deterministic temporary build database. */

import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { createGunzip } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { CorpusFormatError, parseCorpusDocumentLine, type CorpusDocument } from '../corpus.ts'
import { countTextScripts, type TextScriptCounts } from '../script-profile.ts'
import { inImmediateTransaction } from '../storage/cache-primitives.ts'
import type { BuildBm25IndexOptions } from './types.ts'

/** Temporary database filename removed after successful payload publication. */
export const SOURCE_DATABASE_FILE = '.source.sqlite'

/** Open staged corpus and the identity accumulated while streaming it. */
export interface StagedCorpus {
  readonly database: DatabaseSync
  readonly corpusSha256: string
  readonly documentCount: number
  readonly scriptCounts: TextScriptCounts
}

interface PendingDocument {
  readonly document: CorpusDocument
  readonly line: number
}

function inputStream(options: BuildBm25IndexOptions): Readable {
  if ((options.corpusText === undefined) === (options.corpusPath === undefined)) {
    throw new TypeError('knowledge-local: exactly one of corpusText or corpusPath is required')
  }
  if (options.corpusText !== undefined) return Readable.from([Buffer.from(options.corpusText)])
  const stream = createReadStream(options.corpusPath as string)
  return options.corpusPath?.endsWith('.gz') === true ? stream.pipe(createGunzip()) : stream
}

async function* nonBlankCorpusLines(
  options: BuildBm25IndexOptions,
  digest: Hash,
): AsyncGenerator<{ line: number; text: string }> {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let line = 0
  for await (const value of inputStream(options)) {
    const chunk = Buffer.from(value as Uint8Array)
    digest.update(chunk)
    pending += decoder.write(chunk)
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      line += 1
      const text = pending.slice(0, newline).replace(/\r$/u, '')
      pending = pending.slice(newline + 1)
      if (text.trim().length > 0 && !(options.corpusFormat === 't2ranking' && line === 1 && text === 'pid\ttext')) {
        yield { line, text }
      }
    }
  }
  pending += decoder.end()
  if (pending.length > 0) {
    line += 1
    const text = pending.replace(/\r$/u, '')
    if (text.trim().length > 0 && !(options.corpusFormat === 't2ranking' && line === 1 && text === 'pid\ttext')) {
      yield { line, text }
    }
  }
}

function commitSourceBatch(
  database: DatabaseSync,
  insert: ReturnType<DatabaseSync['prepare']>,
  batch: readonly PendingDocument[],
  source: string,
): void {
  inImmediateTransaction(database, () => {
    for (const { document, line } of batch) {
      try {
        insert.run(
          document.id,
          document.title ?? null,
          document.source ?? null,
          document.sourceVersion ?? null,
          document.validFrom ?? null,
          document.validFromMs ?? null,
          document.validUntil ?? null,
          document.validUntilMs ?? null,
          document.supersedes ?? null,
          document.text,
        )
      } catch (error) {
        /* v8 ignore next -- node:sqlite reports statement failures as Error instances. */
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          throw new CorpusFormatError(source, line, `duplicate document id ${JSON.stringify(document.id)}`)
        }
        /* v8 ignore next -- non-uniqueness SQLite failures are external I/O faults and propagate unchanged. */
        throw error
      }
    }
  })
}

/**
 * Stage one corpus in binary document-id order while calculating its source identity.
 * @param options - corpus source and target output directory.
 * @param batchSize - maximum rows committed per transaction.
 * @returns open temporary database and aggregate corpus metadata.
 */
export async function stageCorpus(options: BuildBm25IndexOptions, batchSize: number): Promise<StagedCorpus> {
  const source = options.corpusSource ?? options.corpusPath ?? 'corpus.jsonl'
  const database = new DatabaseSync(join(options.outputDir, SOURCE_DATABASE_FILE))
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE source_documents (
        id TEXT PRIMARY KEY,
        title TEXT,
        source TEXT,
        source_version TEXT,
        valid_from TEXT,
        valid_from_ms INTEGER,
        valid_until TEXT,
        valid_until_ms INTEGER,
        supersedes TEXT,
        text TEXT NOT NULL
      ) STRICT;
    `)
    const insert = database.prepare(`
      INSERT INTO source_documents(
        id, title, source, source_version, valid_from, valid_from_ms,
        valid_until, valid_until_ms, supersedes, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const digest = createHash('sha256')
    const batch: PendingDocument[] = []
    let documentCount = 0
    let latin = 0
    let cjk = 0
    for await (const input of nonBlankCorpusLines(options, digest)) {
      const document = parseCorpusDocumentLine(input.text, options.corpusFormat ?? 'generic', source, input.line)
      batch.push({ document, line: input.line })
      const counts = countTextScripts(`${document.title ?? ''}\n${document.text}`)
      latin += counts.latin
      cjk += counts.cjk
      documentCount += 1
      if (batch.length === batchSize) {
        commitSourceBatch(database, insert, batch, source)
        batch.length = 0
      }
    }
    if (batch.length > 0) commitSourceBatch(database, insert, batch, source)
    return { database, corpusSha256: digest.digest('hex'), documentCount, scriptCounts: { latin, cjk } }
  } catch (error) {
    database.close()
    throw error
  }
}
