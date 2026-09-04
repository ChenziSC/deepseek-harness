import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractSciFactArchive,
  prepareSciFact,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('SciFact preparation', () => {
  it('extracts expected files and rejects traversal paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-scifact-'))
    temporaryDirectories.push(directory)
    await extractSciFactArchive(zipSync({
      'scifact/corpus.jsonl': new TextEncoder().encode('{"_id":"1","text":"body"}\n'),
      'scifact/qrels/test.tsv': new TextEncoder().encode('query-id\tcorpus-id\tscore\n'),
    }), directory)
    await expect(readFile(join(directory, 'scifact/corpus.jsonl'), 'utf8'))
      .resolves.toBe('{"_id":"1","text":"body"}\n')

    await expect(extractSciFactArchive(zipSync({
      '../escape.txt': new Uint8Array([1]),
    }), directory)).rejects.toThrow('unsafe SciFact archive path')
  })

  it('rejects an archive checksum mismatch before preparing models', async () => {
    const prepareDenseModel = vi.fn(() => Promise.resolve())
    const prepareRerankerModel = vi.fn(() => Promise.resolve())
    await expect(prepareSciFact('/unused-data', '/unused-models', {
      download: () => Promise.resolve(new Uint8Array([1, 2, 3])),
      prepareDenseModel,
      prepareRerankerModel,
    })).rejects.toThrow('MD5 mismatch')
    expect(prepareDenseModel).not.toHaveBeenCalled()
    expect(prepareRerankerModel).not.toHaveBeenCalled()
  })
})
