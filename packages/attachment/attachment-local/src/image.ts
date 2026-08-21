/** 光栅检查：准入时完整解码，读取已验证对象时只探测文件头。 */

import sharp, { type Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** 受支持图片的解码元数据。 */
export interface DetectedImage {
  mediaType: ImageMediaType
  /** 应用 EXIF 方向后的固有宽度，即查看器中感知到的宽度。 */
  width: number
  /** 应用 EXIF 方向后的固有高度，即查看器中感知到的高度。 */
  height: number
  /** 容器是否包含多帧。 */
  animated: boolean
  /** 字节是否携带描述性元数据、颜色配置或方向。 */
  carriesMetadata: boolean
  /** Sharp 为解码通道报告的采样深度。 */
  depth: string
  /** Sharp 为解码像素报告的颜色空间。 */
  space: string
  /** 解码像素是否携带 alpha 通道。 */
  hasAlpha: boolean
}

/**
 * 检查本包编码器产生字节的 alpha 元数据。Sharp/libvips 可能在 WebP 输出中省略
 * 全不透明 alpha 平面；除此之外的任何增删都表示编码结果与源图事实不兼容。
 * @param sourceHasAlpha - 源字节是否声明 alpha 平面；源帧未指定时为 undefined。
 * @param output - 编码结果的解码媒体类型和 alpha 元数据。
 * @returns 输出 alpha 元数据是否与源图兼容。
 */
export function encodedAlphaIsCompatible(
  sourceHasAlpha: boolean | undefined,
  output: Pick<DetectedImage, 'mediaType' | 'hasAlpha'>,
): boolean {
  return sourceHasAlpha === undefined
    || output.hasAlpha === sourceHasAlpha
    || (sourceHasAlpha && !output.hasAlpha && output.mediaType === 'image/webp')
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function carriesRetainedMetadata(metadata: Awaited<ReturnType<Sharp['metadata']>>): boolean {
  return metadata.exif !== undefined
    || metadata.xmp !== undefined
    || metadata.iptc !== undefined
    || metadata.icc !== undefined
    || metadata.hasProfile
    || metadata.tifftagPhotoshop !== undefined
    || metadata.comments !== undefined
    || metadata.orientation !== undefined
}

async function imageMetadata(image: Sharp): Promise<DetectedImage> {
  const metadata = await image.metadata()
  const mediaType = MEDIA_TYPES[metadata.format as string]
  if (mediaType === undefined) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  // EXIF 方向 5–8 会转置存储光栅；这里报告感知轴，使上限、源图事实和坐标建议使用同一坐标系。
  const transposed = metadata.orientation !== undefined && metadata.orientation >= 5
  return {
    mediaType,
    width: transposed ? metadata.height : metadata.width,
    height: transposed ? metadata.width : metadata.height,
    animated: (metadata.pages ?? 1) > 1,
    carriesMetadata: carriesRetainedMetadata(metadata),
    depth: metadata.depth,
    space: metadata.space,
    hasAlpha: metadata.hasAlpha,
  }
}

/**
 * 解析受支持光栅的文件头，不解码像素即返回固有元数据。摘要验证后的读取使用此路径：
 * 准入已证明这些精确字节可完整解码，因此读取时只重新派生引用字段，避免再次支付全光栅解码成本。
 * @param data - 完整编码图片字节。
 * @returns 已验证的格式与尺寸。
 */
export async function probeImage(data: Uint8Array): Promise<DetectedImage> {
  try {
    return await imageMetadata(sharp(data, { failOn: 'error', limitInputPixels: false }))
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/** 应用于解码光栅固有尺寸的准入上限。 */
export interface DecodedImageLimits {
  /** 解码像素数（宽乘高）准入上限。 */
  maxPixels?: number
  /** 独立应用于宽和高的单边准入上限。 */
  maxDimension?: number
}

/**
 * 完整解码受支持的光栅并返回固有元数据。这是准入路径：只有全光栅解码成功后，
 * 字节才能进入内容寻址存储。
 * @param data - 完整编码图片字节。
 * @param limits - 固有尺寸准入上限。
 * @returns 已验证的格式与尺寸。
 */
export async function detectImage(data: Uint8Array, limits?: DecodedImageLimits): Promise<DetectedImage> {
  try {
    const image = sharp(data, { failOn: 'error', limitInputPixels: false })
    const detected = await imageMetadata(image)
    if (limits?.maxPixels !== undefined && detected.width * detected.height > limits.maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    if (limits?.maxDimension !== undefined && Math.max(detected.width, detected.height) > limits.maxDimension) {
      throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
    }
    await image.raw().toBuffer()
    return detected
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}
