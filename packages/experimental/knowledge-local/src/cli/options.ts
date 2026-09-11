/** Shared primitive option parsing for `dsh-knowledge` commands. */

import type { ChunkingStrategy } from '../chunker.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION } from '../tokenizer.ts'

/** Shared corpus and chunking flags used by product and offline commands. */
export const CORPUS_CHUNKING_OPTIONS = {
  corpus: { type: 'string' },
  'corpus-format': { type: 'string', default: 'generic' },
  output: { type: 'string' },
  'model-cache-dir': { type: 'string' },
  'max-tokens': { type: 'string', default: '384' },
  'overlap-tokens': { type: 'string', default: '64' },
  'chunking-strategy': { type: 'string', default: 'markdown-structure-v1' },
} as const

/** Corpus flags extended with the explicit tokenizer identity required by offline planning. */
export const PLANNING_CORPUS_OPTIONS = {
  ...CORPUS_CHUNKING_OPTIONS,
  'tokenizer-model-id': { type: 'string', default: BGE_M3_MODEL_ID },
  'tokenizer-revision': { type: 'string', default: BGE_M3_REVISION },
} as const

/** Writable stream used by command handlers without requiring a process global. */
export interface CliOutput extends Pick<NodeJS.WriteStream, 'write'> {
  readonly isTTY?: boolean
}

/** Readable stream used for interactive command input. */
export interface CliInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean
}

/** Return a non-empty required option value. */
export function required(value: string | undefined, option: string): string {
  if (value === undefined || value.trim().length === 0) throw new TypeError(`--${option} is required`)
  return value
}

/** Parse one finite numeric option. */
export function numberOption(value: string | undefined, option: string): number {
  const parsed = Number(required(value, option))
  if (!Number.isFinite(parsed)) throw new TypeError(`--${option} must be a finite number`)
  return parsed
}

/** Parse one safe integer with an inclusive lower bound. */
export function integerOption(value: string | undefined, option: string, minimum: number): number {
  const parsed = numberOption(value, option)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`--${option} must be a safe integer of at least ${minimum}`)
  }
  return parsed
}

/** Parse one supported corpus input format. */
export function corpusFormat(value: string | undefined): 'generic' | 'scifact' | 'mldr' | 't2ranking' {
  if (value === 'generic' || value === 'scifact' || value === 'mldr' || value === 't2ranking') return value
  throw new TypeError('--corpus-format must be generic, scifact, mldr, or t2ranking')
}

/** Parse one supported chunking strategy. */
export function chunkingStrategy(value: string | undefined): ChunkingStrategy {
  if (value === 'token-window-v1' || value === 'markdown-structure-v1') return value
  throw new TypeError('--chunking-strategy must be token-window-v1 or markdown-structure-v1')
}

/** Parse a comma-separated subset while preserving first occurrence order. */
export function listOption<T extends string>(value: string, option: string, allowed: readonly T[]): T[] {
  const items = value.split(',')
  if (items.some(item => !allowed.includes(item as T))) {
    throw new TypeError(`--${option} must be a comma-separated subset of ${allowed.join(',')}`)
  }
  return [...new Set(items as T[])]
}

/** Parse a comma-separated positive-integer list. */
export function numberListOption(value: string, option: string): number[] {
  const items = value.split(',').map(item => Number(item))
  if (items.length === 0 || items.some(item => !Number.isSafeInteger(item) || item < 1)) {
    throw new TypeError(`--${option} must be a comma-separated list of positive integers`)
  }
  return items
}
