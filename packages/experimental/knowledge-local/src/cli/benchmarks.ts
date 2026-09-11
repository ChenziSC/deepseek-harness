/** Dataset preparation and deterministic benchmark-slice commands. */

import { open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_ADAPTIVE_RERANK_MIN_SCORE_GAP_RATIO,
  DEFAULT_CANDIDATE_COUNT,
  DEFAULT_RERANKER_CANDIDATE_COUNT,
} from '../config.ts'
import { DEFAULT_HNSW_EXPANSION_SEARCH } from '../hnsw.ts'
import { prepareEmptyDirectory } from '../filesystem.ts'
import { evaluateDataset } from '../offline/evaluation/dataset.ts'
import { renderEvaluationReport } from '../offline/evaluation/report.ts'
import { prepareMldr, prepareMlqaEngZho, prepareSciFact, prepareT2Ranking } from '../prepare.ts'
import {
  buildT2RankingBenchmarkSlices,
  DEFAULT_T2RANKING_CHUNK_TARGETS,
} from '../t2ranking-benchmark.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION, loadBgeChunkTokenizer } from '../tokenizer.ts'
import {
  listOption,
  numberListOption,
  numberOption,
  required,
  type CliOutput,
} from './options.ts'

/** Prepare one supported fixed benchmark dataset. */
export async function runPrepare(argv: readonly string[], stdout: CliOutput): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      'data-dir': { type: 'string' },
      'model-cache-dir': { type: 'string' },
      language: { type: 'string' },
      'hf-endpoint': { type: 'string', default: process.env['HF_ENDPOINT'] ?? 'https://huggingface.co' },
    },
  })
  if (positionals.length !== 1) throw new TypeError('prepare requires one dataset name')
  const dataset = positionals[0]
  const dataDir = required(values['data-dir'], 'data-dir')
  const result = dataset === 'scifact'
    ? await prepareSciFact(dataDir, required(values['model-cache-dir'], 'model-cache-dir'))
    : dataset === 'mldr'
      ? values.language === 'en' || values.language === 'zh'
        ? await prepareMldr(dataDir, values.language, values['hf-endpoint'])
        : (() => { throw new TypeError('prepare mldr requires --language en or zh') })()
      : dataset === 't2ranking'
        ? await prepareT2Ranking(dataDir, values['hf-endpoint'])
        : dataset === 'mlqa-eng-zho'
          ? await prepareMlqaEngZho(dataDir, values['hf-endpoint'])
          : (() => { throw new TypeError('prepare dataset must be scifact, mldr, t2ranking, or mlqa-eng-zho') })()
  stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}

/** Build nested T2Ranking slices with one fixed tokenizer identity. */
export async function runSlice(argv: readonly string[], stdout: CliOutput): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      collection: { type: 'string' },
      queries: { type: 'string' },
      qrels: { type: 'string' },
      'bm25-run': { type: 'string' },
      output: { type: 'string' },
      'model-cache-dir': { type: 'string' },
      'query-limit': { type: 'string', default: '100' },
      'chunk-targets': { type: 'string', default: DEFAULT_T2RANKING_CHUNK_TARGETS.join(',') },
    },
  })
  const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
  const tokenizer = await loadBgeChunkTokenizer({
    cacheDir: modelCacheDir,
    localFilesOnly: true,
    modelId: BGE_M3_MODEL_ID,
    revision: BGE_M3_REVISION,
  })
  const result = await buildT2RankingBenchmarkSlices({
    collectionPath: required(values.collection, 'collection'),
    queriesPath: required(values.queries, 'queries'),
    qrelsPath: required(values.qrels, 'qrels'),
    bm25Path: required(values['bm25-run'], 'bm25-run'),
    outputDir: required(values.output, 'output'),
    tokenizer,
    queryLimit: numberOption(values['query-limit'], 'query-limit'),
    chunkTargets: numberListOption(values['chunk-targets'], 'chunk-targets'),
  })
  stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}

export async function runEvaluate(argv: readonly string[], stdout: Pick<NodeJS.WriteStream, 'write'>): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      index: { type: 'string' },
      queries: { type: 'string' },
      qrels: { type: 'string' },
      'model-cache-dir': { type: 'string' },
      'max-results': { type: 'string', default: '20' },
      'candidate-count': { type: 'string', default: String(DEFAULT_CANDIDATE_COUNT) },
      'reranker-candidate-count': { type: 'string', default: String(DEFAULT_RERANKER_CANDIDATE_COUNT) },
      'adaptive-rerank-min-score-gap-ratio': {
        type: 'string',
        default: String(DEFAULT_ADAPTIVE_RERANK_MIN_SCORE_GAP_RATIO),
      },
      'warmup-queries': { type: 'string', default: '10' },
      output: { type: 'string' },
      dataset: { type: 'string', default: 'scifact' },
      'query-limit': { type: 'string' },
      modes: { type: 'string', default: 'bm25,dense,hybrid' },
      'dense-indexes': { type: 'string' },
      rerank: { type: 'string', default: 'off,auto,on' },
      'expansion-search': { type: 'string', default: String(DEFAULT_HNSW_EXPANSION_SEARCH) },
    },
  })
  const indexDir = required(values.index, 'index')
  const queriesPath = required(values.queries, 'queries')
  const qrelsPath = required(values.qrels, 'qrels')
  const modelCacheDir = required(values['model-cache-dir'], 'model-cache-dir')
  const outputDir = required(values.output, 'output')
  if (values.dataset !== 'scifact' && values.dataset !== 'mldr' && values.dataset !== 't2ranking' && values.dataset !== 'mlqa') {
    throw new TypeError('--dataset must be scifact, mldr, t2ranking, or mlqa')
  }
  await prepareEmptyDirectory(outputDir, `knowledge-local: report output directory is not empty: ${outputDir}`)
  const jsonPath = join(outputDir, 'report.json')
  const markdownPath = join(outputDir, 'report.md')
  const queryDetailsPath = join(outputDir, 'queries.jsonl')
  const queryDetails = await open(queryDetailsPath, 'wx')
  let report: Awaited<ReturnType<typeof evaluateDataset>>
  try {
    report = await evaluateDataset({
      indexDir,
      queriesPath,
      qrelsPath,
      modelCacheDir,
      maxResults: numberOption(values['max-results'], 'max-results'),
      candidateCount: numberOption(values['candidate-count'], 'candidate-count'),
      rerankerCandidateCount: numberOption(values['reranker-candidate-count'], 'reranker-candidate-count'),
      adaptiveRerankMinScoreGapRatio: numberOption(
        values['adaptive-rerank-min-score-gap-ratio'],
        'adaptive-rerank-min-score-gap-ratio',
      ),
      warmupQueries: numberOption(values['warmup-queries'], 'warmup-queries'),
      dataset: values.dataset,
      ...(values['query-limit'] === undefined
        ? {}
        : { queryLimit: numberOption(values['query-limit'], 'query-limit') }),
      modes: listOption(values.modes, 'modes', ['auto', 'bm25', 'dense', 'hybrid'] as const),
      ...(values['dense-indexes'] === undefined
        ? {}
        : { denseIndexes: listOption(values['dense-indexes'], 'dense-indexes', ['exact', 'hnsw'] as const) }),
      rerankValues: listOption(values.rerank, 'rerank', ['off', 'auto', 'on'] as const),
      hnswExpansionSearch: numberOption(values['expansion-search'], 'expansion-search'),
      onQueryDetail: async (detail) => {
        await queryDetails.write(`${JSON.stringify(detail)}\n`)
      },
    })
  } finally {
    await queryDetails.close()
  }
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  await writeFile(markdownPath, renderEvaluationReport(report), { flag: 'wx' })
  const failedRuns = report.runs.filter(run => run.status === 'failed').length
  stdout.write(`${JSON.stringify({ report: jsonPath, markdown: markdownPath, queries: queryDetailsPath, failedRuns })}\n`)
  return failedRuns === 0 ? 0 : 2
}
