/** Validate and publish immutable index payloads after construction succeeds. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { KnowledgeBm25Analyzer } from '../bm25.ts'
import { DEFAULT_CHUNKING_STRATEGY, type ChunkingOptions } from '../chunker.ts'
import type { DenseIndexMode } from './types.ts'
import {
  type DenseIndexManifest,
  type KnowledgeIndexManifest,
  type PayloadManifest,
} from '../index-format.ts'
import { HNSW_FILE } from '../hnsw.ts'
import { KNOWLEDGE_SQLITE_FILE, openKnowledgeSqlite } from '../sqlite-index.ts'
import { resolveTextScriptProfile } from '../script-profile.ts'
import { prepareEmptyDirectory } from '../filesystem.ts'
import { SOURCE_DATABASE_FILE, type StagedCorpus } from './stage.ts'

/** Exact Dense vector payload filename. */
export const DENSE_FILE = 'dense.f32le'
const MANIFEST_FILE = 'manifest.json'

/**
 * Require an empty output directory, creating it when absent.
 * @param outputDir - target directory that will own the immutable index.
 */
export async function prepareOutputDirectory(outputDir: string): Promise<void> {
  await prepareEmptyDirectory(outputDir, `knowledge-local: output directory is not empty: ${outputDir}`)
}

async function packageVersion(): Promise<string> {
  const text = await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  const value = JSON.parse(text) as { version?: unknown }
  /* v8 ignore next -- package metadata validation guarantees the published version field. */
  if (typeof value.version !== 'string') throw new TypeError('knowledge-local: package version is unavailable')
  return value.version
}

async function payloadManifest(outputDir: string, path: string): Promise<PayloadManifest> {
  const target = join(outputDir, path)
  const metadata = await stat(target)
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(target)) digest.update(chunk as Buffer)
  return { path, bytes: metadata.size, sha256: digest.digest('hex') }
}

/**
 * Reopen the SQLite payload, delete staging state, and hash retained payloads.
 * @param outputDir - target index directory.
 * @param staged - source metadata and temporary database identity.
 * @param chunkCount - finalized chunk rows.
 * @param analyzer - analyzer expected in SQLite metadata.
 * @param denseIndex - retained Dense payload mode.
 * @param hasHnsw - whether an HNSW payload was written.
 * @returns payload manifests in stable order.
 */
export async function finalizePayloads(
  outputDir: string,
  staged: StagedCorpus,
  chunkCount: number,
  analyzer: KnowledgeBm25Analyzer,
  denseIndex: DenseIndexMode | undefined,
  hasHnsw: boolean,
): Promise<PayloadManifest[]> {
  openKnowledgeSqlite(join(outputDir, KNOWLEDGE_SQLITE_FILE), staged.documentCount, chunkCount, analyzer).close()
  await unlink(join(outputDir, SOURCE_DATABASE_FILE))
  const payloads = [await payloadManifest(outputDir, KNOWLEDGE_SQLITE_FILE)]
  if (denseIndex === 'exact' || denseIndex === 'both') payloads.push(await payloadManifest(outputDir, DENSE_FILE))
  if (hasHnsw) payloads.push(await payloadManifest(outputDir, HNSW_FILE))
  return payloads
}

/** Inputs whose exact values define a published format-four manifest. */
export interface ManifestWriteOptions {
  readonly outputDir: string
  readonly startedAt: number
  readonly staged: StagedCorpus
  readonly chunkCount: number
  readonly analyzer: KnowledgeBm25Analyzer
  readonly tokenizerModelId: string
  readonly tokenizerRevision: string
  readonly chunking: ChunkingOptions
  readonly dense?: DenseIndexManifest
  readonly hnsw?: NonNullable<KnowledgeIndexManifest['hnsw']>
  readonly payloads: readonly PayloadManifest[]
}

/**
 * Write the manifest as the final completion marker.
 * @param options - completed payload identities and recorded build configuration.
 * @returns the exact manifest written to disk.
 */
export async function writeManifest(options: ManifestWriteOptions): Promise<KnowledgeIndexManifest> {
  const manifest: KnowledgeIndexManifest = {
    formatVersion: 4,
    createdBy: {
      package: '@deepseek-ai/dsh-experimental-knowledge-local',
      version: await packageVersion(),
    },
    build: { durationMs: performance.now() - options.startedAt },
    corpus: {
      sha256: options.staged.corpusSha256,
      documentCount: options.staged.documentCount,
      chunkCount: options.chunkCount,
      scriptProfile: resolveTextScriptProfile(options.staged.scriptCounts),
      documentMetadata: 'source-version-validity-v1',
    },
    chunking: {
      tokenizerModelId: options.tokenizerModelId,
      tokenizerRevision: options.tokenizerRevision,
      maxTokens: options.chunking.maxTokens,
      overlapTokens: options.chunking.overlapTokens,
      strategy: options.chunking.strategy ?? DEFAULT_CHUNKING_STRATEGY,
    },
    bm25: { analyzer: options.analyzer, implementation: 'sqlite-fts5' },
    ...(options.dense === undefined ? {} : { dense: options.dense }),
    ...(options.hnsw === undefined ? {} : { hnsw: options.hnsw }),
    payloads: options.payloads,
  }
  await writeFile(join(options.outputDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  return manifest
}
