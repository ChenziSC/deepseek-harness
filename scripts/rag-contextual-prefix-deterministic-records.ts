#!/usr/bin/env node
/** Materialize a no-model metadata-prefix comparator for one frozen contextual-prefix plan. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  contextualPrefixArtifactSha256,
  parseContextualPrefixPlanArtifact,
  renderContextualPrefixArtifact,
  type ContextualPrefixRecordsArtifact,
} from '../packages/experimental/knowledge-local/src/offline/contextual-prefix/contextual-prefix-artifacts.ts'
import { prepareOutputDirectory, required } from './rag-contextual-common.ts'

function prefix(batch: {
  readonly request: {
    readonly document: {
      readonly title?: string
      readonly source?: string
      readonly sourceVersion?: string
      readonly validFrom?: string
      readonly validUntil?: string
    }
    readonly sectionPath?: string
  }
}): string | undefined {
  const values = [
    batch.request.document.title === undefined ? undefined : `Title: ${batch.request.document.title}`,
    batch.request.sectionPath === undefined ? undefined : `Section: ${batch.request.sectionPath}`,
    batch.request.document.source === undefined ? undefined : `Source: ${batch.request.document.source}`,
    batch.request.document.sourceVersion === undefined
      ? undefined
      : `Source version: ${batch.request.document.sourceVersion}`,
    batch.request.document.validFrom === undefined ? undefined : `Valid from: ${batch.request.document.validFrom}`,
    batch.request.document.validUntil === undefined ? undefined : `Valid until: ${batch.request.document.validUntil}`,
  ].filter((value): value is string => value !== undefined)
  return values.length === 0 ? undefined : values.join('; ')
}

const { values } = parseArgs({
  strict: true,
  allowPositionals: false,
  options: {
    plan: { type: 'string' },
    output: { type: 'string' },
  },
})
const planPath = required(values.plan, 'plan')
const outputDir = required(values.output, 'output')
const planText = await readFile(planPath, 'utf8')
const plan = parseContextualPrefixPlanArtifact(planText)
const generated = plan.plan.batches.flatMap((batch) => {
  const context = prefix(batch)
  const textById = new Map(batch.request.targets.map(target => [target.id, target.text]))
  return batch.candidateChunkIds.map(chunkId => ({
    chunkId,
    sourceTextSha256: contextualPrefixArtifactSha256(textById.get(chunkId) as string),
    ...(context === undefined
      ? { status: 'fallback' as const }
      : { status: 'generated' as const, context }),
  }))
})
const valuesById = [...plan.plan.fallbacks.map(value => ({ ...value, status: 'fallback' as const })), ...generated]
const generatedCount = valuesById.filter(value => value.status === 'generated').length
const fallbackCount = valuesById.length - generatedCount
const records: ContextualPrefixRecordsArtifact = {
  schemaVersion: 1,
  planSha256: contextualPrefixArtifactSha256(planText),
  generator: {
    modelId: 'deterministic-metadata-prefix',
    revision: '1',
    parameters: {},
  },
  execution: {
    values: valuesById,
    cacheQueryCount: 0,
    cacheHitCount: 0,
    generatedCount,
    fallbackCount,
    requestCount: 0,
    retryCount: 0,
    plannedInputTokens: 0,
    plannedMaximumOutputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheSavedInputTokens: 0,
    cacheSavedOutputTokens: 0,
    latencyMs: 0,
  },
}
await prepareOutputDirectory(outputDir)
const recordsPath = join(outputDir, 'contextual-prefix-records.json')
await writeFile(recordsPath, renderContextualPrefixArtifact(records), { flag: 'wx' })
process.stdout.write(`${JSON.stringify({ records: recordsPath, generatedCount, fallbackCount })}\n`)
