/** Shared byte-level primitives for independent SQLite caches. */

import { createHash, type Hash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Append one unambiguous UTF-8 value to a digest.
 * @param hash - digest receiving the length and bytes.
 * @param value - exact string value to append.
 */
function updateLengthEncodedHash(hash: Hash, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.allocUnsafe(BigUint64Array.BYTES_PER_ELEMENT)
  length.writeBigUInt64BE(BigInt(bytes.length))
  hash.update(length)
  hash.update(bytes)
}

/**
 * Hash an ordered sequence without concatenation ambiguity.
 * @param values - exact values in identity order.
 * @returns lowercase SHA-256 digest.
 */
export function lengthEncodedSha256(values: readonly string[]): string {
  const hash = createHash('sha256')
  for (const value of values) updateLengthEncodedHash(hash, value)
  return hash.digest('hex')
}

/**
 * Run synchronous work in one immediate SQLite transaction.
 * @param database - cache database that owns the transaction.
 * @param work - synchronous writes whose result is returned after commit.
 * @returns the work result after a successful commit.
 */
export function inImmediateTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/** Return whether a durable text value is a lowercase SHA-256 digest. */
export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}
