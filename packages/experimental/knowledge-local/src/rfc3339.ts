/** Strict RFC 3339 instant parsing shared by corpus and search request validation. */

/** One normalized millisecond-precision RFC 3339 instant. */
export interface Rfc3339Instant {
  readonly text: string
  readonly epochMs: number
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u

/**
 * Parse one explicit-timezone RFC 3339 instant at millisecond precision.
 * @param value - timestamp text to validate and normalize.
 * @param label - value name included in validation errors.
 * @returns the UTC ISO representation and Unix milliseconds.
 */
export function parseRfc3339Instant(value: string, label: string): Rfc3339Instant {
  const match = RFC3339.exec(value)
  if (match === null) throw new TypeError(`${label} must be an RFC 3339 timestamp with an explicit timezone`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'))
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10])
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11])
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > 31
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    throw new TypeError(`${label} must be a valid RFC 3339 timestamp`)
  }
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millisecond)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError(`${label} must be a valid RFC 3339 timestamp`)
  }
  const offset = (offsetHour * 60 + offsetMinute) * 60_000
  const epochMs = date.getTime() + (match[9] === '+' ? -offset : match[9] === '-' ? offset : 0)
  return { text: new Date(epochMs).toISOString(), epochMs }
}
