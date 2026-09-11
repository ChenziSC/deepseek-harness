/** Read-only index verification command. */

import { parseArgs } from 'node:util'
import { verifyKnowledgeIndex } from '../index-format.ts'
import { required, type CliOutput } from './options.ts'

/** Recompute and validate every payload hash for one index. */
export async function runVerify(argv: readonly string[], stdout: CliOutput): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: { index: { type: 'string' } },
  })
  const indexDir = required(values.index, 'index')
  const manifest = await verifyKnowledgeIndex(indexDir)
  stdout.write(`${JSON.stringify({
    index: indexDir,
    payloads: manifest.payloads.map(payload => ({ path: payload.path, bytes: payload.bytes, sha256: payload.sha256 })),
  })}\n`)
  return 0
}
