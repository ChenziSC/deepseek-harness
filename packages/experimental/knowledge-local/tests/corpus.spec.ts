import { describe, expect, it } from 'vitest'
import {
  CorpusFormatError,
  parseCorpusJsonl,
  parseSciFactCorpusJsonl,
  parseSciFactQrelsTsv,
  parseSciFactQueriesJsonl,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

describe('generic corpus JSONL', () => {
  it('validates and sorts documents independently of line order', () => {
    const documents = parseCorpusJsonl([
      '{"id":"doc-b","text":"Beta"}',
      '',
      '{"id":"doc-a","title":"Alpha","text":"Body","source":"fixture"}',
      '',
    ].join('\n'))

    expect(documents).toEqual([
      { id: 'doc-a', title: 'Alpha', text: 'Body', source: 'fixture' },
      { id: 'doc-b', text: 'Beta' },
    ])
  })

  it('reports duplicate ids and unknown fields with a line number', () => {
    expect(() => parseCorpusJsonl('{"id":"a","text":"one"}\n{"id":"a","text":"two"}'))
      .toThrow(new CorpusFormatError('corpus.jsonl', 2, 'duplicate document id "a"'))
    expect(() => parseCorpusJsonl('{"id":"a","text":"one","extra":true}'))
      .toThrow('corpus.jsonl:1: unknown field "extra"')
  })
})

describe('SciFact adapter', () => {
  it('maps corpus and selects only queries referenced by test qrels', () => {
    const documents = parseSciFactCorpusJsonl([
      '{"_id":"2","title":"Second","text":"Beta","metadata":{}}',
      '{"_id":"1","title":"First","text":"Alpha"}',
    ].join('\n'))
    const queries = parseSciFactQueriesJsonl([
      '{"_id":"q-unused","text":"Unused"}',
      '{"_id":"q-1","text":"Claim","metadata":{"source":"fixture"}}',
    ].join('\n'))
    const selected = parseSciFactQrelsTsv([
      'query-id\tcorpus-id\tscore',
      'q-1\t2\t0',
      'q-1\t1\t1',
    ].join('\n'), queries, documents)

    expect(documents.map(document => document.id)).toEqual(['1', '2'])
    expect(selected).toEqual([{
      id: 'q-1',
      text: 'Claim',
      relevantDocuments: [{ documentId: '1', relevance: 1 }],
    }])
  })

  it('rejects unknown references, duplicate pairs, and queries without positives', () => {
    const documents = parseSciFactCorpusJsonl('{"_id":"1","title":"First","text":"Alpha"}')
    const queries = parseSciFactQueriesJsonl('{"_id":"q-1","text":"Claim"}')
    expect(() => parseSciFactQrelsTsv('query-id\tcorpus-id\tscore\nmissing\t1\t1', queries, documents))
      .toThrow('qrels/test.tsv:2: unknown query id "missing"')
    expect(() => parseSciFactQrelsTsv('query-id\tcorpus-id\tscore\nq-1\t1\t1\nq-1\t1\t2', queries, documents))
      .toThrow('qrels/test.tsv:3: duplicate query and document judgment')
    expect(() => parseSciFactQrelsTsv('query-id\tcorpus-id\tscore\nq-1\t1\t0', queries, documents))
      .toThrow('qrels/test.tsv:1: query "q-1" has no positive judgment')
  })
})
