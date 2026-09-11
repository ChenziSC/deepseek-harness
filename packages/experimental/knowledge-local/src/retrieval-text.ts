/** Shared construction of lexical and Dense retrieval input text. */

/**
 * Join the distinct document title, section path, and chunk body used for retrieval.
 * @param title - optional source-document title.
 * @param sectionPath - optional Markdown heading path.
 * @param text - exact chunk body.
 * @returns deterministic retrieval input shared by BM25 and Dense indexing.
 */
export function retrievalText(title: string | undefined, sectionPath: string | undefined, text: string): string {
  return [...new Set([title, sectionPath, text].filter((value): value is string => value !== undefined))].join('\n')
}
