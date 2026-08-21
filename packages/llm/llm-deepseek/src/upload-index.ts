/** DeepSeek 附件到 file ID 的持久索引。 @module dsh-llm-deepseek/upload-index */

import { createHash } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentId, ImageVariantId as ImageVariantIdType } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId, DeepSeekFileScope } from './file-id.ts'
import type { DeepSeekFileId as DeepSeekFileIdType, DeepSeekFileScope as DeepSeekFileScopeType } from './file-id.ts'

/** 一条持久远程上传映射；Unix 时间使用毫秒。 */
export interface DeepSeekUploadRecord {
  scope: DeepSeekFileScopeType
  /** 上传请求版本所源自的、与 Provider 无关的规范化附件。 */
  attachmentId: AttachmentId
  /** 完整请求转换身份，包含路由预算和编码器参数。 */
  variantId: ImageVariantIdType
  fileId: DeepSeekFileIdType
  bytes: number
  createdAt: number
  expiresAt: number
}

interface StoredIndex {
  formatVersion: 3
  records: DeepSeekUploadRecord[]
}

class InvalidUploadIndexError extends Error {}

/** 另一进程已发布可复用上传时的候选提交结果。 */
export interface UploadIndexCommit {
  record: DeepSeekUploadRecord
  accepted: boolean
}

/**
 * 派生不泄露机密的稳定索引命名空间，不持久化或记录 API key。
 * @param baseURL - 规范化的 Provider 端点命名空间。
 * @param apiKey - 已解析的凭据，仅作为哈希输入。
 * @returns 品牌化 SHA-256 命名空间摘要。
 */
export function deepSeekFileScope(baseURL: string, apiKey: string): DeepSeekFileScopeType {
  const digest = createHash('sha256')
    .update(baseURL.replace(/\/+$/u, ''))
    .update('\0')
    .update(apiKey)
    .digest('hex')
  return DeepSeekFileScope(digest)
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function parseRecord(value: unknown): DeepSeekUploadRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index contains a non-object record')
  }
  const record = value as Record<string, unknown>
  if (typeof record.scope !== 'string' || !/^[0-9a-f]{64}$/u.test(record.scope)
    || typeof record.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.attachmentId)
    || typeof record.variantId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.variantId)
    || typeof record.fileId !== 'string' || record.fileId.length === 0
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
    || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index contains an invalid record')
  }
  return {
    scope: DeepSeekFileScope(record.scope),
    attachmentId: record.attachmentId as AttachmentId,
    variantId: ImageVariantId(record.variantId),
    fileId: DeepSeekFileId(record.fileId),
    bytes: record.bytes as number,
    createdAt: record.createdAt as number,
    expiresAt: record.expiresAt as number,
  }
}

function parseIndex(text: string): StoredIndex {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index is not valid JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index is not an object')
  }
  const index = value as { formatVersion?: unknown; records?: unknown }
  if (index.formatVersion !== 3 || !Array.isArray(index.records)) {
    throw new InvalidUploadIndexError('llm-deepseek: unsupported upload index format')
  }
  const records = index.records.map(parseRecord)
  const keys = new Set<string>()
  for (const record of records) {
    const key = `${record.scope}\0${record.variantId}`
    if (keys.has(key)) throw new InvalidUploadIndexError('llm-deepseek: upload index contains duplicate mappings')
    keys.add(key)
  }
  return { formatVersion: 3, records }
}

function reusable(record: DeepSeekUploadRecord, now: number, refreshMarginMs: number): boolean {
  return record.expiresAt - now > refreshMarginMs
}

/**
 * 同一 DSH home 中所有 DeepSeek session 共享的原子本地索引。跨进程写入通过文件锁串行化，
 * 因此并发上传完成后只有一条未接近过期的映射成为胜者。
 */
export class DeepSeekUploadIndex {
  /** 所有者私有的绝对 JSON 索引路径。 */
  readonly path: string

  /**
   * @param path - 显式测试路径；省略时使用 `DSH_HOME/llm-deepseek/files-v3.json`。
   */
  constructor(path = join(resolveDshHome(), 'llm-deepseek', 'files-v3.json')) {
    this.path = path
  }

  private async load(): Promise<StoredIndex> {
    try {
      return parseIndex(await readFile(this.path, 'utf8'))
    } catch (error: unknown) {
      if (absent(error) || error instanceof InvalidUploadIndexError) {
        return { formatVersion: 3, records: [] }
      }
      throw error
    }
  }

  private async save(index: StoredIndex): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(index, undefined, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  /**
   * 读取一条可复用映射。
   * @param scope - 端点/API key 命名空间。
   * @param variantId - 完整的请求图片转换身份。
   * @param now - 当前 Unix 毫秒时间。
   * @param refreshMarginMs - 低于该剩余生存期时不再复用映射。
   * @returns 剩余生存期足够时返回映射。
   */
  async get(
    scope: DeepSeekFileScopeType,
    variantId: ImageVariantIdType,
    now: number,
    refreshMarginMs: number,
  ): Promise<DeepSeekUploadRecord | undefined> {
    const record = (await this.load()).records.find(candidate => (
      candidate.scope === scope && candidate.variantId === variantId
    ))
    return record !== undefined && reusable(record, now, refreshMarginMs) ? record : undefined
  }

  /**
   * 发布一次已完成上传；若另一进程已发布可复用映射，则保留胜出记录。
   * @param candidate - 已完成的远程上传。
   * @param now - 当前 Unix 毫秒时间。
   * @param refreshMarginMs - 可复用所需的最小剩余生存期。
   * @returns 胜出记录，以及候选是否进入索引。
   */
  async commit(
    candidate: DeepSeekUploadRecord,
    now: number,
    refreshMarginMs: number,
  ): Promise<UploadIndexCommit> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const index = await this.load()
      const existing = index.records.find(record => (
        record.scope === candidate.scope
        && record.variantId === candidate.variantId
        && reusable(record, now, refreshMarginMs)
      ))
      if (existing !== undefined) return { record: existing, accepted: false }
      const records = index.records.filter(record => (
        reusable(record, now, refreshMarginMs)
        && !(record.scope === candidate.scope && record.variantId === candidate.variantId)
      ))
      records.push(candidate)
      await this.save({ formatVersion: 3, records })
      return { record: candidate, accepted: true }
    })
  }

  /**
   * 移除一条精确映射，但不删除并发安装的后继代。
   * @param scope - 端点/API key 命名空间。
   * @param variantId - 完整的请求图片转换身份。
   * @param fileId - 正在失效的精确远程代次。
   */
  async remove(
    scope: DeepSeekFileScopeType,
    variantId: ImageVariantIdType,
    fileId: DeepSeekFileIdType,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => !(
        record.scope === scope && record.variantId === variantId && record.fileId === fileId
      ))
      if (records.length !== index.records.length) await this.save({ formatVersion: 3, records })
    })
  }

  /**
   * 移除某个远程命名空间的全部本地映射。
   * @param scope - 端点/API key 命名空间。
   */
  async clear(scope: DeepSeekFileScopeType): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => record.scope !== scope)
      if (records.length !== index.records.length) await this.save({ formatVersion: 3, records })
    })
  }
}
