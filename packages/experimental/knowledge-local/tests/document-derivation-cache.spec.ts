import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KnowledgeChunkId, KnowledgeDocumentId } from '@deepseek-ai/dsh-experimental-knowledge'
import { afterEach, describe, expect, it } from 'vitest'
import type { CorpusDocument } from '../src/corpus.ts'
import {
  BM25_PREPROCESS_IMPLEMENTATION_VERSION,
  DOCUMENT_DERIVATION_CACHE_FILE,
  DOCUMENT_DERIVATION_IMPLEMENTATION_VERSION,
  DocumentDerivationCache,
  documentDerivationCacheKey,
  documentDerivationConfigSha256,
  type DerivedDocument,
  type DocumentDerivationCacheConfig,
} from '../src/document-derivation-cache.ts'

const temporaryDirectories: string[] = []
const config: DocumentDerivationCacheConfig = {
  tokenizerModelId: 'test-tokenizer',
  tokenizerRevision: 'a'.repeat(40),
  chunkingStrategy: 'markdown-structure-v1',
  maxTokens: 32,
  overlapTokens: 4,
  analyzer: 'mixed-zh-en-v1',
  bm25ImplementationVersion: BM25_PREPROCESS_IMPLEMENTATION_VERSION,
  implementationVersion: DOCUMENT_DERIVATION_IMPLEMENTATION_VERSION,
}
const source = {
  id: KnowledgeDocumentId('doc'),
  title: 'Title',
  text: 'alpha beta',
}
const derived: DerivedDocument = {
  documentId: source.id,
  title: source.title,
  chunks: [{
    id: KnowledgeChunkId('doc:0-2'),
    text: source.text,
    startToken: 0,
    endToken: 2,
    denseText: 'Title\nalpha beta',
    bm25Text: 'w_title w_alpha w_beta',
  }],
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-document-cache-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('document derivation cache', () => {
  it('addresses configuration, id, title, and text while excluding projected metadata', () => {
    expect(documentDerivationConfigSha256(config)).toMatch(/^[a-f0-9]{64}$/u)
    const key = documentDerivationCacheKey(config, source)
    const metadataOnly: CorpusDocument = {
      ...source,
      source: 'other',
      sourceVersion: '2',
      validFrom: '2026-01-01T00:00:00.000Z',
    }
    expect(key).toBe(documentDerivationCacheKey(config, metadataOnly))
    expect(key).not.toBe(documentDerivationCacheKey(config, { ...source, title: 'Other' }))
    expect(key).not.toBe(documentDerivationCacheKey(config, { ...source, text: 'alpha beta ' }))
    expect(key).not.toBe(documentDerivationCacheKey({ ...config, analyzer: 'english-v1' }, source))
  })

  it('commits complete batches and reopens validated derivations', async () => {
    const directory = await temporaryDirectory()
    const key = documentDerivationCacheKey(config, source)
    const cache = await DocumentDerivationCache.open(directory, config)
    expect(cache.getMany([{ key, document: source }])).toEqual(new Map())
    expect(cache.putMany([{ key, document: derived }])).toBe(1)
    expect(cache.putMany([{ key, document: derived }])).toBe(0)
    cache.close()

    const reopened = await DocumentDerivationCache.open(directory, config)
    expect(reopened.getMany([{ key, document: source }, { key, document: source }]).get(key)).toEqual(derived)
    reopened.close()
    reopened.close()
  })

  it('preserves an absent title and a present section path', async () => {
    const directory = await temporaryDirectory()
    const untitled = { id: KnowledgeDocumentId('untitled'), text: 'alpha' }
    const value: DerivedDocument = {
      documentId: untitled.id,
      chunks: [{
        id: KnowledgeChunkId('untitled:0-1'),
        sectionPath: 'Section',
        text: 'alpha',
        startToken: 0,
        endToken: 1,
        denseText: 'Section\nalpha',
        bm25Text: 'w_section w_alpha',
      }],
    }
    const key = documentDerivationCacheKey(config, untitled)
    const cache = await DocumentDerivationCache.open(directory, config)
    cache.putMany([{ key, document: value }])
    expect(cache.getMany([{ key, document: untitled }]).get(key)).toEqual(value)
    cache.close()
  })

  it('rejects an invalid write without exposing another row from the transaction', async () => {
    const directory = await temporaryDirectory()
    const cache = await DocumentDerivationCache.open(directory, config)
    const validKey = documentDerivationCacheKey(config, source)
    expect(() => cache.putMany([
      { key: validKey, document: derived },
      {
        key: 'invalid-key',
        document: derived,
      },
    ])).toThrow('CHECK constraint failed')
    expect(cache.getMany([{ key: validKey, document: source }])).toEqual(new Map())
    cache.close()
  })

  it('rejects corrupted digests, JSON, identity, order, and Dense input', async () => {
    const corrupt = async (sql: string, message: string) => {
      const directory = await temporaryDirectory()
      const key = documentDerivationCacheKey(config, source)
      const cache = await DocumentDerivationCache.open(directory, config)
      cache.putMany([{ key, document: derived }])
      cache.close()
      const database = new DatabaseSync(join(directory, DOCUMENT_DERIVATION_CACHE_FILE))
      database.exec('PRAGMA ignore_check_constraints = ON')
      database.exec(sql.replaceAll('$KEY', key).replaceAll('$CONFIG', documentDerivationConfigSha256(config)))
      database.close()
      const corrupted = await DocumentDerivationCache.open(directory, config)
      expect(() => corrupted.getMany([{ key, document: source }])).toThrow(message)
      corrupted.close()
    }

    const corruptPayload = async (transform: (payload: string) => string, message: string) => {
      const directory = await temporaryDirectory()
      const key = documentDerivationCacheKey(config, source)
      const cache = await DocumentDerivationCache.open(directory, config)
      cache.putMany([{ key, document: derived }])
      cache.close()
      const database = new DatabaseSync(join(directory, DOCUMENT_DERIVATION_CACHE_FILE))
      const row = database.prepare('SELECT payload FROM derived_documents WHERE cache_key = ?').get(key) as { payload: Uint8Array }
      const payload = Buffer.from(transform(Buffer.from(row.payload).toString('utf8')))
      database.prepare('UPDATE derived_documents SET payload = ?, payload_sha256 = ? WHERE cache_key = ?').run(
        payload,
        createHash('sha256').update(payload).digest('hex'),
        key,
      )
      database.close()
      const corrupted = await DocumentDerivationCache.open(directory, config)
      expect(() => corrupted.getMany([{ key, document: source }])).toThrow(message)
      corrupted.close()
    }

    await corrupt("UPDATE derived_documents SET config_sha256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'", 'incompatible configuration digest')
    await corrupt("UPDATE derived_documents SET payload_sha256 = 'bad'", 'invalid payload digest')
    await corrupt("UPDATE derived_documents SET payload = x'7b'", 'payload digest mismatch')
    await corruptPayload(() => '{', 'invalid JSON')
    await corruptPayload(() => 'null', 'invalid document')
    await corruptPayload(() => '"document"', 'invalid document')
    await corruptPayload(() => '[]', 'invalid document')
    await corruptPayload(payload => payload.replace(',"title":"Title"', ''), 'invalid document fields')
    await corruptPayload(payload => payload.replace('"title":', '"wrong":'), 'invalid document fields')
    await corruptPayload(payload => payload.replace('"documentId":"doc"', '"documentId":"bad"'), 'incompatible document identity')
    await corruptPayload(payload => payload.replace('"title":"Title"', '"title":"Other"'), 'incompatible document identity')
    await corruptPayload(payload => payload.replace(/"chunks":\[[\s\S]*\]\}/u, '"chunks":{}}'), 'no chunks')
    await corruptPayload(payload => payload.replace(/"chunks":\[[\s\S]*\]\}/u, '"chunks":[]}'), 'no chunks')
    await corruptPayload(payload => payload.replace(/"chunks":\[[\s\S]*\]\}/u, '"chunks":[null]}'), 'invalid chunk')
    await corruptPayload(payload => payload.replace('"sectionPath":null', '"sectionPath":1'), 'invalid chunk section path')
    await corruptPayload(payload => payload.replace('"sectionPath":null', '"sectionPath":""'), 'invalid chunk section path')
    await corruptPayload(payload => payload.replace('"id":"doc:0-2"', '"id":1'), 'invalid chunk id')
    await corruptPayload(payload => payload.replace('"id":"doc:0-2"', '"id":""'), 'invalid chunk id')
    await corruptPayload(payload => payload.replace('"text":"alpha beta"', '"text":1'), 'invalid chunk text')
    await corruptPayload(payload => payload.replace('"text":"alpha beta"', '"text":""'), 'invalid chunk text')
    await corruptPayload(payload => payload.replace('"startToken":0', '"startToken":"0"'), 'invalid chunk start token')
    await corruptPayload(payload => payload.replace('"startToken":0', '"startToken":0.5'), 'invalid chunk start token')
    await corruptPayload(payload => payload.replace('"startToken":0', '"startToken":-1'), 'invalid chunk start token')
    await corruptPayload(payload => payload.replace('"endToken":2', '"endToken":0'), 'invalid chunk order or identity')
    await corruptPayload(payload => payload.replace('"id":"doc:0-2"', '"id":"wrong"'), 'invalid chunk order or identity')
    await corruptPayload(payload => payload.replace(']}', ',{"id":"doc:0-3","sectionPath":null,"text":"beta","startToken":0,"endToken":3,"denseText":"Title\\nbeta","bm25Text":"w_beta"}]}'), 'invalid chunk order or identity')
    await corruptPayload(payload => payload.replace(']}', ',{"id":"doc:1-2","sectionPath":null,"text":"beta","startToken":1,"endToken":2,"denseText":"Title\\nbeta","bm25Text":"w_beta"}]}'), 'invalid chunk order or identity')
    await corruptPayload(payload => payload.replace('"bm25Text":"w_title w_alpha w_beta"', '"bm25Text":1'), 'invalid BM25 text')
    await corruptPayload(payload => payload.replace('"denseText":"Title\\nalpha beta"', '"denseText":1'), 'invalid Dense input')
    await corruptPayload(payload => payload.replace('"denseText":"Title\\nalpha beta"', '"denseText":""'), 'invalid Dense input')
    await corruptPayload(payload => payload.replace('"denseText":"Title\\nalpha beta"', '"denseText":"wrong"'), 'invalid Dense input')
  })

  it('rejects an incompatible schema version', async () => {
    const directory = await temporaryDirectory()
    const database = new DatabaseSync(join(directory, DOCUMENT_DERIVATION_CACHE_FILE))
    database.exec('PRAGMA user_version = 2')
    database.close()
    await expect(DocumentDerivationCache.open(directory, config)).rejects.toThrow('schema version must be 1')
  })
})
