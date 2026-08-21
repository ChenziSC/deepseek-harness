/** DeepSeek Files API 的不透明标识类型。 @module dsh-llm-deepseek/file-id */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** DeepSeek Files API 返回的不透明标识符。 */
export type DeepSeekFileId = Branded<'DeepSeekFileId'>

/**
 * 在线协议验证后，为 Provider 返回的文件标识符加上品牌类型。
 * @param id - 非空 Files API 标识符。
 * @returns 原字符串，但在类型层携带 Provider 身份。
 */
export function DeepSeekFileId(id: string): DeepSeekFileId {
  return id as DeepSeekFileId
}

/** 标识某个端点与 API key 文件命名空间的非机密摘要。 */
export type DeepSeekFileScope = Branded<'DeepSeekFileScope'>

/**
 * 为本地派生的命名空间摘要加上品牌类型。
 * @param scope - 端点与 API key 的 SHA-256 摘要。
 * @returns 原字符串，但在类型层携带命名空间身份。
 */
export function DeepSeekFileScope(scope: string): DeepSeekFileScope {
  return scope as DeepSeekFileScope
}
