/**
 * Package-owned invariant companion for the experimental knowledge Service Definition.
 * @module @deepseek-ai/dsh-experimental-knowledge/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-knowledge'

/** Cordis companion plugin name. */
export const name = 'knowledge-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: providers own indexed data and retrieval observations. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
