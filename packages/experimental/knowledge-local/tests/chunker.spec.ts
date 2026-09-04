import { describe, expect, it } from 'vitest'
import {
  chunkDocuments,
  parseCorpusJsonl,
  type ChunkTokenizer,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

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
      '{"id":"a/b","text":"a1 a2 a3 a4 a5"}',
    ].join('\n'))
    const chunks = chunkDocuments(documents, whitespaceTokenizer, { maxTokens: 3, overlapTokens: 1 })

    expect(chunks.map(chunk => ({ ordinal: chunk.ordinal, id: chunk.id, text: chunk.text }))).toEqual([
      { ordinal: 0, id: 'a%2Fb:0-3', text: 'a1 a2 a3' },
      { ordinal: 1, id: 'a%2Fb:2-5', text: 'a3 a4 a5' },
      { ordinal: 2, id: 'b:0-3', text: 'b1 b2 b3' },
      { ordinal: 3, id: 'b:2-5', text: 'b3 b4 b5' },
    ])
  })

  it('rejects overlap that cannot make progress', () => {
    const documents = parseCorpusJsonl('{"id":"doc","text":"one two"}')
    expect(() => chunkDocuments(documents, whitespaceTokenizer, { maxTokens: 2, overlapTokens: 2 }))
      .toThrow('overlapTokens must be a non-negative safe integer below maxTokens')
  })
})
