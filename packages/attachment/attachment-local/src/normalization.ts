/** 确定性、与 Provider 无关的持久图片规范化。 */

import sharp, { type Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { encodeFirstWithinLimit, isExhaustedEncoding } from './encoding.ts'
import { detectImage, encodedAlphaIsCompatible } from './image.ts'
import type { DetectedImage } from './image.ts'

/** 部署解析后的持久规范化附件策略。 */
export interface NormalizationPolicy {
  /** 长边像素上限；更大的源图按比例缩小。 */
  maxDimension: number
  /** 规范化编码字节数的独立安全上限。 */
  maxBytes: number
}

/** 规范化字节及其持久引用需要记录的事实。 */
export interface NormalizedImage {
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
}

const NORMALIZATION_QUALITIES = [85, 80, 75] as const
const LOW_COLOUR_SAMPLE_EDGE = 128
const LOW_COLOUR_LIMIT = 256
const MIN_SCALE_STEP = 0.9

/** 编码一条已准备的管线，并返回编码后的精确尺寸与格式。 */
async function encode(
  pipeline: Sharp,
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp',
  quality?: number,
  palette = true,
): Promise<NormalizedImage> {
  const encoded = mediaType === 'image/png'
    ? pipeline.png({ compressionLevel: 9, palette })
    : mediaType === 'image/webp'
      ? pipeline.webp({ quality })
      : pipeline.jpeg({ quality })
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), mediaType, width: info.width, height: info.height }
}

/**
 * 判断源字节是否已满足规范化要求。只有单帧、无元数据、8-bit sRGB 且位于两项上限内
 * 的图片才可字节级直通，避免不必要的有损重编码。
 * @param detected - 完整解码后的源图事实。
 * @param bytes - 源图编码字节数。
 * @param policy - 已解析的规范化上限。
 * @returns 是否可以保留原字节。
 */
export function canPassThroughNormalization(
  detected: DetectedImage,
  bytes: number,
  policy: NormalizationPolicy,
): boolean {
  return detected.mediaType !== 'image/gif'
    && !detected.animated
    && !detected.carriesMetadata
    && detected.depth === 'uchar'
    && detected.space === 'srgb'
    && bytes <= policy.maxBytes
    && Math.max(detected.width, detected.height) <= policy.maxDimension
}

/**
 * 对有界像素样本分类，不根据 PNG 格式臆测它是截图。低色数图片优先尝试 PNG，
 * 其他图片则避免 PNG 产生过大输出。
 * @param pipeline - 输出缩放前、已应用方向的 sRGB 源管线。
 * @returns 最近邻采样的色数是否位于低色数阈值内。
 */
export async function hasLowColourCount(pipeline: Sharp): Promise<boolean> {
  const { data, info } = await pipeline.clone().resize({
    width: LOW_COLOUR_SAMPLE_EDGE,
    height: LOW_COLOUR_SAMPLE_EDGE,
    fit: 'inside',
    withoutEnlargement: true,
    kernel: sharp.kernel.nearest,
    fastShrinkOnLoad: false,
  }).raw().toBuffer({ resolveWithObject: true })
  const colours = new Set<number>()
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data.readUInt8(offset)
    const green = data.readUInt8(offset + 1)
    const blue = data.readUInt8(offset + 2)
    const alpha = info.channels === 4 ? data.readUInt8(offset + 3) : 255
    colours.add(((red >> 3) << 15) | ((green >> 3) << 10) | ((blue >> 3) << 5) | (alpha >> 3))
    if (colours.size > LOW_COLOUR_LIMIT) return false
  }
  return true
}

/** 验证规范化输出为事实匹配的单帧 8-bit sRGB/sRGBA 图片。 */
async function verifyNormalizedImage(
  image: NormalizedImage,
  expectedAlpha: boolean | undefined,
): Promise<NormalizedImage> {
  const detected = await detectImage(image.data)
  if (detected.mediaType !== image.mediaType
    || detected.width !== image.width
    || detected.height !== image.height
    || detected.animated
    || detected.carriesMetadata
    || detected.depth !== 'uchar'
    || detected.space !== 'srgb'
    || !encodedAlphaIsCompatible(expectedAlpha, detected)) {
    throw new AttachmentError(
      'Image normalization did not produce a single-frame 8-bit sRGB image with matching metadata.',
      'ATTACHMENT_WRITE_FAILED',
    )
  }
  return image
}

/** 从提交字节构建定尺寸、已应用方向、无元数据的 sRGB 管线。 */
function preparedPipeline(data: Uint8Array, width: number, height: number): Sharp {
  return sharp(data, { failOn: 'error', limitInputPixels: false })
    .rotate()
    .toColourspace('srgb')
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
}

/** 保持宽高比并限制长边后的尺寸。 */
function initialDimensions(detected: DetectedImage, maxDimension: number): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(detected.width, detected.height))
  return {
    width: Math.max(1, Math.round(detected.width * scale)),
    height: Math.max(1, Math.round(detected.height * scale)),
  }
}

/** 同一尺寸下，根据采样色彩复杂度和 alpha 分支确定惰性编码顺序。 */
function encodingAttemptsAtSize(
  data: Uint8Array,
  width: number,
  height: number,
  hasAlpha: boolean,
  lowColour: boolean,
): Array<() => Promise<NormalizedImage>> {
  const prepared = preparedPipeline(data, width, height)
  const webp = NORMALIZATION_QUALITIES.map(quality => (
    () => encode(prepared.clone(), 'image/webp', quality)
  ))
  if (lowColour) {
    return [() => encode(prepared.clone(), 'image/png', undefined, !hasAlpha), ...webp]
  }
  if (hasAlpha) return webp
  return NORMALIZATION_QUALITIES.map(quality => (
    () => encode(prepared.clone(), 'image/jpeg', quality)
  ))
}

/**
 * 为完整解码的源图生成持久化、与 Provider 无关的规范版本。只有干净、单帧、8-bit
 * sRGB/sRGBA 且同时满足尺寸和字节上限的源图才直通。重编码不会丢弃透明度；达到固定质量
 * 下限后，继续缩小尺寸，直到满足独立字节上限。
 * @param data - 已通过准入的完整源字节。
 * @param detected - 完整解码后的源图事实。
 * @param policy - 已解析的独立规范化上限。
 * @returns 已验证、与 Provider 无关的规范化字节和元数据。
 */
export async function normalizeImage(
  data: Uint8Array,
  detected: DetectedImage,
  policy: NormalizationPolicy,
): Promise<NormalizedImage> {
  if (canPassThroughNormalization(detected, data.byteLength, policy)) {
    return { data, mediaType: detected.mediaType, width: detected.width, height: detected.height }
  }
  try {
    let { width, height } = initialDimensions(detected, policy.maxDimension)
    const classificationPipeline = sharp(data, { failOn: 'error', limitInputPixels: false })
      .rotate()
      .toColourspace('srgb')
    const lowColour = await hasLowColourCount(classificationPipeline)
    for (;;) {
      const encoded = await encodeFirstWithinLimit(
        encodingAttemptsAtSize(data, width, height, detected.hasAlpha, lowColour),
        policy.maxBytes,
      )
      if (!isExhaustedEncoding(encoded)) {
        return await verifyNormalizedImage(encoded, detected.mediaType === 'image/gif' ? undefined : detected.hasAlpha)
      }
      if (width === 1 && height === 1) break
      const sizeScale = Math.sqrt(policy.maxBytes / encoded.smallest.data.byteLength) * 0.95
      const scale = Math.min(MIN_SCALE_STEP, sizeScale)
      const nextWidth = Math.max(1, Math.floor(width * scale))
      const nextHeight = Math.max(1, Math.floor(height * scale))
      width = nextWidth
      height = nextHeight
    }
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    const source = detected.mediaType === 'image/png' && detected.depth !== 'uchar'
      ? `${detected.depth === 'ushort' ? '16-bit' : detected.depth} PNG`
      : `${detected.depth} ${detected.mediaType.slice('image/'.length).toUpperCase()}`
    throw new AttachmentError(
      `The ${source} could not be converted to the normalized 8-bit sRGB form.`,
      'ATTACHMENT_WRITE_FAILED',
      { cause: error },
    )
  }
  throw new AttachmentError('Image cannot be encoded within the configured normalized-image byte cap.', 'IMAGE_TOO_LARGE')
}
