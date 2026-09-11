import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DENSE_ENCODING_IMPLEMENTATION_VERSION,
  DenseVectorCache,
  denseVectorCacheKey,
  denseVectorConfigSha256,
  VECTOR_CACHE_FILE,
  type DenseVectorCacheConfig,
} from '../src/vector-cache.ts'

const temporaryDirectories: string[] = []
const config: DenseVectorCacheConfig = {
  modelId: 'test-model',
  revision: 'a'.repeat(40),
  dtype: 'q8',
  modelFile: 'model.onnx',
  pooling: 'cls',
  normalized: true,
  dimensions: 2,
  maxTokens: 32,
  queryPrefix: '',
  implementationVersion: DENSE_ENCODING_IMPLEMENTATION_VERSION,
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-vector-cache-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Dense vector cache', () => {
  it('addresses exact text and configuration with stable length-delimited hashes', () => {
    expect(denseVectorConfigSha256(config)).toMatch(/^[a-f0-9]{64}$/u)
    expect(denseVectorCacheKey(config, 'alpha')).toBe(denseVectorCacheKey(config, 'alpha'))
    expect(denseVectorCacheKey(config, 'alpha')).not.toBe(denseVectorCacheKey(config, 'alpha\n'))
    expect(denseVectorCacheKey(config, 'alpha')).not.toBe(denseVectorCacheKey({
      ...config,
      revision: 'b'.repeat(40),
    }, 'alpha'))
  })

  it('commits complete batches and reopens their byte-identical vectors', async () => {
    const directory = await temporaryDirectory()
    const key = denseVectorCacheKey(config, 'alpha')
    const cache = await DenseVectorCache.open(directory, config)
    expect(cache.putMany([{ key, vector: new Float32Array([1, 0]) }])).toBe(1)
    expect(cache.putMany([{ key, vector: new Float32Array([1, 0]) }])).toBe(0)
    cache.close()

    const reopened = await DenseVectorCache.open(directory, config)
    expect(reopened.getMany([key, key]).get(key)).toEqual(new Float32Array([1, 0]))
    reopened.close()
  })

  it('rejects invalid writes without exposing any row from the batch', async () => {
    const directory = await temporaryDirectory()
    const validKey = denseVectorCacheKey(config, 'valid')
    const invalidKey = denseVectorCacheKey(config, 'invalid')
    const cache = await DenseVectorCache.open(directory, config)
    expect(() => cache.putMany([
      { key: validKey, vector: new Float32Array([1, 0]) },
      { key: invalidKey, vector: new Float32Array([2, 0]) },
    ])).toThrow('not L2-normalized')
    expect(cache.getMany([validKey, invalidKey])).toEqual(new Map())

    expect(() => cache.putMany([
      { key: validKey, vector: new Float32Array([1, 0]) },
      { key: 'invalid-key', vector: new Float32Array([0, 1]) },
    ])).toThrow('CHECK constraint failed')
    expect(cache.getMany([validKey])).toEqual(new Map())
    cache.close()
  })

  it('rejects corrupted dimensions, bytes, configuration, and vector values', async () => {
    const corrupt = async (sql: string, message: string) => {
      const directory = await temporaryDirectory()
      const key = denseVectorCacheKey(config, 'alpha')
      const cache = await DenseVectorCache.open(directory, config)
      cache.putMany([{ key, vector: new Float32Array([1, 0]) }])
      cache.close()
      const database = new DatabaseSync(join(directory, VECTOR_CACHE_FILE))
      database.exec('PRAGMA ignore_check_constraints = ON')
      database.exec(sql)
      database.close()
      const corrupted = await DenseVectorCache.open(directory, config)
      expect(() => corrupted.getMany([key])).toThrow(message)
      corrupted.close()
    }

    await corrupt('UPDATE vectors SET dimensions = 3', 'incompatible dimensions')
    await corrupt("UPDATE vectors SET vector = x'0000'", 'invalid byte length')
    await corrupt(`UPDATE vectors SET config_sha256 = '${'b'.repeat(64)}'`, 'incompatible configuration digest')
    await corrupt("UPDATE vectors SET vector = x'0000004000000000'", 'not L2-normalized')
  })

  it('closes idempotently and rejects an incompatible cache schema version', async () => {
    const directory = await temporaryDirectory()
    const cache = await DenseVectorCache.open(directory, config)
    cache.close()
    cache.close()

    const invalidDirectory = await temporaryDirectory()
    const database = new DatabaseSync(join(invalidDirectory, VECTOR_CACHE_FILE))
    database.exec('PRAGMA user_version = 2')
    database.close()
    await expect(DenseVectorCache.open(invalidDirectory, config)).rejects.toThrow('schema version must be 1')
  })
})
