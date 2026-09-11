import { describe, expect, it } from 'vitest'
import { denseInputFromRow } from '../src/sqlite-rows.ts'

const validRow = {
  ordinal: 0,
  chunk_id: 'doc:0-1',
  document_id: 'doc',
  title: null,
  section_path: null,
  text: 'body',
}

describe('SQLite Dense input rows', () => {
  it.each([
    ['ordinal', { ordinal: -1 }, 'chunk ordinal'],
    ['chunk id', { chunk_id: '' }, 'chunk id'],
    ['document id', { document_id: '' }, 'document id'],
    ['text', { text: '' }, 'chunk text'],
    ['title', { title: 1 }, 'chunk title'],
    ['section path', { section_path: 1 }, 'chunk section path'],
  ])('rejects an invalid %s', (_label, replacement, message) => {
    expect(() => denseInputFromRow({ ...validRow, ...replacement })).toThrow(message)
  })
})
