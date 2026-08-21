/** ContentBlock 结构遍历与模型请求期图片投影。 @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock } from './types.ts'
import type { Message } from './message.ts'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

/**
 * 为满足 Provider 请求上限而移除图片时，发送给模型的替代文本。该字符串属于模型可见运行时协议，
 * 因此保持英文；修改会影响 prompt 语义、快照和回放。
 */
export const OFFLOADED_IMAGE_TEXT
  = '[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/**
 * 精确纯文本模型无法接受持久图片引用时，发送给模型的稳定英文文本。它是请求期投影，
 * 不改写 session 持久历史。
 * @param ref - 从本次请求中省略的持久主引用。
 * @returns 确定性纯文本占位符。
 */
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}

/**
 * 某个精确请求图片的稳定模型可见句柄。运行时文本保持英文，使不同 Provider 接收同一句柄。
 * @param version - 与文本相邻发送的精确请求图片。
 * @returns 附件句柄与请求图片尺寸。
 */
export function requestImageHandleText(version: RequestImageAttachment): string {
  return `Image ${version.attachment.attachmentId}; request image ${version.width}x${version.height}px.`
}

/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/** 某种请求表示的字节计量与量化移除策略。 */
export interface RequestImageOffloadPolicy {
  /** 路由接受的图片数；省略则不限数量。 */
  maxImages?: number
  /** 路由接受的图片累计字节数；省略则不限字节。 */
  maxBytes?: number
  /** 一次确定性步进移除的超额图片数。 */
  countQuantum?: number
  /** 一次确定性步进移除的超额字节数。 */
  byteQuantum?: number
  /** 字节计量使用原始文件字节还是内联 base64 长度。 */
  representation: 'raw' | 'base64'
  /** 解析编码请求版本长度；省略时使用主附件字节数。 */
  byteLength?: (ref: ImageAttachmentRef) => number
}

/** 按请求和嵌套 Block 顺序收集图片表示长度。 */
function collectImageLengths(
  blocks: readonly ContentBlock[],
  lengths: number[],
  policy: RequestImageOffloadPolicy,
): void {
  for (const block of blocks) {
    if (block.type === 'image') {
      const bytes = policy.byteLength === undefined
        ? block.attachment.bytes
        : policy.byteLength(block.attachment)
      lengths.push(policy.representation === 'base64' ? base64Length(bytes) : bytes)
    } else if (block.type === 'tool-result') {
      collectImageLengths(block.content, lengths, policy)
    }
  }
}

/** Replace the first `remaining.count` image occurrences without mutating durable messages. */
function replaceOldestImages(
  blocks: readonly ContentBlock[],
  remaining: { count: number },
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image' && remaining.count > 0) {
      remaining.count -= 1
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: OFFLOADED_IMAGE_TEXT })
      continue
    }
    if (block.type === 'tool-result') {
      const content = replaceOldestImages(block.content, remaining)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/** 为纯文本模型替换每个图片出现位置，包括嵌套工具结果。 */
function replaceImagesForTextModel(blocks: readonly ContentBlock[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: textOnlyImageText(block.attachment) })
      continue
    }
    if (block.type === 'tool-result') {
      const content = replaceImagesForTextModel(block.content)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * 针对精确纯文本模型，把持久图片历史投影为确定性文本。
 * @param messages - 完整请求历史。
 * @returns 无图片时返回原列表，否则返回带稳定占位符的浅拷贝消息。
 */
export function projectImagesForTextModel(messages: readonly Message[]): readonly Message[] {
  if (!messages.some(message => contentHasImage(message.content))) return messages
  return messages.map((message) => {
    const content = replaceImagesForTextModel(message.content)
    return content === message.content ? message : { ...message, content }
  })
}

/**
 * Return transient request messages whose oldest images are replaced until
 * their accumulated base64 payload fits the configured bound. The selection
 * is deterministic from durable message order and attachment metadata; a
 * provider can serialize the returned messages without reading omitted bytes.
 * @param messages - complete request history, oldest first.
 * @param maxRequestImageBytes - positive bound on total base64 image payload; undefined preserves every image.
 * @returns the original messages when they already fit, otherwise shallow message copies with replaced content trees.
 */
export function offloadRequestImages(
  messages: readonly Message[],
  maxRequestImageBytes: number | undefined,
): readonly Message[] {
  return offloadRequestImagesWithPolicy(messages, {
    representation: 'base64',
    ...maxRequestImageBytes === undefined ? {} : { maxBytes: maxRequestImageBytes },
    byteQuantum: 1,
  })
}

/**
 * 返回确定性临时投影：路由预算超限后，按整数个数和字节量子替换最旧图片。目标只取决于
 * 完整持久历史：128 MiB 上限、64 MiB 量子下出现 129 张各 1 MiB 图片时，移除最旧 65 张，
 * 留下 64 MiB；直到总历史超过 192 MiB 前，该移除前缀保持不变，从而减少 prompt cache 失效。
 * @param messages - 完整请求历史，最旧的在前。
 * @param policy - 路由表示、预算和移除量子。
 * @returns 两项预算内返回原消息，否则返回带确定性占位符的浅拷贝。
 */
export function offloadRequestImagesWithPolicy(
  messages: readonly Message[],
  policy: RequestImageOffloadPolicy,
): readonly Message[] {
  const lengths: number[] = []
  for (const message of messages) collectImageLengths(message.content, lengths, policy)
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excessCount = policy.maxImages === undefined ? 0 : Math.max(0, lengths.length - policy.maxImages)
  const excessBytes = policy.maxBytes === undefined ? 0 : Math.max(0, total - policy.maxBytes)
  if (excessCount === 0 && excessBytes === 0) return messages
  const countQuantum = policy.countQuantum ?? 1
  const byteQuantum = policy.byteQuantum ?? 1
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0
  let removedBytes = 0
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += imageBytes
    count += 1
  }
  const remaining = { count }
  return messages.map((message) => {
    const content = replaceOldestImages(message.content, remaining)
    return content === message.content ? message : { ...message, content }
  })
}
