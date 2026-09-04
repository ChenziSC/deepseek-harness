#!/usr/bin/env node
/**
 * Process entry point for offline knowledge preparation, indexing, and evaluation.
 * @module @deepseek-ai/dsh-experimental-knowledge-local/bin
 */

import { runCli } from './cli.ts'

/* v8 ignore start -- thin process adapter over the unit-tested CLI function */
try {
  process.exitCode = await runCli(process.argv.slice(2), process.stdout, process.stderr)
} catch (error) {
  process.stderr.write(`dsh-knowledge: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
/* v8 ignore stop */
