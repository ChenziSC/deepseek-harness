/** Deterministic Latin/CJK script profiling used by query routing. */

/** Coarse script profile recorded for a corpus or derived from one query. */
export type TextScriptProfile = 'latin' | 'cjk' | 'mixed' | 'neutral'

/** Counted letters used to merge corpus batches without retaining source text. */
export interface TextScriptCounts {
  readonly latin: number
  readonly cjk: number
}

const LATIN = /\p{Script=Latin}/u
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Count Latin and CJK letters in text.
 * @param text - query or source text to inspect.
 * @returns mergeable script counts.
 */
export function countTextScripts(text: string): TextScriptCounts {
  let latin = 0
  let cjk = 0
  for (const character of text) {
    if (LATIN.test(character)) latin += 1
    else if (CJK.test(character)) cjk += 1
  }
  return { latin, cjk }
}

/**
 * Resolve a coarse profile, treating a 20% minority as a mixed-language signal.
 * @param counts - Latin and CJK letter counts.
 * @returns the deterministic script profile.
 */
export function resolveTextScriptProfile(counts: TextScriptCounts): TextScriptProfile {
  const total = counts.latin + counts.cjk
  if (total === 0) return 'neutral'
  if (Math.min(counts.latin, counts.cjk) / total >= 0.2) return 'mixed'
  return counts.cjk > counts.latin ? 'cjk' : 'latin'
}

/**
 * Derive a coarse script profile directly from text.
 * @param text - query or source text to inspect.
 * @returns the deterministic script profile.
 */
export function profileTextScript(text: string): TextScriptProfile {
  return resolveTextScriptProfile(countTextScripts(text))
}
