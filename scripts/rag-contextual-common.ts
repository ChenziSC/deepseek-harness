/** Narrow argument and output-directory helpers shared by contextual RAG scripts. */

import { mkdir, readdir } from 'node:fs/promises'

/** Require one non-empty command-line option. */
export function required(value: string | undefined, option: string): string {
  if (value === undefined || value.trim().length === 0) throw new TypeError(`--${option} is required`)
  return value
}

/** Parse one positive safe-integer command-line option. */
export function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(required(value, option))
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`--${option} must be a positive integer`)
  return parsed
}

/** Create an output directory or reject an existing non-empty directory. */
export async function prepareOutputDirectory(path: string): Promise<void> {
  try {
    if ((await readdir(path)).length > 0) throw new TypeError(`output directory is not empty: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(path, { recursive: true })
  }
}
