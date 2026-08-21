/**
 * 合并权威基线，同时保持客户端已显示身份的现有顺序。只存在于基线中的身份会相对于
 * 其后最近的已知身份插入；基线中不存在的身份会被删除。
 *
 * @param current - 已建立的客户端顺序。
 * @param baseline - 最新权威条目。
 * @param keyOf - 稳定身份选择函数。
 * @returns 使用基线值且保留既有相对顺序的条目。
 */
export function mergeOrderedBaseline<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => unknown,
): T[] {
  const baselineByKey = new Map<unknown, T>()
  for (const value of baseline) baselineByKey.set(keyOf(value), value)

  const merged = current
    .map(value => baselineByKey.get(keyOf(value)))
    .filter((value): value is T => value !== undefined)
  const mergedKeys = new Set(merged.map(keyOf))

  for (let index = 0; index < baseline.length; index++) {
    const value = baseline[index]
    /* v8 ignore next -- 稠密数组保护：index 受 baseline.length 限制。 */
    if (value === undefined || mergedKeys.has(keyOf(value))) continue
    let insertion = merged.length
    for (let following = index + 1; following < baseline.length; following++) {
      const candidate = baseline[following]
      /* v8 ignore next -- 稠密数组保护：following 受 baseline.length 限制。 */
      if (candidate === undefined) continue
      const known = merged.findIndex(item => keyOf(item) === keyOf(candidate))
      if (known !== -1) {
        insertion = known
        break
      }
    }
    merged.splice(insertion, 0, value)
    mergedKeys.add(keyOf(value))
  }
  return merged
}
