/** DeepSeek Files API 上传复用、失效和配额恢复。 @module dsh-llm-deepseek/file-store */

import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DeepSeekFilesClient, isFilesQuotaError } from './files-api.ts'
import type { DeepSeekFileId } from './file-id.ts'
import { deepSeekFileScope, DeepSeekUploadIndex } from './upload-index.ts'
import type { DeepSeekUploadRecord } from './upload-index.ts'

/** 即使通过 file ID 引用，DeepSeek chat 仍最多接受每张 32 MiB。 */
export const MAX_CHAT_IMAGE_BYTES = 32 * 1024 * 1024
const OWNED_FILE_PREFIX = 'dsh-'

/** 从插件配置解析得到的文件存储策略。 */
export interface DeepSeekFilePolicy {
  expiresAfterSeconds: number
  refreshMarginSeconds: number
  quotaCleanupBatch: number
}

/** 文件操作所需的连接事实；每次解析捕获同一份端点与凭据快照。 */
export interface DeepSeekFileConnection {
  baseURL: string
  apiKey: string
}

/** 一次 file ID 解析结果。 */
export interface DeepSeekFileReference {
  record: DeepSeekUploadRecord
  uploaded: boolean
}

interface FileStoreOptions {
  index?: DeepSeekUploadIndex
  now?: () => number
  fetch?: typeof fetch
}

interface SharedUpload {
  controller: AbortController
  promise: Promise<DeepSeekFileReference>
  settled: boolean
  waiters: number
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new Error('DeepSeek file upload cancelled with a non-Error reason.', { cause: reason })
}

function uploadFailure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('DeepSeek file upload failed with a non-Error reason.', { cause: error })
}

function waitForUpload(operation: SharedUpload, signal: AbortSignal | undefined): Promise<DeepSeekFileReference> {
  signal?.throwIfAborted()
  operation.waiters += 1
  let released = false
  const release = (cancelledReason?: Error): void => {
    if (released) return
    released = true
    operation.waiters -= 1
    if (cancelledReason !== undefined && operation.waiters === 0 && !operation.settled) {
      operation.controller.abort(cancelledReason)
    }
  }
  if (signal === undefined) {
    return operation.promise.finally(() => {
      release()
    })
  }
  return new Promise<DeepSeekFileReference>((resolve, reject) => {
    const abort = (): void => {
      const reason = abortReason(signal)
      release(reason)
      reject(reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.promise.then((value) => {
      signal.removeEventListener('abort', abort)
      release()
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      release()
      reject(uploadFailure(error))
    })
  })
}

function extension(mediaType: RequestImageAttachment['mediaType']): 'png' | 'jpeg' | 'webp' | 'gif' {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpeg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
  }
}

function filename(version: RequestImageAttachment): string {
  const attachment = String(version.attachment.attachmentId).slice('sha256:'.length, 'sha256:'.length + 16)
  const variant = String(version.variantId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `${OWNED_FILE_PREFIX}${attachment}-${variant}.${extension(version.mediaType)}`
}

/**
 * DeepSeek 路由按用户命名空间持久复用 file ID。本类串起请求版本、本地索引与 Files API：
 * 先复用未接近过期的索引，否则上传；配额超限时只执行一次有界清理和重试。
 */
export class DeepSeekFileStore {
  private readonly index: DeepSeekUploadIndex
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch | undefined
  private readonly inflight = new Map<string, SharedUpload>()

  /**
   * @param options - 可测试的索引、时钟和传输依赖。
   */
  constructor(options: FileStoreOptions = {}) {
    this.index = options.index ?? new DeepSeekUploadIndex()
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetch
  }

  private client(connection: DeepSeekFileConnection): DeepSeekFilesClient {
    return new DeepSeekFilesClient({
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
      ...this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl },
    })
  }

  /**
   * 解析或上传一个确定性请求图片。并发调用共享一次上传，但每个调用者独立等待和取消；
   * 只有最后一个等待者取消时才中止共享传输。
   * @param version - 确定性模型请求字节和完整转换身份。
   * @param connection - 端点与 API key 快照。
   * @param policy - 过期和配额恢复策略。
   * @param signal - 本次等待的取消信号；无等待者后停止共享传输。
   * @returns 可复用的 file ID，以及本次是否发布了新上传。
   */
  ensureUploaded(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<DeepSeekFileReference> {
    signal?.throwIfAborted()
    const scope = deepSeekFileScope(connection.baseURL, connection.apiKey)
    const key = `${scope}\0${version.variantId}`
    let active = this.inflight.get(key)
    if (active?.controller.signal.aborted) {
      this.inflight.delete(key)
      active = undefined
    }
    if (active !== undefined) return waitForUpload(active, signal)
    const controller = new AbortController()
    const shared: SharedUpload = {
      controller,
      settled: false,
      waiters: 0,
      promise: undefined as never,
    }
    shared.promise = this.ensureUploadedOnce(version, connection, policy, controller.signal).then((value) => {
      shared.settled = true
      return value
    }, (error: unknown) => {
      shared.settled = true
      throw uploadFailure(error)
    })
    this.inflight.set(key, shared)
    void shared.promise.finally(() => {
      if (this.inflight.get(key) === shared) this.inflight.delete(key)
    }).catch(() => {})
    return waitForUpload(shared, signal)
  }

  private async ensureUploadedOnce(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal: AbortSignal,
  ): Promise<DeepSeekFileReference> {
    if (version.bytes > MAX_CHAT_IMAGE_BYTES) {
      throw new LlmError('DeepSeek chat image exceeds the 32 MiB per-image limit.', 'INVALID_REQUEST')
    }
    const scope = deepSeekFileScope(connection.baseURL, connection.apiKey)
    const now = this.now()
    const marginMs = policy.refreshMarginSeconds * 1_000
    const cached = await this.index.get(scope, version.variantId, now, marginMs)
    if (cached !== undefined) return { record: cached, uploaded: false }

    const client = this.client(connection)
    const upload = async (): Promise<DeepSeekUploadRecord> => {
      const remote = await client.upload({
        data: version.data,
        mediaType: version.mediaType,
        filename: filename(version),
        expiresAfterSeconds: policy.expiresAfterSeconds,
        signal,
      })
      if (remote.bytes !== version.data.byteLength) {
        throw new LlmError('DeepSeek Files API upload response does not match the submitted image.', 'INVALID_RESPONSE')
      }
      return {
        scope,
        attachmentId: version.attachment.attachmentId,
        variantId: version.variantId,
        fileId: remote.id,
        bytes: remote.bytes,
        createdAt: remote.createdAt * 1_000,
        expiresAt: remote.expiresAt * 1_000,
      }
    }

    let candidate: DeepSeekUploadRecord
    try {
      candidate = await upload()
    } catch (error: unknown) {
      if (!isFilesQuotaError(error)) throw error
      const deleted = await this.reclaimOldestOwned(connection, policy.quotaCleanupBatch, signal)
      if (deleted === 0) throw error
      candidate = await upload()
    }
    const committed = await this.index.commit(candidate, this.now(), marginMs)
    if (!committed.accepted) {
      try {
        await client.delete(candidate.fileId, signal)
      } catch {
        // 胜出的映射已持久化；重复文件清理失败只影响配额，后续配额恢复会再次处理。
      }
    }
    return { record: committed.record, uploaded: committed.accepted }
  }

  /**
   * chat 端点拒绝远程 ID 后，使精确的本地映射失效，不删除并发安装的后继代。
   * @param version - 远程代次失败的请求图片版本。
   * @param fileId - 被拒绝的精确 file ID。
   * @param connection - 端点与 API key 快照。
   */
  async invalidate(
    version: RequestImageAttachment,
    fileId: DeepSeekFileId,
    connection: DeepSeekFileConnection,
  ): Promise<void> {
    await this.index.remove(
      deepSeekFileScope(connection.baseURL, connection.apiKey),
      version.variantId,
      fileId,
    )
  }

  /**
   * 删除某个附件已索引的远程文件，并移除本地映射。
   * @param version - 要释放的精确请求图片版本。
   * @param connection - 端点与 API key 快照。
   * @param policy - 用于定位可复用映射的过期策略。
   * @param signal - 请求取消信号。
   * @returns 是否存在并删除了已索引文件。
   */
  async release(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const scope = deepSeekFileScope(connection.baseURL, connection.apiKey)
    const record = await this.index.get(
      scope,
      version.variantId,
      this.now(),
      policy.refreshMarginSeconds * 1_000,
    )
    if (record === undefined) return false
    await this.client(connection).delete(record.fileId, signal)
    await this.index.remove(scope, version.variantId, record.fileId)
    return true
  }

  /**
   * 删除文件名可证明归 Harness 所有的最旧 Provider 文件。不会清理同一 API key 下其他客户端的文件。
   * @param connection - 端点与 API key 快照。
   * @param count - 最多删除的文件数正数。
   * @param signal - 请求取消信号。
   * @returns 成功删除的文件数。
   */
  async reclaimOldestOwned(
    connection: DeepSeekFileConnection,
    count: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const client = this.client(connection)
    let after: DeepSeekFileId | undefined
    const owned: DeepSeekFileId[] = []
    while (owned.length < count) {
      const page = await client.list({
        ...after === undefined ? {} : { after },
        limit: 1_000,
        order: 'asc',
        ...signal === undefined ? {} : { signal },
      })
      for (const file of page.data) {
        if (!file.filename.startsWith(OWNED_FILE_PREFIX)) continue
        owned.push(file.id)
        if (owned.length === count) break
      }
      if (!page.hasMore || page.lastId === undefined || page.lastId === after) break
      after = page.lastId
    }
    for (const fileId of owned) await client.delete(fileId, signal)
    return owned.length
  }

  /**
   * 删除当前 API key 命名空间中所有 Harness 所有的远程文件，并清空其本地索引。
   * @param connection - 端点与 API key 快照。
   * @param signal - 请求取消信号。
   * @returns 已删除文件数。
   */
  async releaseAll(connection: DeepSeekFileConnection, signal?: AbortSignal): Promise<number> {
    let total = 0
    for (;;) {
      const deleted = await this.reclaimOldestOwned(connection, 1_000, signal)
      total += deleted
      if (deleted < 1_000) break
    }
    await this.index.clear(deepSeekFileScope(connection.baseURL, connection.apiKey))
    return total
  }
}
