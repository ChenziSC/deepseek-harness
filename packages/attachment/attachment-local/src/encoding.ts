/** 持久规范化与模型请求图片编码器共用的惰性候选执行器。 */

/** 一个携带完整编码字节的候选结果。 */
export interface EncodedCandidate {
  data: Uint8Array
}

/** 在同一光栅尺寸下耗尽候选格式仍无超内输出时的结果。 */
export interface ExhaustedEncoding<T extends EncodedCandidate> {
  smallest: T
}

/**
 * 按偏好顺序执行编码候选，找到第一个不超字节上限的输出即停止。候选保持惰性，
 * 使 PNG/WebP/JPEG 的后备转换只在前一结果超限后发生。
 * @param attempts - 从首选到后备排列的惰性编码器。
 * @param maxBytes - 编码字节数正数上限。
 * @returns 第一个超内候选；全部超限时返回其中最小的结果，供上层计算缩小比例。
 */
export async function encodeFirstWithinLimit<T extends EncodedCandidate>(
  attempts: readonly (() => Promise<T>)[],
  maxBytes: number,
): Promise<T | ExhaustedEncoding<T>> {
  const [first, ...remaining] = attempts
  if (first === undefined) throw new Error('image encoding requires at least one candidate')
  let smallest = await first()
  if (smallest.data.byteLength <= maxBytes) return smallest
  for (const attempt of remaining) {
    const candidate = await attempt()
    if (candidate.data.byteLength <= maxBytes) return candidate
    if (candidate.data.byteLength < smallest.data.byteLength) {
      smallest = candidate
    }
  }
  return { smallest }
}

/**
 * 判断某一尺寸下的惰性编码是否已耗尽所有候选。
 * @param result - 第一个超内候选，或候选耗尽结果。
 * @returns 是否每个候选都超过字节上限。
 */
export function isExhaustedEncoding<T extends EncodedCandidate>(
  result: T | ExhaustedEncoding<T>,
): result is ExhaustedEncoding<T> {
  return 'smallest' in result
}
