/** Command dispatcher for the experimental `dsh-knowledge` executable. */

import { runEvaluate, runPrepare, runSlice } from './cli/benchmarks.ts'
import {
  runContextualGenerate,
  runContextualPlan,
  runContextualStatistics,
} from './cli/contextual.ts'
import { runDerive } from './cli/derive.ts'
import { runIndex } from './cli/index.ts'
import { type CliInput, type CliOutput } from './cli/options.ts'
import { runVerify } from './cli/verify.ts'

const HELP = `Usage: dsh-knowledge <command> [options]

Commands:
  prepare   Prepare a fixed benchmark dataset
  slice     Build deterministic nested T2Ranking benchmark slices
  contextual-plan      Plan bounded contextual-prefix generation without calling a model
  contextual-generate  Generate and cache prefixes for one reviewed plan
  contextual-statistics  Scan a complete corpus without building an index or calling a model
  index     Build an immutable local index
  derive    Reuse Exact vectors to build a smaller prefix index
  evaluate  Run the fixed retrieval evaluations
  verify    Recompute and validate every index payload hash`

/**
 * Execute the CLI and return its process exit code.
 * @param argv - arguments after the executable name.
 * @param stdout - destination for help and successful summaries.
 * @param stderr - destination for validation and execution failures.
 * @param stdin - source for interactive Dense index selection.
 * @returns zero on success or two for invalid or failed commands.
 */
export async function runCli(
  argv: readonly string[],
  stdout: CliOutput,
  stderr: CliOutput,
  stdin: CliInput = process.stdin,
): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      stdout.write(`${HELP}\n`)
      return 0
    }
    const [command, ...options] = argv
    if (command === 'prepare') return await runPrepare(options, stdout)
    if (command === 'slice') return await runSlice(options, stdout)
    if (command === 'contextual-plan') return await runContextualPlan(options, stdout)
    if (command === 'contextual-generate') return await runContextualGenerate(options, stdout)
    if (command === 'contextual-statistics') return await runContextualStatistics(options, stdout)
    if (command === 'index') return await runIndex(options, stdin, stdout, stderr)
    if (command === 'derive') return await runDerive(options, stdout)
    if (command === 'evaluate') return await runEvaluate(options, stdout)
    if (command === 'verify') return await runVerify(options, stdout)
    stderr.write(`dsh-knowledge: unknown command "${command}"\n`)
    return 2
  } catch (error) {
    stderr.write(`dsh-knowledge: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}
