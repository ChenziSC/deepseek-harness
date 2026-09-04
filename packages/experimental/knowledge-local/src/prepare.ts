/** Explicit SciFact and local model preparation for offline experiments. */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { loadDenseEncoder } from './model-runtime.ts'
import {
  BGE_RERANKER_MODEL_ID,
  BGE_RERANKER_REVISION,
  loadReranker,
} from './reranker.ts'
import { BGE_SMALL_EN_MODEL_ID, BGE_SMALL_EN_REVISION } from './tokenizer.ts'

/** Fixed BEIR SciFact archive URL. */
export const SCIFACT_URL = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip'
/** MD5 digest published by BEIR for the SciFact archive. */
export const SCIFACT_MD5 = '5f7d1de60b170fc8027bb7898e2efca1'

/** Successful local preparation summary. */
export interface PrepareResult {
  readonly datasetDir: string
  readonly archiveMd5: string
  readonly archiveSha256: string
  readonly models: ReadonlyArray<{ readonly modelId: string; readonly revision: string }>
}

/** Dependencies replaceable by keyless preparation tests. */
export interface PrepareDependencies {
  readonly download: (url: string) => Promise<Uint8Array>
  readonly prepareDenseModel: (cacheDir: string) => Promise<void>
  readonly prepareRerankerModel: (cacheDir: string) => Promise<void>
}

function digest(algorithm: 'md5' | 'sha256', data: Uint8Array): string {
  return createHash(algorithm).update(data).digest('hex')
}

function archivePath(root: string, entry: string): string {
  if (entry.includes('\\') || isAbsolute(entry) || /^[A-Za-z]:/u.test(entry)) {
    throw new TypeError(`knowledge-local: unsafe SciFact archive path ${JSON.stringify(entry)}`)
  }
  const segments = entry.split('/').filter(segment => segment.length > 0)
  if (segments.length === 0 || segments.some(segment => segment === '..' || segment === '.')) {
    throw new TypeError(`knowledge-local: unsafe SciFact archive path ${JSON.stringify(entry)}`)
  }
  const target = resolve(root, ...segments)
  const prefix = `${resolve(root)}${sep}`
  if (!target.startsWith(prefix)) throw new TypeError(`knowledge-local: unsafe SciFact archive path ${JSON.stringify(entry)}`)
  return target
}

/**
 * Extract one verified SciFact archive while rejecting path traversal.
 * @param archive - complete ZIP archive bytes.
 * @param dataDir - destination parent directory.
 */
export async function extractSciFactArchive(archive: Uint8Array, dataDir: string): Promise<void> {
  const files = unzipSync(archive)
  for (const [entry, data] of Object.entries(files)) {
    const target = archivePath(dataDir, entry)
    if (entry.endsWith('/')) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, data)
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`knowledge-local: download failed with HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function prepareDenseModel(cacheDir: string): Promise<void> {
  const encoder = await loadDenseEncoder({ cacheDir, localFilesOnly: false })
  await encoder.dispose()
}

async function prepareRerankerModel(cacheDir: string): Promise<void> {
  const reranker = await loadReranker({ cacheDir, localFilesOnly: false })
  await reranker.dispose()
}

const DEFAULT_DEPENDENCIES: PrepareDependencies = {
  download,
  prepareDenseModel,
  prepareRerankerModel,
}

/**
 * Download and verify SciFact, then populate the explicit Transformers.js cache.
 * @param dataDir - destination parent for the extracted `scifact` directory.
 * @param modelCacheDir - explicit cache shared by both fixed model revisions.
 * @param dependencies - replaceable network and model operations for tests.
 * @returns verified dataset digests and prepared model identities.
 */
export async function prepareSciFact(
  dataDir: string,
  modelCacheDir: string,
  dependencies: PrepareDependencies = DEFAULT_DEPENDENCIES,
): Promise<PrepareResult> {
  if (dataDir.trim().length === 0) throw new TypeError('knowledge-local: dataDir must be non-empty')
  if (modelCacheDir.trim().length === 0) throw new TypeError('knowledge-local: modelCacheDir must be non-empty')
  const archive = await dependencies.download(SCIFACT_URL)
  const archiveMd5 = digest('md5', archive)
  if (archiveMd5 !== SCIFACT_MD5) {
    throw new TypeError(`knowledge-local: SciFact archive MD5 mismatch: expected ${SCIFACT_MD5}, received ${archiveMd5}`)
  }
  const archiveSha256 = digest('sha256', archive)
  await extractSciFactArchive(archive, dataDir)
  await dependencies.prepareDenseModel(modelCacheDir)
  await dependencies.prepareRerankerModel(modelCacheDir)
  return {
    datasetDir: join(dataDir, 'scifact'),
    archiveMd5,
    archiveSha256,
    models: [
      { modelId: BGE_SMALL_EN_MODEL_ID, revision: BGE_SMALL_EN_REVISION },
      { modelId: BGE_RERANKER_MODEL_ID, revision: BGE_RERANKER_REVISION },
    ],
  }
}
