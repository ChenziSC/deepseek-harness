/** Deterministic ordering helpers shared by index and offline code. */

/**
 * Compare strings by Unicode code points rather than locale.
 * @param left - first string.
 * @param right - second string.
 * @returns a negative, zero, or positive ordering value.
 */
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  const count = Math.min(a.length, b.length)
  for (let index = 0; index < count; index += 1) {
    const difference = ((a[index] as string).codePointAt(0) as number)
      - ((b[index] as string).codePointAt(0) as number)
    if (difference !== 0) return difference
  }
  return a.length - b.length
}
