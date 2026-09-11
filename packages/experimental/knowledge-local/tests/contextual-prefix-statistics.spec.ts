import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { scanContextualPrefixCorpus } from '../src/offline/contextual-prefix/contextual-prefix-statistics.ts'
import type { ChunkTokenizer } from '../src/tokenizer.ts'

const tokenizer: ChunkTokenizer = {
  countTokens(text) {
    return text.match(/\S+/gu)?.length ?? 0
  },
}

const temporaryDirectories: string[] = []

async function fixture(name: string, content: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-context-statistics-'))
  temporaryDirectories.push(directory)
  const path = join(directory, name)
  await writeFile(path, content)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function options(corpusPath: string) {
  return {
    corpusPath,
    corpusFormat: 'generic' as const,
    tokenizer,
    chunking: { maxTokens: 2, overlapTokens: 0, strategy: 'token-window-v1' as const },
    planning: {
      detector: 'strict-v1' as const,
      target: 'dense' as const,
      maxCandidateRatio: 0.5,
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxPrefixTokens: 8,
      contextWindowTokens: 20,
      maxChunksPerRequest: 2,
      budgetAction: 'deterministic-fallback' as const,
      promptVersion: 'prefix-v1',
    },
    diagnosticSampleLimit: 2,
    sampleModulus: 1,
  }
}

describe('contextual prefix corpus statistics', () => {
  it('streams exact counts, bounded diagnostics, batching, and duplicate structure signals', async () => {
    const source = [
      JSON.stringify({ id: 'a', title: 'Specific Product', text: 'It works. They continue.' }),
      JSON.stringify({ id: 'b', title: 'Specific Product', text: 'See above. Currently active.' }),
      JSON.stringify({ id: 'c', title: 'Specific Product', text: 'However ready.' }),
      JSON.stringify({ id: 'd', title: 'Standalone', text: 'A complete statement.' }),
    ].join('\n')
    const path = await fixture('corpus.jsonl', source)
    const report = await scanContextualPrefixCorpus(options(path))

    expect(report).toMatchObject({
      schemaVersion: 1,
      measurement: 'exact',
      corpusSha256: createHash('sha256').update(source).digest('hex'),
      documentCount: 4,
      tokenizedDocumentCount: 4,
      sampleModulus: 1,
      maxCandidateRatio: 0.5,
      clippedCandidateCount: report.detectedCandidateCount - report.selectedCandidateCount,
      selectedInputTokensUpperBound: report.estimatedInputTokensAllCandidates,
      selectedMaximumOutputTokens: report.selectedCandidateCount * 8
        + Math.min(report.requestCount, report.selectedCandidateCount) * 128,
    })
    expect(report.chunkCount).toBeGreaterThan(report.documentCount)
    expect(report.detectedCandidateCount).toBeGreaterThan(3)
    expect(report.requestCount).toBeLessThanOrEqual(report.detectedCandidateCount)
    expect(report.mergedRequestReductionRatio).toBeGreaterThanOrEqual(0)
    expect(Object.values(report.risks).every(value => Number.isSafeInteger(value))).toBe(true)
    expect(report.signals['weak-structure']).toBeGreaterThanOrEqual(4)
    expect(report.diagnostics).toHaveLength(2)
  })

  it('accepts gzipped T2Ranking input and returns zero ratios for an empty corpus', async () => {
    const t2 = await fixture('collection.tsv.gz', gzipSync('pid\ttext\n\n1\tIt needs context.\n'))
    const t2Report = await scanContextualPrefixCorpus({ ...options(t2), corpusFormat: 't2ranking' })
    expect(t2Report).toMatchObject({ documentCount: 1, detectedCandidateCount: 1 })

    const empty = await fixture('empty.jsonl', '')
    const emptyReport = await scanContextualPrefixCorpus({ ...options(empty), diagnosticSampleLimit: 0 })
    expect(emptyReport).toMatchObject({
      documentCount: 0,
      chunkCount: 0,
      candidateRatio: 0,
      mergedRequestReductionRatio: 0,
      diagnostics: [],
    })

    const markdown = await fixture('markdown.jsonl', JSON.stringify({
      id: 'markdown',
      title: 'Specific Product',
      text: '# Dedicated Section\n\nIt needs context.',
    }))
    const markdownReport = await scanContextualPrefixCorpus({
      ...options(markdown),
      chunking: { maxTokens: 20, overlapTokens: 0, strategy: 'markdown-structure-v1' },
    })
    expect(markdownReport.detectedCandidateCount).toBe(1)
  })

  it('rejects an invalid diagnostic sample limit', async () => {
    const path = await fixture('corpus.jsonl', '{"id":"a","text":"It needs context."}\n')
    await expect(scanContextualPrefixCorpus({ ...options(path), diagnosticSampleLimit: -1 }))
      .rejects.toThrow('diagnosticSampleLimit')
    await expect(scanContextualPrefixCorpus({ ...options(path), sampleModulus: 0 }))
      .rejects.toThrow('sampleModulus')
  })

  it('estimates aggregate counts from a deterministic hash sample', async () => {
    const source = Array.from({ length: 20 }, (_, index) => JSON.stringify({
      id: `doc-${index}`,
      text: index % 2 === 0 ? 'It needs context.' : 'A standalone statement.',
    })).join('\n')
    const path = await fixture('sampled.jsonl', source)
    const report = await scanContextualPrefixCorpus({ ...options(path), sampleModulus: 2 })

    expect(report.measurement).toBe('sampled-estimate')
    expect(report.documentCount).toBe(20)
    expect(report.tokenizedDocumentCount).toBeGreaterThan(0)
    expect(report.tokenizedDocumentCount).toBeLessThan(20)
    expect(report.chunkCount).toBeGreaterThanOrEqual(report.tokenizedDocumentCount)
  })
})
