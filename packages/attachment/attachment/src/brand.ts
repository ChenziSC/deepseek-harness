/** Attachment identifier brand. @module @deepseek-ai/dsh-attachment/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque content-addressed identifier for one immutable attachment object. */
export type AttachmentId = Branded<'AttachmentId'>

/**
 * Brand a validated storage identifier.
 * @param value - backend-produced opaque identifier.
 * @returns the branded identifier.
 */
export function AttachmentId(value: string): AttachmentId {
  return value as AttachmentId
}

/** 某次请求图片转换的不透明确定性身份。 */
export type ImageVariantId = Branded<'ImageVariantId'>

/**
 * 为已验证的请求图片转换标识符加上品牌类型。
 * @param value - 附件 Provider 生成的不透明标识符。
 * @returns 品牌化标识符。
 */
export function ImageVariantId(value: string): ImageVariantId {
  return value as ImageVariantId
}
