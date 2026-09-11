/** Text comparison helpers used only by offline evaluations. */

/**
 * Return the length of the longest contiguous substring shared by two strings.
 * @param left - first text.
 * @param right - second text.
 * @returns longest shared substring length in UTF-16 code units.
 */
export function longestCommonSubstring(left: string, right: string): number {
  const previous = new Uint32Array(right.length + 1)
  let longest = 0
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const saved = previous[rightIndex] as number
      previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1] ? diagonal + 1 : 0
      longest = Math.max(longest, previous[rightIndex] as number)
      diagonal = saved
    }
  }
  return longest
}
