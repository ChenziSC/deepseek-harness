import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildKnowledgeIndex,
  DENSE_DIMENSIONS,
  loadDenseVectors,
  loadKnowledgeIndex,
  verifyKnowledgeIndex,
  type ChunkTokenizer,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

const temporaryDirectories: string[] = []
const whitespaceTokenizer: ChunkTokenizer = {
  countTokens(text) {
    return text.match(/\S+/gu)?.length ?? 0
  },
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('fixture expected an object')
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('fixture expected an array')
  return value
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-knowledge-format-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createIndex(denseIndex: 'auto' | 'exact' | 'hnsw' | 'both' = 'auto'): Promise<string> {
  const outputDir = join(await temporaryDirectory(), 'index')
  await buildKnowledgeIndex({
    corpusText: [
      '{"id":"doc-a","title":"Alpha","text":"alpha beta","source":"fixture"}',
      '{"id":"doc-b","text":"beta gamma"}',
    ].join('\n'),
    outputDir,
    tokenizer: whitespaceTokenizer,
    chunking: { maxTokens: 8, overlapTokens: 0 },
    dense: {
      encoder: {
        embedDocuments(texts) {
          const vectors = new Float32Array(texts.length * DENSE_DIMENSIONS)
          for (let row = 0; row < texts.length; row += 1) vectors[row * DENSE_DIMENSIONS + row] = 1
          return Promise.resolve(vectors)
        },
      },
      batchSize: 2,
      modelId: 'dense-model',
      revision: 'a'.repeat(40),
      dtype: 'q8',
      denseIndex,
    },
  })
  return outputDir
}

async function readObject(path: string): Promise<Record<string, unknown>> {
  return record(JSON.parse(await readFile(path, 'utf8')) as unknown)
}

async function rewriteManifest(
  indexDir: string,
  mutate: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(indexDir, 'manifest.json')
  const manifest = await readObject(path)
  mutate(manifest)
  await writeFile(path, `${JSON.stringify(manifest)}\n`)
}

async function refreshPayload(indexDir: string, name: string): Promise<void> {
  const content = await readFile(join(indexDir, name))
  await rewriteManifest(indexDir, (manifest) => {
    const payload = array(manifest['payloads']).map(record).find(item => item['path'] === name)
    if (payload === undefined) throw new TypeError(`fixture payload is missing: ${name}`)
    payload['bytes'] = content.byteLength
    payload['sha256'] = createHash('sha256').update(content).digest('hex')
  })
}

async function rewritePayload(indexDir: string, name: string, data: Buffer): Promise<void> {
  await writeFile(join(indexDir, name), data)
  await refreshPayload(indexDir, name)
}

async function rewriteSqlite(indexDir: string, sql: string): Promise<void> {
  const path = join(indexDir, 'knowledge.sqlite')
  const database = new DatabaseSync(path)
  try {
    database.exec(sql)
  } finally {
    database.close()
  }
  await refreshPayload(indexDir, 'knowledge.sqlite')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('version-three knowledge index validation', () => {
  it.each([
    ['manifest JSON', async (indexDir: string) => writeFile(join(indexDir, 'manifest.json'), '{'), 'manifest.json is not valid JSON'],
    ['manifest object', async (indexDir: string) => writeFile(join(indexDir, 'manifest.json'), '[]'), 'manifest must be an object'],
    ['manifest fields', async (indexDir: string) => rewriteManifest(indexDir, (value) => { value['extra'] = true }), 'manifest fields are incompatible'],
    ['format version', async (indexDir: string) => rewriteManifest(indexDir, (value) => { value['formatVersion'] = 2 }), 'formatVersion must be 3'],
    ['nested manifest objects', async (indexDir: string) => rewriteManifest(indexDir, (value) => { value['build'] = null }), 'manifest fields are incomplete'],
    ['createdBy fields', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['createdBy'])['extra'] = true }), 'manifest createdBy fields are incompatible'],
    ['package identity', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['createdBy'])['package'] = 'other' }), 'manifest package is unsupported'],
    ['package version', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['createdBy'])['version'] = '' }), 'manifest createdBy.version must be a non-empty string'],
    ['duration type', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['build'])['durationMs'] = '1' }), 'manifest build.durationMs must be a finite number'],
    ['duration value', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['build'])['durationMs'] = -1 }), 'manifest build.durationMs must be non-negative'],
    ['document count', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['corpus'])['documentCount'] = -1 }), 'manifest corpus.documentCount must be a non-negative safe integer'],
    ['corpus hash', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['corpus'])['sha256'] = 'bad' }), 'manifest corpus.sha256 must be a SHA-256 hex digest'],
    ['chunking fields', async (indexDir: string) => rewriteManifest(indexDir, (value) => { delete record(value['chunking'])['maxTokens'] }), 'manifest chunking fields are incompatible'],
    ['chunking tokenizer', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['chunking'])['tokenizerModelId'] = '' }), 'manifest chunking.tokenizerModelId must be a non-empty string'],
    ['chunking revision', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['chunking'])['tokenizerRevision'] = '' }), 'manifest chunking.tokenizerRevision must be a non-empty string'],
    ['chunking maximum', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['chunking'])['maxTokens'] = 0 }), 'manifest chunking or script profile is invalid'],
    ['chunking overlap', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['chunking'])['overlapTokens'] = 8 }), 'manifest chunking or script profile is invalid'],
    ['chunking strategy', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['chunking'])['strategy'] = 'other' }), 'manifest chunking or script profile is invalid'],
    ['script profile', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['corpus'])['scriptProfile'] = 'other' }), 'manifest chunking or script profile is invalid'],
    ['BM25 fields', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['bm25'])['extra'] = true }), 'manifest bm25 fields are incompatible'],
    ['BM25 analyzer', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['bm25'])['analyzer'] = 'other' }), 'manifest BM25 configuration is unsupported'],
    ['BM25 implementation', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['bm25'])['implementation'] = 'other' }), 'manifest BM25 configuration is unsupported'],
    ['Dense object', async (indexDir: string) => rewriteManifest(indexDir, (value) => { value['dense'] = null }), 'manifest dense must be an object'],
    ['Dense fields', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['dense'])['extra'] = true }), 'manifest dense fields are incompatible'],
    ['Dense representation', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['dense'])['pooling'] = 'mean' }), 'manifest Dense representation is unsupported'],
    ['Dense model', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['dense'])['modelId'] = '' }), 'manifest dense.modelId must be a non-empty string'],
    ['Dense revision', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(value['dense'])['revision'] = 'main' }), 'manifest dense.revision must be a full lowercase commit SHA'],
    ['payload object', async (indexDir: string) => rewriteManifest(indexDir, (value) => { array(value['payloads'])[0] = null }), 'manifest payloads[0] must be an object'],
    ['payload fields', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(array(value['payloads'])[0])['extra'] = true }), 'manifest payloads[0] fields are incompatible'],
    ['payload path', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(array(value['payloads'])[0])['path'] = '' }), 'manifest payloads[0].path must be a non-empty string'],
    ['payload bytes', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(array(value['payloads'])[0])['bytes'] = -1 }), 'manifest payloads[0].bytes must be a non-negative safe integer'],
    ['payload hash', async (indexDir: string) => rewriteManifest(indexDir, (value) => { record(array(value['payloads'])[0])['sha256'] = 'bad' }), 'manifest payloads[0].sha256 must be a SHA-256 hex digest'],
    ['payload list', async (indexDir: string) => rewriteManifest(indexDir, (value) => { array(value['payloads']).pop() }), 'manifest payload paths must be'],
  ])('rejects invalid %s', async (_name, mutate, message) => {
    const indexDir = await createIndex()
    await mutate(indexDir)
    await expect(loadKnowledgeIndex(indexDir)).rejects.toThrow(message)
  })

  it('rejects incompatible SQLite versions, metadata, and counts', async () => {
    const version = await createIndex()
    await rewriteSqlite(version, 'PRAGMA user_version = 99')
    await expect(loadKnowledgeIndex(version)).rejects.toThrow('knowledge.sqlite schema or contents are incompatible')

    const metadata = await createIndex()
    await rewriteSqlite(metadata, "UPDATE metadata SET value = 'other' WHERE key = 'analyzer'")
    await expect(loadKnowledgeIndex(metadata)).rejects.toThrow('knowledge.sqlite schema or contents are incompatible')

    const chunks = await createIndex()
    await rewriteSqlite(chunks, 'DELETE FROM chunks WHERE ordinal = 1')
    await expect(loadKnowledgeIndex(chunks)).rejects.toThrow('knowledge.sqlite schema or contents are incompatible')

    const fts = await createIndex()
    await rewriteSqlite(fts, 'DELETE FROM bm25_fts WHERE rowid = 1')
    await expect(loadKnowledgeIndex(fts)).rejects.toThrow('knowledge.sqlite schema or contents are incompatible')
  })

  it('queries read-only SQLite and validates selected chunk rows', async () => {
    const indexDir = await createIndex()
    const before = await readdir(indexDir)
    const loaded = await loadKnowledgeIndex(indexDir)
    expect(loaded.sqlite.searchBm25('alpha " OR beta', 2).map(match => match.ordinal)).toEqual([0, 1])
    expect(loaded.sqlite.searchBm25('!!!', 2)).toEqual([])
    expect(loaded.sqlite.chunks([1, 0]).map(chunk => chunk.documentId)).toEqual(['doc-b', 'doc-a'])
    expect(() => loaded.sqlite.chunks([99])).toThrow('ordinal 99 is missing')
    expect(() => loaded.sqlite.adjacentChunks(99)).toThrow('ordinal 99 is missing')
    loaded.sqlite.close()
    expect(await readdir(indexDir)).toEqual(before)

    await rewriteSqlite(indexDir, "UPDATE chunks SET chunk_id = 'wrong' WHERE ordinal = 0")
    const invalid = await loadKnowledgeIndex(indexDir)
    expect(() => invalid.sqlite.chunks([0])).toThrow('identity or token range is invalid')
    invalid.sqlite.close()
    invalid.sqlite.close()
  })

  it('rejects invalid durable chunk fields when selected', async () => {
    const invalidRange = await createIndex()
    await rewriteSqlite(invalidRange, `
      PRAGMA ignore_check_constraints = ON;
      UPDATE chunks SET start_token = -1 WHERE ordinal = 0;
    `)
    const rangeIndex = await loadKnowledgeIndex(invalidRange)
    expect(() => rangeIndex.sqlite.chunks([0])).toThrow('chunk start token must be a non-negative safe integer')
    rangeIndex.sqlite.close()

    const emptyText = await createIndex()
    await rewriteSqlite(emptyText, `
      PRAGMA ignore_check_constraints = ON;
      UPDATE chunks SET text = '' WHERE ordinal = 0;
    `)
    const textIndex = await loadKnowledgeIndex(emptyText)
    expect(() => textIndex.sqlite.chunks([0])).toThrow('chunk text must be a non-empty string')
    textIndex.sqlite.close()
  })

  it.each([
    ['HNSW object', (value: Record<string, unknown>) => { value['hnsw'] = null }, 'manifest hnsw must be an object'],
    ['HNSW fields', (value: Record<string, unknown>) => { record(value['hnsw'])['extra'] = true }, 'manifest hnsw fields are incompatible'],
    ['HNSW library', (value: Record<string, unknown>) => { record(value['hnsw'])['library'] = 'other' }, 'manifest HNSW configuration is unsupported'],
    ['HNSW version', (value: Record<string, unknown>) => { record(value['hnsw'])['libraryVersion'] = 'other' }, 'manifest HNSW configuration is unsupported'],
    ['HNSW metric', (value: Record<string, unknown>) => { record(value['hnsw'])['metric'] = 'l2' }, 'manifest HNSW configuration is unsupported'],
    ['HNSW dtype', (value: Record<string, unknown>) => { record(value['hnsw'])['dtype'] = 'f16' }, 'manifest HNSW configuration is unsupported'],
    ['HNSW connectivity', (value: Record<string, unknown>) => { record(value['hnsw'])['connectivity'] = 0 }, 'manifest HNSW configuration is unsupported'],
    ['HNSW expansion', (value: Record<string, unknown>) => { record(value['hnsw'])['expansionAdd'] = 0 }, 'manifest HNSW configuration is unsupported'],
    ['HNSW without Dense', (value: Record<string, unknown>) => { delete value['dense'] }, 'manifest HNSW payload requires Dense metadata'],
    ['HNSW with Exact default', (value: Record<string, unknown>) => { record(value['dense'])['autoDenseIndex'] = 'exact' }, 'manifest Dense autoDenseIndex is inconsistent'],
  ] as const)('rejects invalid %s metadata', async (_name, mutate, message) => {
    const indexDir = await createIndex('hnsw')
    await rewriteManifest(indexDir, mutate)
    await expect(loadKnowledgeIndex(indexDir)).rejects.toThrow(message)
  })

  it('rejects Dense count and automatic-selection inconsistencies', async () => {
    const count = await createIndex()
    await rewriteManifest(count, (value) => {
      record(value['dense'])['vectorCount'] = 1
      record(value['dense'])['scanElements'] = DENSE_DIMENSIONS
    })
    await expect(loadKnowledgeIndex(count)).rejects.toThrow('Dense vectorCount does not match')

    const automatic = await createIndex()
    await rewriteManifest(automatic, (value) => { record(value['dense'])['autoDenseIndex'] = 'hnsw' })
    await expect(loadKnowledgeIndex(automatic)).rejects.toThrow('Dense autoDenseIndex is inconsistent')

    const payload = await createIndex('exact')
    await rewriteManifest(payload, (value) => {
      record(value['dense'])['requestedIndex'] = 'hnsw'
      record(value['dense'])['resolvedIndex'] = 'hnsw'
      record(value['dense'])['autoDenseIndex'] = 'hnsw'
    })
    await expect(loadKnowledgeIndex(payload)).rejects.toThrow('HNSW payload selection is inconsistent')

    const recommendation = await createIndex()
    await rewriteManifest(recommendation, (value) => { record(value['dense'])['recommendedIndex'] = 'hnsw' })
    await expect(loadKnowledgeIndex(recommendation)).rejects.toThrow('Dense recommendation is inconsistent')

    const resolved = await createIndex('exact')
    await rewriteManifest(resolved, (value) => { record(value['dense'])['resolvedIndex'] = 'both' })
    await expect(loadKnowledgeIndex(resolved)).rejects.toThrow('Dense resolvedIndex is inconsistent')
  })

  it('accepts automatic HNSW selection above the exact scan threshold', async () => {
    const indexDir = await createIndex('hnsw')
    await rewriteManifest(indexDir, (value) => {
      const dense = record(value['dense'])
      dense['requestedIndex'] = 'auto'
      dense['exactScanMaxElements'] = 1
      dense['recommendedIndex'] = 'hnsw'
    })
    const loaded = await loadKnowledgeIndex(indexDir)
    expect(loaded.manifest.dense?.autoDenseIndex).toBe('hnsw')
    loaded.sqlite.close()
  })

  it('loads HNSW-only and dual-payload indexes with explicit capabilities', async () => {
    const hnswOnly = await loadKnowledgeIndex(await createIndex('hnsw'))
    expect(hnswOnly.dense).toBeUndefined()
    expect(hnswOnly.hnsw).toBeDefined()
    hnswOnly.sqlite.close()

    const both = await loadKnowledgeIndex(await createIndex('both'))
    expect(both.dense).toBeDefined()
    expect(both.hnsw).toBeDefined()
    expect(both.manifest.dense?.resolvedIndex).toBe('both')
    both.sqlite.close()
  })

  it('rejects missing, non-file, and hash-mismatched payloads', async () => {
    await expect(loadKnowledgeIndex(await temporaryDirectory())).rejects.toThrow('manifest.json cannot be read')

    const missing = await createIndex()
    await unlink(join(missing, 'knowledge.sqlite'))
    await expect(loadKnowledgeIndex(missing)).rejects.toThrow('knowledge.sqlite cannot be read')

    const directory = await createIndex()
    await unlink(join(directory, 'knowledge.sqlite'))
    await mkdir(join(directory, 'knowledge.sqlite'))
    await expect(loadKnowledgeIndex(directory)).rejects.toThrow('knowledge.sqlite size does not match manifest')

    const mismatch = await createIndex()
    const path = join(mismatch, 'knowledge.sqlite')
    await writeFile(path, Buffer.alloc((await stat(path)).size))
    await expect(verifyKnowledgeIndex(mismatch)).rejects.toThrow('knowledge.sqlite hash does not match manifest')
  })

  it('checks Dense size at manifest load and values on lazy materialization', async () => {
    const shortIndex = await createIndex()
    await rewritePayload(shortIndex, 'dense.f32le', Buffer.alloc(4))
    await expect(loadKnowledgeIndex(shortIndex)).rejects.toThrow('byte length does not match')

    const nanIndex = await createIndex()
    const dense = await readFile(join(nanIndex, 'dense.f32le'))
    dense.writeFloatLE(Number.NaN, 0)
    await rewritePayload(nanIndex, 'dense.f32le', dense)
    const loaded = await loadKnowledgeIndex(nanIndex)
    await expect(loadDenseVectors(loaded)).rejects.toThrow('contains a non-finite value')
    loaded.sqlite.close()

    const bm25Only = join(await temporaryDirectory(), 'bm25-only')
    await buildKnowledgeIndex({
      corpusText: '{"id":"doc","text":"alpha"}',
      outputDir: bm25Only,
      tokenizer: whitespaceTokenizer,
      chunking: { maxTokens: 8, overlapTokens: 0 },
    })
    const withoutDense = await loadKnowledgeIndex(bm25Only)
    await expect(loadDenseVectors(withoutDense)).rejects.toThrow('dense.f32le is unavailable')
    withoutDense.sqlite.close()

    const removedDense = await createIndex()
    const removed = await loadKnowledgeIndex(removedDense)
    await unlink(join(removedDense, 'dense.f32le'))
    await expect(loadDenseVectors(removed)).rejects.toThrow('dense.f32le cannot be read')
    removed.sqlite.close()
  })

  it('verifies and closes a complete index', async () => {
    const indexDir = await createIndex('hnsw')
    await expect(verifyKnowledgeIndex(indexDir)).resolves.toMatchObject({
      formatVersion: 3,
      hnsw: { library: 'usearch' },
    })
  })
})
