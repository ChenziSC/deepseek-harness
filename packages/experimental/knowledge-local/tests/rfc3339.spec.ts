import { describe, expect, it } from 'vitest'
import { parseRfc3339Instant } from '../src/rfc3339.ts'

describe('RFC 3339 instants', () => {
  it.each([
    ['2026-02-01T00:00:00Z', '2026-02-01T00:00:00.000Z'],
    ['2024-02-29T23:59:59.1+08:30', '2024-02-29T15:29:59.100Z'],
    ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
    ['2024-01-01T00:00:00.12-05:45', '2024-01-01T05:45:00.120Z'],
    ['2024-01-01T00:00:00.123Z', '2024-01-01T00:00:00.123Z'],
  ])('normalizes %s to UTC milliseconds', (input, expected) => {
    const parsed = parseRfc3339Instant(input, 'fixture')
    expect(parsed).toEqual({ text: expected, epochMs: Date.parse(expected) })
  })

  it.each([
    '2026-02-01',
    '2026-02-01T00:00:00',
    '2026-02-01T00:00:00z',
    '2026-02-01T00:00:00.1234Z',
  ])('requires the supported explicit-timezone syntax for %s', (input) => {
    expect(() => parseRfc3339Instant(input, 'fixture')).toThrow(
      'fixture must be an RFC 3339 timestamp with an explicit timezone',
    )
  })

  it.each([
    '0000-01-01T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2023-02-29T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00+00:60',
  ])('rejects invalid calendar or offset fields in %s', (input) => {
    expect(() => parseRfc3339Instant(input, 'fixture')).toThrow('fixture must be a valid RFC 3339 timestamp')
  })
})
