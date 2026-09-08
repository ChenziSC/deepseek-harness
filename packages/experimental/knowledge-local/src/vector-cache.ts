/** Persistent content-addressed cache for document embedding vectors. */

import { createHash, type Hash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { validateDenseVectors } from './dense.ts'

/** Fixed SQLite filename inside a vector cache directory. */
export const VECTOR_CACHE_FILE = 'vectors.sqlite'
/** Version of the exact text-to-vector encoding semantics included in cache keys. */
export const DENSE_ENCODING_IMPLEMENTATION_VERSION = 'knowledge-local-dense-document-v1'

/** Dense settings that determine one document vector. */
export interface DenseVectorCacheConfig {
  readonly modelId: string
  readonly revision: string
  readonly dtype: 'q8'
  readonly modelFile: string
  readonly pooling: 'cls'
  readonly normalized: true
  readonly dimensions: number
  readonly maxTokens: number
  readonly queryPrefix: string
  readonly implementationVersion: typeof DENSE_ENCODING_IMPLEMENTATION_VERSION
}

/** One content-addressed vector ready for an atomic cache write. */
export interface DenseVectorCacheEntry {
  readonly key: string
  readonly vector: Float32Array
}

interface VectorCacheRow {
  readonly config_sha256: unknown
  readonly dimensions: unknown
  readonly vector: unknown
}

function lengthEncoded(hash: Hash, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.allocUnsafe(BigUint64Array.BYTES_PER_ELEMENT)
  length.writeBigUInt64BE(BigInt(bytes.length))
  hash.update(length)
  hash.update(bytes)
}

function configValues(config: DenseVectorCacheConfig): readonly string[] {
  return [
    config.modelId,
    config.revision,
    config.dtype,
    config.modelFile,
    config.pooling,
    String(config.normalized),
    String(config.dimensions),
    String(config.maxTokens),
    config.queryPrefix,
    config.implementationVersion,
  ]
}

/**
 * Hash the complete Dense document-encoding configuration.
 * @param config - settings that must match before a vector can be reused.
 * @returns SHA-256 digest used to diagnose corrupt or incompatible rows.
 */
export function denseVectorConfigSha256(config: DenseVectorCacheConfig): string {
  const hash = createHash('sha256')
  for (const value of configValues(config)) lengthEncoded(hash, value)
  return hash.digest('hex')
}

/**
 * Address one vector by the complete Dense configuration and exact model input.
 * @param config - settings that determine document embedding output.
 * @param text - complete title, section path, and chunk text input.
 * @returns length-delimited SHA-256 cache key.
 */
export function denseVectorCacheKey(config: DenseVectorCacheConfig, text: string): string {
  const hash = createHash('sha256')
  for (const value of [...configValues(config), text]) lengthEncoded(hash, value)
  return hash.digest('hex')
}

function vectorBytes(vector: Float32Array): Buffer {
  const bytes = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT)
  for (let index = 0; index < vector.length; index += 1) {
    bytes.writeFloatLE(vector[index] as number, index * Float32Array.BYTES_PER_ELEMENT)
  }
  return bytes
}

function cachedVector(value: unknown, key: string, configSha256: string, dimensions: number): Float32Array {
  const row = value as VectorCacheRow
  if (row.config_sha256 !== configSha256) {
    throw new TypeError(`knowledge-local: vector cache entry ${key} has an incompatible configuration digest`)
  }
  if (row.dimensions !== dimensions) {
    throw new TypeError(`knowledge-local: vector cache entry ${key} has incompatible dimensions`)
  }
  if (!(row.vector instanceof Uint8Array) || row.vector.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new TypeError(`knowledge-local: vector cache entry ${key} has an invalid byte length`)
  }
  const bytes = Buffer.from(row.vector)
  const vector = new Float32Array(dimensions)
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
  }
  validateDenseVectors(vector, 1, dimensions, `knowledge-local: vector cache entry ${key}`)
  return vector
}

/** SQLite cache whose batch writes become visible only after a successful transaction. */
export class DenseVectorCache {
  private readonly database: DatabaseSync
  private readonly select: StatementSync
  private readonly insert: StatementSync
  private readonly configSha256: string
  private closed = false

  private constructor(path: string, private readonly config: DenseVectorCacheConfig) {
    const database = new DatabaseSync(path)
    try {
      const version = database.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
      if (version?.['user_version'] !== 0 && version?.['user_version'] !== 1) {
        throw new TypeError('knowledge-local: vector cache schema version must be 1')
      }
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS vectors (
          cache_key TEXT PRIMARY KEY,
          config_sha256 TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector BLOB NOT NULL,
          CHECK (length(cache_key) = 64),
          CHECK (length(config_sha256) = 64),
          CHECK (dimensions > 0)
        ) STRICT;
        PRAGMA user_version = 1;
      `)
      this.select = database.prepare(`
        SELECT config_sha256, dimensions, vector
        FROM vectors
        WHERE cache_key = ?
      `)
      this.insert = database.prepare(`
        INSERT INTO vectors(cache_key, config_sha256, dimensions, vector)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cache_key) DO NOTHING
      `)
    } catch (error) {
      database.close()
      throw error
    }
    this.database = database
    this.configSha256 = denseVectorConfigSha256(config)
  }

  /**
   * Open or create one reusable cache directory.
   * @param directory - directory that owns the fixed SQLite cache file.
   * @param config - Dense encoding settings for all requested keys.
   * @returns open cache handle that the caller must close.
   */
  static async open(directory: string, config: DenseVectorCacheConfig): Promise<DenseVectorCache> {
    await mkdir(directory, { recursive: true })
    return new DenseVectorCache(join(directory, VECTOR_CACHE_FILE), config)
  }

  /**
   * Read and validate vectors for a bounded key batch.
   * @param keys - content-addressed keys from the current build batch.
   * @returns unique cache hits keyed by digest.
   */
  getMany(keys: readonly string[]): Map<string, Float32Array> {
    const vectors = new Map<string, Float32Array>()
    for (const key of new Set(keys)) {
      const row = this.select.get(key)
      if (row !== undefined) vectors.set(key, cachedVector(row, key, this.configSha256, this.config.dimensions))
    }
    return vectors
  }

  /**
   * Commit a complete vector batch atomically.
   * @param entries - unique validated vectors from one successful encoder call or import read.
   * @returns number of keys newly inserted rather than already present.
   */
  putMany(entries: readonly DenseVectorCacheEntry[]): number {
    for (const entry of entries) {
      validateDenseVectors(entry.vector, 1, this.config.dimensions, 'knowledge-local: vector cache write')
    }
    let inserted = 0
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of entries) {
        const result = this.insert.run(
          entry.key,
          this.configSha256,
          this.config.dimensions,
          vectorBytes(entry.vector),
        )
        inserted += Number(result.changes)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return inserted
  }

  /** Close the cache after all committed batches are durable. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}
