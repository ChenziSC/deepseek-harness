/**
 * Package-owned invariant companion for the experimental local knowledge provider.
 * @module @deepseek-ai/dsh-experimental-knowledge-local/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-knowledge-local'

/** Cordis companion plugin name. */
export const name = 'knowledge-local-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: immutable index validation occurs before the service becomes ready. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
