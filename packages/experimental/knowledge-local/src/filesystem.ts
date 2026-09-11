/** Filesystem operations shared by index and offline artifact writers. */

import { mkdir, readdir } from 'node:fs/promises'

/**
 * Require an empty directory, creating it when absent.
 * @param directory - target directory.
 * @param message - error text used when the target is not empty.
 */
export async function prepareEmptyDirectory(directory: string, message: string): Promise<void> {
  try {
    const entries = await readdir(directory)
    if (entries.length > 0) throw new TypeError(message)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(directory, { recursive: true })
  }
}
