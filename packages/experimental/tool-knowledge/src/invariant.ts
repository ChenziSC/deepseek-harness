/** Package-owned invariant companion for the experimental knowledge tool. @module @deepseek-ai/dsh-experimental-tool-knowledge/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-tool-knowledge'

/** Cordis companion plugin name. */
export const name = 'tool-knowledge-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: the registries own prompt and tool membership. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
