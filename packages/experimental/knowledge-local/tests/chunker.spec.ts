import { describe, expect, it } from 'vitest'
import { chunkDocuments } from '../src/chunker.ts'
import type { ChunkTokenizer } from '../src/tokenizer.ts'
import { parseCorpusJsonl } from '../src/corpus.ts'

const whitespaceTokenizer: ChunkTokenizer = {
  countTokens(text) {
    return text.match(/\S+/gu)?.length ?? 0
  },
}

describe('deterministic chunking', () => {
  it('prefers paragraph, then sentence, then token limits', () => {
    const documents = parseCorpusJsonl('{"id":"doc","text":"One two.\\n\\nThree four five. Six seven eight nine."}')
    const chunks = chunkDocuments(documents, whitespaceTokenizer, { maxTokens: 4, overlapTokens: 0 })

    expect(chunks.map(chunk => chunk.text)).toEqual([
      'One two.',
      'Three four five.',
      'Six seven eight nine.',
    ])
    expect(chunks.map(chunk => [chunk.startToken, chunk.endToken])).toEqual([[0, 2], [2, 5], [5, 9]])
  })

  it('uses token overlap and stable document ordering', () => {
    const documents = parseCorpusJsonl([
      '{"id":"b","text":"b1 b2 b3 b4 b5"}',
      '{"id":"a/b","title":"A","text":"a1 a2 a3 a4 a5","source":"fixture"}',
    ].join('\n'))
    const chunks = chunkDocuments(documents, whitespaceTokenizer, { maxTokens: 3, overlapTokens: 1 })

    expect(chunks.map(chunk => ({ ordinal: chunk.ordinal, id: chunk.id, text: chunk.text }))).toEqual([
      { ordinal: 0, id: 'a%2Fb:0-3', text: 'a1 a2 a3' },
      { ordinal: 1, id: 'a%2Fb:2-5', text: 'a3 a4 a5' },
      { ordinal: 2, id: 'b:0-3', text: 'b1 b2 b3' },
      { ordinal: 3, id: 'b:2-5', text: 'b3 b4 b5' },
    ])
    expect(chunks[0]).toMatchObject({ title: 'A', source: 'fixture' })
  })

  it('uses Markdown heading paths and keeps a bounded fenced code block intact', () => {
    const fence = '```'
    const text = [
      '# Guide',
      'intro words',
      '',
      '## Install',
      `${fence}ts`,
      'const value = 1',
      fence,
      '',
      'closing words',
    ].join('\n')
    const chunks = chunkDocuments(
      parseCorpusJsonl(`${JSON.stringify({ id: 'markdown', text })}\n`),
      whitespaceTokenizer,
      { maxTokens: 8, overlapTokens: 0 },
    )

    expect(chunks.map(chunk => ({ sectionPath: chunk.sectionPath, text: chunk.text }))).toEqual([
      { sectionPath: 'Guide', text: '# Guide\nintro words' },
      { sectionPath: 'Guide > Install', text: '## Install\n```ts\nconst value = 1\n```' },
      { sectionPath: 'Guide > Install', text: 'closing words' },
    ])
  })

  it('supports a token-window baseline without Markdown boundary preference or section paths', () => {
    const text = ['# Guide', 'intro words', '', '## Install', 'one two three four'].join('\n')
    const chunks = chunkDocuments(
      parseCorpusJsonl(`${JSON.stringify({ id: 'markdown', text })}\n`),
      whitespaceTokenizer,
      { maxTokens: 4, overlapTokens: 0, strategy: 'token-window-v1' },
    )

    expect(chunks.map(chunk => ({ sectionPath: chunk.sectionPath, text: chunk.text }))).toEqual([
      { sectionPath: undefined, text: '# Guide\nintro words' },
      { sectionPath: undefined, text: '## Install\none two' },
      { sectionPath: undefined, text: 'three four' },
    ])
  })

  it('falls back to token limits for oversized or unclosed code fences', () => {
    const fence = '```'
    const text = ['# Code', fence, 'one two three four five six'].join('\n')
    const chunks = chunkDocuments(
      parseCorpusJsonl(`${JSON.stringify({ id: 'long-code', text })}\n`),
      whitespaceTokenizer,
      { maxTokens: 3, overlapTokens: 0 },
    )

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.sectionPath === 'Code')).toBe(true)
    expect(chunks.every(chunk => whitespaceTokenizer.countTokens(chunk.text) <= 3)).toBe(true)
  })

  it('advances past a short boundary when overlap covers the complete chunk', () => {
    const documents = parseCorpusJsonl('{"id":"doc","text":"One. Two three four five."}')
    expect(chunkDocuments(documents, whitespaceTokenizer, { maxTokens: 4, overlapTokens: 3 })
      .map(chunk => chunk.text)).toEqual(['One.', 'Two three four five.'])
  })

  it('does not emit an overlap-only tail before trailing whitespace', () => {
    const documents = parseCorpusJsonl('{"id":"doc","text":"one two three\\n\\n"}')
    expect(chunkDocuments(documents, whitespaceTokenizer, { maxTokens: 3, overlapTokens: 1 })
      .map(chunk => [chunk.startToken, chunk.endToken, chunk.text])).toEqual([[0, 3, 'one two three']])
  })

  it('handles astral code points without splitting surrogate pairs', () => {
    const codePointTokenizer: ChunkTokenizer = { countTokens: text => Array.from(text).length }
    expect(chunkDocuments(
      parseCorpusJsonl('{"id":"emoji","text":"😀a"}'),
      codePointTokenizer,
      { maxTokens: 1, overlapTokens: 0 },
    ).map(chunk => chunk.text)).toEqual(['😀', 'a'])
  })

  it('assigns a non-empty interval when a tokenizer reports no content tokens', () => {
    const zeroTokenizer: ChunkTokenizer = { countTokens: () => 0 }
    const chunks = chunkDocuments(
      parseCorpusJsonl('{"id":"symbol","text":"※"}'),
      zeroTokenizer,
      { maxTokens: 1, overlapTokens: 0 },
    )

    expect(chunks).toMatchObject([{ id: 'symbol:0-1', startToken: 0, endToken: 1, text: '※' }])
  })

  it('binary-searches when the initial code-point window exceeds the token limit', () => {
    const doubleTokenizer: ChunkTokenizer = { countTokens: text => Array.from(text).length * 2 }
    expect(chunkDocuments(
      parseCorpusJsonl('{"id":"dense","text":"abcd"}'),
      doubleTokenizer,
      { maxTokens: 3, overlapTokens: 0 },
    ).map(chunk => chunk.text)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('bounds tokenizer probes by the local chunk window for long documents', () => {
    let longestProbe = 0
    const tokenizer: ChunkTokenizer = {
      countTokens(text) {
        longestProbe = Math.max(longestProbe, text.length)
        return Array.from(text).length
      },
    }
    const text = 'a'.repeat(2_000)
    const chunks = chunkDocuments(
      parseCorpusJsonl(`${JSON.stringify({ id: 'long', text })}\n`),
      tokenizer,
      { maxTokens: 10, overlapTokens: 2 },
    )

    expect(chunks).toHaveLength(250)
    expect(chunks.slice(0, 3).map(chunk => [chunk.startToken, chunk.endToken])).toEqual([
      [0, 10],
      [8, 18],
      [16, 26],
    ])
    expect(longestProbe).toBeLessThanOrEqual(20)
  })

  it.each([
    { maxTokens: 0, overlapTokens: 0 },
    { maxTokens: 1.5, overlapTokens: 0 },
  ])('rejects invalid maximum token counts: %j', (options) => {
    const documents = parseCorpusJsonl('{"id":"doc","text":"one two"}')
    expect(() => chunkDocuments(documents, whitespaceTokenizer, options))
      .toThrow('maxTokens must be a positive safe integer')
  })

  it.each([
    { maxTokens: 2, overlapTokens: -1 },
    { maxTokens: 2, overlapTokens: 0.5 },
    { maxTokens: 2, overlapTokens: 2 },
  ])('rejects invalid overlap: %j', (options) => {
    const documents = parseCorpusJsonl('{"id":"doc","text":"one two"}')
    expect(() => chunkDocuments(documents, whitespaceTokenizer, options))
      .toThrow('overlapTokens must be a non-negative safe integer below maxTokens')
  })
})
