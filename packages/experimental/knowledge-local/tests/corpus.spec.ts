import { describe, expect, it } from 'vitest'
import {
  CorpusFormatError,
  parseCorpusDocumentLine,
  parseCorpusJsonl,
  parseMldrQueriesJsonl,
  parseSciFactCorpusJsonl,
  parseSciFactQrelsTsv,
  parseSciFactQueriesJsonl,
  parseT2RankingQrelsTsv,
  parseT2RankingQueriesTsv,
  parseTrecQrelsTsv,
} from '../src/corpus.ts'

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

  it('normalizes source version, validity, and replacement metadata', () => {
    expect(parseCorpusJsonl(JSON.stringify({
      id: 'policy-v2',
      title: 'Policy',
      source: 'handbook',
      sourceVersion: '2026.02',
      validFrom: '2026-02-01T08:00:00+08:00',
      validUntil: '2026-06-01T00:00:00Z',
      supersedes: 'policy-v1',
      text: 'Current policy.',
    }))).toEqual([{
      id: 'policy-v2',
      title: 'Policy',
      source: 'handbook',
      sourceVersion: '2026.02',
      validFrom: '2026-02-01T00:00:00.000Z',
      validFromMs: Date.parse('2026-02-01T00:00:00.000Z'),
      validUntil: '2026-06-01T00:00:00.000Z',
      validUntilMs: Date.parse('2026-06-01T00:00:00.000Z'),
      supersedes: 'policy-v1',
      text: 'Current policy.',
    }])
  })

  it.each([
    [{ sourceVersion: '   ' }, 'sourceVersion must be a non-empty string'],
    [{ sourceVersion: 1 }, 'sourceVersion must be a string'],
    [{ validFrom: '2026-02-01' }, 'validFrom must be an RFC 3339 timestamp with an explicit timezone'],
    [{ validUntil: '2026-02-30T00:00:00Z' }, 'validUntil must be a valid RFC 3339 timestamp'],
    [{ validFrom: '2026-02-01T00:00:00Z', validUntil: '2026-02-01T00:00:00Z' }, 'validFrom must be earlier than validUntil'],
    [{ supersedes: 1 }, 'supersedes must be a string'],
    [{ supersedes: 'doc' }, 'supersedes must differ from id'],
  ])('rejects invalid version metadata %j', (metadata, message) => {
    expect(() => parseCorpusJsonl(JSON.stringify({ id: 'doc', text: 'body', ...metadata }), 'fixture.jsonl'))
      .toThrow(`fixture.jsonl:1: ${message}`)
  })

  it.each([
    ['{', 'invalid JSON'],
    ['null', 'expected a JSON object'],
    ['[]', 'expected a JSON object'],
    ['1', 'expected a JSON object'],
    ['{"id":"","text":"body"}', 'id must be a non-empty string'],
    ['{"id":"a","text":1}', 'text must be a non-empty string'],
    ['{"id":"a","text":"body","title":1}', 'title must be a string'],
    ['{"id":"a","text":"body","source":1}', 'source must be a string'],
  ])('rejects malformed generic corpus input %j', (input, message) => {
    expect(() => parseCorpusJsonl(input, 'fixture.jsonl')).toThrow(`fixture.jsonl:1: ${message}`)
  })
})

describe('MLDR adapter', () => {
  it('maps corpus, queries, and TREC qrels', () => {
    expect(parseCorpusDocumentLine('{"docid":"d-1","text":"中文 document"}', 'mldr', 'corpus.jsonl', 1))
      .toEqual({ id: 'd-1', text: '中文 document' })
    const queries = parseMldrQueriesJsonl([
      '{"query_id":"q-2","query":"second","positive_passages":[],"negative_passages":[]}',
      '{"query_id":"q-1","query":"第一","positive_passages":[{"docid":"d-1"}],"negative_passages":[]}',
    ].join('\n'))
    expect(queries.map(query => query.id)).toEqual(['q-1', 'q-2'])
    expect(parseTrecQrelsTsv('q-1 Q0 d-1 2\nq-2 Q0 d-2 1\n', queries, new Set(['d-1', 'd-2'])))
      .toEqual([
        { id: 'q-1', text: '第一', relevantDocuments: [{ documentId: 'd-1', relevance: 2 }] },
        { id: 'q-2', text: 'second', relevantDocuments: [{ documentId: 'd-2', relevance: 1 }] },
      ])
  })

  it('rejects malformed MLDR records and qrels references', () => {
    expect(() => parseCorpusDocumentLine('{"docid":"d","text":"body","extra":true}', 'mldr', 'corpus.jsonl', 4))
      .toThrow('corpus.jsonl:4: unknown field "extra"')
    expect(() => parseMldrQueriesJsonl('{"query_id":"q","query":"one"}\n{"query_id":"q","query":"two"}'))
      .toThrow('duplicate query id "q"')
    const queries = parseMldrQueriesJsonl('{"query_id":"q","query":"one","positive_passages":[],"negative_passages":[]}')
    expect(() => parseTrecQrelsTsv('q Q0 missing 1', queries, new Set(['d'])))
      .toThrow('unknown document id "missing"')
  })

  it.each([
    ['q Q0 d', 'expected four TREC qrels fields'],
    ['q Q0 d NaN', 'score must be finite'],
    ['missing Q0 d 1', 'unknown query id "missing"'],
    ['q Q0 d 1\nq Q0 d 2', 'duplicate query and document judgment'],
  ])('rejects malformed TREC qrels %j', (qrels, message) => {
    const queries = parseMldrQueriesJsonl('{"query_id":"q","query":"one","positive_passages":[],"negative_passages":[]}')
    expect(() => parseTrecQrelsTsv(qrels, queries, new Set(['d']))).toThrow(message)
  })

  it('ignores non-positive TREC judgments and sorts multiple positives', () => {
    const queries = parseMldrQueriesJsonl('{"query_id":"q","query":"one","positive_passages":[],"negative_passages":[]}')
    expect(parseTrecQrelsTsv('q Q0 d2 2\nq Q0 ignored 0\nq Q0 d1 1', queries, new Set(['d1', 'd2', 'ignored'])))
      .toEqual([{ id: 'q', text: 'one', relevantDocuments: [
        { documentId: 'd1', relevance: 1 },
        { documentId: 'd2', relevance: 2 },
      ] }])
  })
})

describe('T2Ranking adapter', () => {
  it('maps collection, queries, and binary retrieval qrels', () => {
    expect(parseCorpusDocumentLine('p-1\t中文 passage', 't2ranking', 'collection.tsv', 2))
      .toEqual({ id: 'p-1', text: '中文 passage' })
    const queries = parseT2RankingQueriesTsv('qid\ttext\nq-2\t第二\nq-1\t第一\n')
    expect(queries.map(query => query.id)).toEqual(['q-1', 'q-2'])
    expect(parseT2RankingQrelsTsv('qid\tpid\nq-1\tp-1\n', queries, new Set(['p-1'])))
      .toEqual([{ id: 'q-1', text: '第一', relevantDocuments: [{ documentId: 'p-1', relevance: 1 }] }])
  })

  it('requires headers and exactly two collection columns', () => {
    expect(() => parseT2RankingQueriesTsv('q-1\ttext')).toThrow('expected header qid, text')
    expect(() => parseT2RankingQrelsTsv('q-1\tp-1', [], new Set())).toThrow('expected header qid, pid')
    expect(() => parseCorpusDocumentLine('p-1\tbody\textra', 't2ranking', 'collection.tsv', 2))
      .toThrow('expected pid and text separated by one tab')
    expect(() => parseCorpusDocumentLine('pid\ttext', 't2ranking', 'collection.tsv', 1))
      .toThrow('header must be skipped')
  })

  it('rejects malformed and duplicate T2Ranking rows', () => {
    expect(() => parseT2RankingQueriesTsv('qid\ttext\nmissing-tab')).toThrow('expected qid and text separated by one tab')
    expect(() => parseT2RankingQueriesTsv('qid\ttext\nq\tone\nq\ttwo')).toThrow('duplicate query id "q"')
    const queries = parseT2RankingQueriesTsv('qid\ttext\nq\tone')
    expect(() => parseT2RankingQrelsTsv('qid\tpid\nq\td\textra', queries, new Set(['d'])))
      .toThrow('expected four TREC qrels fields')
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

  it('rejects malformed SciFact corpus and query metadata', () => {
    expect(() => parseSciFactCorpusJsonl('{"_id":"1","text":"Alpha","metadata":[]}'))
      .toThrow('metadata must be an object')
    expect(() => parseSciFactCorpusJsonl('{"_id":"1","text":"Alpha","metadata":null}'))
      .toThrow('metadata must be an object')
    expect(() => parseSciFactQueriesJsonl('{"_id":"q","text":"Claim","metadata":[]}'))
      .toThrow('metadata must be an object')
    expect(() => parseSciFactQueriesJsonl('{"_id":"q","text":"Claim","metadata":null}'))
      .toThrow('metadata must be an object')
    expect(() => parseSciFactQueriesJsonl('{"_id":"q","text":"One"}\n{"_id":"q","text":"Two"}'))
      .toThrow('duplicate query id "q"')
    expect(() => parseSciFactQueriesJsonl('{"_id":"q","text":"Claim","extra":true}'))
      .toThrow('unknown field "extra"')
  })

  it.each([
    ['wrong header', 'expected header query-id, corpus-id, score'],
    ['query-id\tcorpus-id\tscore\nq-1\t1', 'expected three tab-separated fields'],
    ['query-id\tcorpus-id\tscore\n\t1\t1', 'query-id must be a non-empty string'],
    ['query-id\tcorpus-id\tscore\nq-1\t\t1', 'corpus-id must be a non-empty string'],
    ['query-id\tcorpus-id\tscore\nq-1\t1\tNaN', 'score must be a finite number'],
    ['query-id\tcorpus-id\tscore\nq-1\tmissing\t1', 'unknown document id "missing"'],
  ])('rejects malformed qrels %j', (input, message) => {
    const documents = parseSciFactCorpusJsonl('{"_id":"1","text":"Alpha"}')
    const queries = parseSciFactQueriesJsonl('{"_id":"q-1","text":"Claim"}')
    expect(() => parseSciFactQrelsTsv(input, queries, documents)).toThrow(message)
  })

  it('ignores blank qrel rows and sorts multiple positive documents', () => {
    const documents = parseSciFactCorpusJsonl([
      '{"_id":"2","text":"Beta"}',
      '{"_id":"1","text":"Alpha"}',
    ].join('\n'))
    const queries = parseSciFactQueriesJsonl('{"_id":"q-1","text":"Claim"}')
    expect(parseSciFactQrelsTsv([
      'query-id\tcorpus-id\tscore\r',
      '',
      'q-1\t2\t2\r',
      'q-1\t1\t1',
      '',
    ].join('\n'), queries, documents)[0]?.relevantDocuments).toEqual([
      { documentId: '1', relevance: 1 },
      { documentId: '2', relevance: 2 },
    ])
  })
})
