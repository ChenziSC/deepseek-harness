/** Exact-vector derivation command adaptation for `dsh-knowledge`. */

import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { KnowledgeIndexBuildStats } from '../build/types.ts'
import { deriveKnowledgeIndexFromExact } from '../index-builder.ts'
import { loadKnowledgeIndex } from '../index-format.ts'
import { loadBgeChunkTokenizer } from '../tokenizer.ts'
import { corpusFormat, numberOption, required, type CliOutput } from './options.ts'

/** Derive one smaller index by copying an Exact-vector prefix. */
export async function runDerive(argv: readonly string[], stdout: CliOutput): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      'source-index': { type: 'string' },
      corpus: { type: 'string' },
      'corpus-format': { type: 'string', default: 't2ranking' },
      output: { type: 'string' },
      'model-cache-dir': { type: 'string' },
      'dense-index': { type: 'string', default: 'both' },
      'sqlite-batch-size': { type: 'string', default: '500' },
      'derived-cache-dir': { type: 'string' },
      'exact-scan-max-elements': { type: 'string' },
      connectivity: { type: 'string' },
      'expansion-add': { type: 'string' },
    },
  })
  const format = corpusFormat(values['corpus-format'])
  if (
    values['dense-index'] !== 'exact'
    && values['dense-index'] !== 'hnsw'
    && values['dense-index'] !== 'both'
  ) {
    throw new TypeError('--dense-index must be exact, hnsw, or both')
  }
  const sourceIndexDir = required(values['source-index'], 'source-index')
  const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
  const corpusPath = required(values.corpus, 'corpus')
  const outputDir = required(values.output, 'output')
  const source = await loadKnowledgeIndex(sourceIndexDir)
  const manifest = source.manifest
  source.sqlite.close()
  const tokenizer = await loadBgeChunkTokenizer({
    cacheDir: modelCacheDir,
    localFilesOnly: true,
    modelId: manifest.chunking.tokenizerModelId,
    revision: manifest.chunking.tokenizerRevision,
  })
  let indexBuildStats: KnowledgeIndexBuildStats | undefined
  const derived = await deriveKnowledgeIndexFromExact({
    sourceIndexDir,
    corpusPath,
    corpusSource: corpusPath,
    corpusFormat: format,
    outputDir,
    tokenizer,
    chunking: {
      maxTokens: manifest.chunking.maxTokens,
      overlapTokens: manifest.chunking.overlapTokens,
      strategy: manifest.chunking.strategy,
    },
    tokenizerModelId: manifest.chunking.tokenizerModelId,
    tokenizerRevision: manifest.chunking.tokenizerRevision,
    analyzer: manifest.bm25.analyzer,
    sqliteBatchSize: numberOption(values['sqlite-batch-size'], 'sqlite-batch-size'),
    ...(values['derived-cache-dir'] === undefined
      ? {}
      : { derivedCacheDir: required(values['derived-cache-dir'], 'derived-cache-dir') }),
    onBuildStats(stats) {
      indexBuildStats = stats
    },
    denseIndex: values['dense-index'],
    ...(values['exact-scan-max-elements'] === undefined
      ? {}
      : { exactScanMaxElements: numberOption(values['exact-scan-max-elements'], 'exact-scan-max-elements') }),
    ...(values.connectivity === undefined
      ? {}
      : { connectivity: numberOption(values.connectivity, 'connectivity') }),
    ...(values['expansion-add'] === undefined
      ? {}
      : { expansionAdd: numberOption(values['expansion-add'], 'expansion-add') }),
  })
  stdout.write(`${JSON.stringify({
    manifest: join(outputDir, 'manifest.json'),
    corpusSha256: derived.corpus.sha256,
    documentCount: derived.corpus.documentCount,
    chunkCount: derived.corpus.chunkCount,
    durationMs: derived.build.durationMs,
    payloadBytes: derived.payloads.reduce((sum, payload) => sum + payload.bytes, 0),
    denseIndex: derived.dense?.resolvedIndex,
    recommendedDenseIndex: derived.dense?.recommendedIndex,
    ...(indexBuildStats === undefined ? {} : { documentBuild: indexBuildStats }),
  })}\n`)
  return 0
}
