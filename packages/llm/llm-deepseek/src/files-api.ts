/** OpenAI 兼容的 DeepSeek Files API 传输与线协议验证。 @module dsh-llm-deepseek/files-api */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId } from './file-id.ts'
import type { DeepSeekFileId as DeepSeekFileIdType } from './file-id.ts'

/** Provider 支持的最短文件生存期。 */
export const MIN_FILE_EXPIRY_SECONDS = 3_600
/** Provider 支持的最长文件生存期。 */
export const MAX_FILE_EXPIRY_SECONDS = 2_592_000
/** Files API 单次上传大小上限。 */
export const MAX_FILE_UPLOAD_BYTES = 128 * 1024 * 1024
/** 当前每个 key 的文件数配额。 */
export const MAX_STORED_FILE_COUNT = 10_000
/** 当前每个 key 的存储配额。 */
export const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024 * 1024

/** OpenAI 兼容端点返回并经过验证的文件对象。 */
export interface DeepSeekFileObject {
  id: DeepSeekFileIdType
  bytes: number
  createdAt: number
  filename: string
  purpose: 'user_data'
  expiresAt?: number
}

/** `GET /files` 返回的一页结果。 */
export interface DeepSeekFilePage {
  data: DeepSeekFileObject[]
  firstId?: DeepSeekFileIdType
  lastId?: DeepSeekFileIdType
  hasMore: boolean
}

/** 保留 HTTP 状态以供恢复策略分类的 Files API 操作错误。 */
export class DeepSeekFilesError extends LlmError {
  /** 解析后的 Provider 详情，仅用于错误分类。 */
  readonly detail: string

  /**
   * @param message - 人类可读的 Provider 失败信息。
   * @param status - Files API 返回的 HTTP 状态。
   * @param detail - 为分类而合并的 Provider 错误字段。
   */
  constructor(message: string, status: number, detail: string) {
    super(message, status === 401 || status === 403
      ? 'AUTH'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500
          ? 'SERVER'
          : 'FILES_API', { status })
    this.name = 'DeepSeekFilesError'
    this.detail = detail
  }
}

/**
 * 判断上传失败是否表示 Provider 存储或文件数配额。
 * @param error - Files API 操作失败。
 * @returns 一次有界远程清理与上传重试是否可能恢复。
 */
export function isFilesQuotaError(error: unknown): error is DeepSeekFilesError {
  return error instanceof DeepSeekFilesError
    && /(?:quota|storage|stored files|file count|too many files)/iu.test(error.detail)
}

interface FilesApiOptions {
  baseURL: string
  apiKey: string
  fetch?: typeof fetch
}

interface WireFileObject {
  id?: unknown
  object?: unknown
  bytes?: unknown
  created_at?: unknown
  filename?: unknown
  purpose?: unknown
  expires_at?: unknown
}

function invalidResponse(operation: string): LlmError {
  return new LlmError(`DeepSeek Files API returned an invalid ${operation} response.`, 'INVALID_RESPONSE')
}

function parseFileObject(value: unknown, operation: string): DeepSeekFileObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse(operation)
  const wire = value as WireFileObject
  if (typeof wire.id !== 'string' || wire.id.length === 0
    || wire.object !== 'file'
    || !Number.isSafeInteger(wire.bytes) || (wire.bytes as number) < 0
    || !Number.isSafeInteger(wire.created_at) || (wire.created_at as number) < 0
    || typeof wire.filename !== 'string' || wire.filename.length === 0
    || wire.purpose !== 'user_data'
    || (wire.expires_at !== undefined
      && (!Number.isSafeInteger(wire.expires_at) || (wire.expires_at as number) < 0))) {
    throw invalidResponse(operation)
  }
  return {
    id: DeepSeekFileId(wire.id),
    bytes: wire.bytes as number,
    createdAt: wire.created_at as number,
    filename: wire.filename,
    purpose: 'user_data',
    ...wire.expires_at === undefined ? {} : { expiresAt: wire.expires_at as number },
  }
}

function providerErrorDetail(value: unknown): { message?: string; detail: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { detail: '' }
  const error = (value as { error?: unknown }).error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return { detail: '' }
  const fields = error as { message?: unknown; type?: unknown; code?: unknown }
  const message = typeof fields.message === 'string' ? fields.message : undefined
  return {
    ...message === undefined ? {} : { message },
    detail: [fields.code, fields.type, fields.message]
      .filter((field): field is string => typeof field === 'string')
      .join(' '),
  }
}

/**
 * OpenAI 兼容 `/files` 端点的直接客户端。每个响应在进入上传索引前都会验证结构，
 * 避免把缺字段或错误类型的 Provider 数据持久化。
 */
export class DeepSeekFilesClient {
  private readonly baseURL: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  /**
   * @param options - 端点、API key 快照和可选测试传输。
   */
  constructor(options: FilesApiOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/u, '')
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      const headers = new Headers(attributionHeaders())
      headers.set('authorization', `Bearer ${this.apiKey}`)
      response = await this.fetchImpl(`${this.baseURL}${path}`, {
        ...init,
        headers,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      throw new LlmError(`DeepSeek Files API request to ${this.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    if (response.ok) return response
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      // 即使响应体不是有效 JSON，HTTP 状态仍足以报告 Provider 失败。
    }
    const { message, detail } = providerErrorDetail(parsed)
    throw new DeepSeekFilesError(
      message ?? `DeepSeek Files API error (HTTP ${response.status})`,
      response.status,
      detail,
    )
  }

  /**
   * 上传一张带显式过期时间的图片。
   * @param input - 确定性请求版本字节、媒体类型、文件名、生存期和取消信号。
   * @returns 已验证的 Provider 文件对象，包含 `expires_at`。
   */
  async upload(input: {
    data: Uint8Array
    mediaType: ImageMediaType
    filename: string
    expiresAfterSeconds: number
    signal?: AbortSignal
  }): Promise<DeepSeekFileObject & { expiresAt: number }> {
    if (input.data.byteLength > MAX_FILE_UPLOAD_BYTES) {
      throw new LlmError('DeepSeek Files API upload exceeds 128 MiB.', 'INVALID_REQUEST')
    }
    if (!Number.isSafeInteger(input.expiresAfterSeconds)
      || input.expiresAfterSeconds < MIN_FILE_EXPIRY_SECONDS
      || input.expiresAfterSeconds > MAX_FILE_EXPIRY_SECONDS) {
      throw new LlmError('DeepSeek file expiry must be between 3600 and 2592000 seconds.', 'INVALID_REQUEST')
    }
    const form = new FormData()
    form.set('purpose', 'user_data')
    form.set('expires_after[anchor]', 'created_at')
    form.set('expires_after[seconds]', String(input.expiresAfterSeconds))
    form.set('file', new Blob([Uint8Array.from(input.data).buffer], { type: input.mediaType }), input.filename)
    const response = await this.request('/files', { method: 'POST', body: form }, input.signal)
    const file = parseFileObject(await response.json(), 'upload')
    if (file.expiresAt === undefined) throw invalidResponse('upload')
    return { ...file, expiresAt: file.expiresAt }
  }

  /**
   * 按升序或降序列出一页 user-data 文件。
   * @param options - 分页、排序和取消选项。
   * @returns 已验证的页。
   */
  async list(options: {
    after?: DeepSeekFileIdType
    limit?: number
    order?: 'asc' | 'desc'
    signal?: AbortSignal
  } = {}): Promise<DeepSeekFilePage> {
    const query = new URLSearchParams({ purpose: 'user_data' })
    if (options.after !== undefined) query.set('after', options.after)
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.order !== undefined) query.set('order', options.order)
    const response = await this.request(`/files?${query.toString()}`, { method: 'GET' }, options.signal)
    const value = await response.json() as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('list')
    const wire = value as { object?: unknown; data?: unknown; first_id?: unknown; last_id?: unknown; has_more?: unknown }
    if (wire.object !== 'list' || !Array.isArray(wire.data) || typeof wire.has_more !== 'boolean'
      || (wire.first_id !== undefined && typeof wire.first_id !== 'string')
      || (wire.last_id !== undefined && typeof wire.last_id !== 'string')) {
      throw invalidResponse('list')
    }
    return {
      data: wire.data.map(item => parseFileObject(item, 'list')),
      ...typeof wire.first_id === 'string' ? { firstId: DeepSeekFileId(wire.first_id) } : {},
      ...typeof wire.last_id === 'string' ? { lastId: DeepSeekFileId(wire.last_id) } : {},
      hasMore: wire.has_more,
    }
  }

  /**
   * 读取一个文件对象。
   * @param fileId - Provider 文件标识符。
   * @param signal - 请求取消信号。
   * @returns 已验证的文件对象。
   */
  async retrieve(fileId: DeepSeekFileIdType, signal?: AbortSignal): Promise<DeepSeekFileObject> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}`, { method: 'GET' }, signal)
    return parseFileObject(await response.json(), 'retrieve')
  }

  /**
   * 删除一个 Provider 文件。
   * @param fileId - Provider 文件标识符。
   * @param signal - 请求取消信号。
   */
  async delete(fileId: DeepSeekFileIdType, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, signal)
    const value = await response.json() as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('delete')
    const wire = value as { id?: unknown; object?: unknown; deleted?: unknown }
    if (wire.id !== fileId || wire.object !== 'file' || wire.deleted !== true) throw invalidResponse('delete')
  }
}
