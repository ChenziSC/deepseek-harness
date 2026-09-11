/** Independent durable cache for generated contextual-prefix batches. */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  ContextualPrefixCachedSuccess,
  ContextualPrefixFailedAttempt,
  ContextualPrefixGenerationCache,
} from './contextual-prefix-generation.ts'
import { isSha256Digest } from '../../storage/cache-primitives.ts'

/** Fixed SQLite filename inside a contextual-prefix cache directory. */
export const CONTEXTUAL_PREFIX_CACHE_FILE = 'contextual-prefixes.sqlite'

interface CacheRow {
  readonly payload_sha256: unknown
  readonly payload: unknown
}

function exactFields(value: Record<string, unknown>, expected: readonly string[], key: string, subject: string): void {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (actual.length !== sorted.length || actual.some((field, index) => field !== sorted[index])) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid ${subject} fields`)
  }
}

function record(value: unknown, key: string, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid ${subject}`)
  }
  return value as Record<string, unknown>
}

function nonNegativeInteger(value: unknown, key: string, subject: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid ${subject}`)
  }
  return value
}

function nonNegativeNumber(value: unknown, key: string, subject: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid ${subject}`)
  }
  return value
}

function parsePayload(bytes: Uint8Array, key: string, expectedChunkIds: readonly string[]): ContextualPrefixCachedSuccess {
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
  } catch (error) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid JSON`, { cause: error })
  }
  const value = record(raw, key, 'payload')
  exactFields(value, ['schemaVersion', 'prefixes', 'inputTokens', 'outputTokens', 'latencyMs', 'outputSha256'], key, 'payload')
  if (value['schemaVersion'] !== 1) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid schema version`)
  }
  if (!Array.isArray(value['prefixes'])) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid prefixes`)
  }
  const expected = new Set(expectedChunkIds)
  const seen = new Set<string>()
  const prefixes = value['prefixes'].map((rawPrefix) => {
    const prefix = record(rawPrefix, key, 'prefix')
    exactFields(prefix, ['chunkId', 'context'], key, 'prefix')
    if (typeof prefix['chunkId'] !== 'string' || !expected.has(prefix['chunkId']) || seen.has(prefix['chunkId'])) {
      throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has incompatible chunk identities`)
    }
    if (typeof prefix['context'] !== 'string' || prefix['context'].trim().length === 0) {
      throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid prefix text`)
    }
    seen.add(prefix['chunkId'])
    return { chunkId: prefix['chunkId'], context: prefix['context'] }
  })
  if (
    seen.size !== expected.size
    || prefixes.some((prefix, index) => prefix.chunkId !== expectedChunkIds[index])
  ) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has incompatible chunk identities`)
  }
  if (!isSha256Digest(value['outputSha256'])) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid output digest`)
  }
  return {
    schemaVersion: 1,
    prefixes,
    inputTokens: nonNegativeInteger(value['inputTokens'], key, 'input token count'),
    outputTokens: nonNegativeInteger(value['outputTokens'], key, 'output token count'),
    latencyMs: nonNegativeNumber(value['latencyMs'], key, 'latency'),
    outputSha256: value['outputSha256'],
  }
}

function cachedSuccess(row: unknown, key: string, expectedChunkIds: readonly string[]): ContextualPrefixCachedSuccess {
  const value = row as CacheRow
  /* v8 ignore next 3 -- the STRICT TEXT column prevents a non-string durable digest. */
  if (!isSha256Digest(value.payload_sha256)) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid payload digest`)
  }
  /* v8 ignore next 3 -- the STRICT BLOB column prevents a non-byte durable payload. */
  if (!(value.payload instanceof Uint8Array)) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has invalid payload`)
  }
  const digest = createHash('sha256').update(value.payload).digest('hex')
  if (digest !== value.payload_sha256) {
    throw new TypeError(`knowledge-local: contextual prefix cache entry ${key} has a payload digest mismatch`)
  }
  return parsePayload(value.payload, key, expectedChunkIds)
}

function canonicalPayload(value: ContextualPrefixCachedSuccess): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: value.schemaVersion,
    prefixes: value.prefixes.map(prefix => ({ chunkId: prefix.chunkId, context: prefix.context })),
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    latencyMs: value.latencyMs,
    outputSha256: value.outputSha256,
  }), 'utf8')
}

/** SQLite-backed content-addressed cache whose failed attempts remain audit-only. */
export class ContextualPrefixCache implements ContextualPrefixGenerationCache {
  private readonly database: DatabaseSync
  private readonly select: StatementSync
  private readonly insert: StatementSync
  private readonly insertFailure: StatementSync
  private readonly countFailures: StatementSync
  private closed = false

  private constructor(path: string) {
    const database = new DatabaseSync(path)
    try {
      const version = database.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
      if (version?.['user_version'] !== 0 && version?.['user_version'] !== 1) {
        throw new TypeError('knowledge-local: contextual prefix cache schema version must be 1')
      }
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS successful_batches (
          cache_key TEXT PRIMARY KEY,
          payload_sha256 TEXT NOT NULL,
          payload BLOB NOT NULL,
          CHECK (length(cache_key) = 64),
          CHECK (length(payload_sha256) = 64)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS failed_attempts (
          id INTEGER PRIMARY KEY,
          cache_key TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          failure_type TEXT NOT NULL,
          message TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          latency_ms REAL NOT NULL,
          CHECK (length(cache_key) = 64),
          CHECK (attempt >= 1),
          CHECK (failure_type IN ('request', 'json', 'schema', 'empty', 'token-limit', 'chunk-copy', 'budget')),
          CHECK (length(message) > 0),
          CHECK (input_tokens >= 0),
          CHECK (output_tokens >= 0),
          CHECK (latency_ms >= 0)
        ) STRICT;
        PRAGMA user_version = 1;
      `)
      this.select = database.prepare('SELECT payload_sha256, payload FROM successful_batches WHERE cache_key = ?')
      this.insert = database.prepare(`
        INSERT INTO successful_batches(cache_key, payload_sha256, payload)
        VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO NOTHING
      `)
      this.insertFailure = database.prepare(`
        INSERT INTO failed_attempts(
          cache_key, attempt, failure_type, message, input_tokens, output_tokens, latency_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      this.countFailures = database.prepare('SELECT COUNT(*) AS count FROM failed_attempts WHERE cache_key = ?')
    } catch (error) {
      database.close()
      throw error
    }
    this.database = database
  }

  /**
   * Open or create one reusable contextual-prefix cache.
   * @param directory - directory that owns the fixed SQLite cache file.
   * @returns open cache handle that the caller must close.
   */
  static async open(directory: string): Promise<ContextualPrefixCache> {
    await mkdir(directory, { recursive: true })
    return new ContextualPrefixCache(join(directory, CONTEXTUAL_PREFIX_CACHE_FILE))
  }

  /** Read and validate one successful batch; failed attempts never satisfy this lookup. */
  get(key: string, expectedChunkIds: readonly string[]): ContextualPrefixCachedSuccess | undefined {
    const row = this.select.get(key)
    return row === undefined ? undefined : cachedSuccess(row, key, expectedChunkIds)
  }

  /** Commit one complete successful batch atomically without replacing an existing content address. */
  put(key: string, value: ContextualPrefixCachedSuccess): boolean {
    const payload = canonicalPayload(value)
    parsePayload(payload, key, value.prefixes.map(prefix => prefix.chunkId))
    const digest = createHash('sha256').update(payload).digest('hex')
    return Number(this.insert.run(key, digest, payload).changes) === 1
  }

  /** Append one failed request or validation attempt for audit without making it cacheable. */
  recordFailure(key: string, failure: ContextualPrefixFailedAttempt): void {
    this.insertFailure.run(
      key,
      failure.attempt,
      failure.failureType,
      failure.message,
      failure.inputTokens,
      failure.outputTokens,
      failure.latencyMs,
    )
  }

  /**
   * Return the number of audit-only failed attempts stored for one content address.
   * @param key - Content-addressed batch key.
   * @returns Stored failed-attempt count.
   */
  failureCount(key: string): number {
    const row = this.countFailures.get(key) as Record<string, unknown>
    return Number(row['count'])
  }

  /** Close the cache after all synchronous SQLite writes are durable. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}
