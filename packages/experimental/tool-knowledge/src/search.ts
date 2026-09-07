/** Knowledge-tool output projection and bounded model text rendering. */

import type {
  KnowledgeHit,
  ResolvedKnowledgeSearchStrategy,
} from '@deepseek-ai/dsh-experimental-knowledge'

/** One numbered evidence item exposed by the model-facing tool. */
export interface KnowledgeEvidence {
  readonly citation: string
  readonly documentId: string
  readonly chunkId: string
  readonly title?: string
  readonly sectionPath?: string
  readonly source?: string
  readonly text: string
  readonly previousText?: string
  readonly nextText?: string
}

/** Canonical successful value of `knowledge_search`. */
export interface KnowledgeToolResult {
  readonly evidence: KnowledgeEvidence[]
  readonly truncated: boolean
  readonly strategy: ResolvedKnowledgeSearchStrategy
}

function codePoints(value: string): string[] {
  return Array.from(value)
}

function clip(value: string, maxChars: number): { text: string; truncated: boolean } {
  const points = codePoints(value)
  if (points.length <= maxChars) return { text: value, truncated: false }
  if (maxChars <= 1) return { text: '…'.slice(0, maxChars), truncated: true }
  return { text: `${points.slice(0, maxChars - 1).join('')}…`, truncated: true }
}

function renderEvidence(evidence: KnowledgeEvidence): string {
  const hasContext = evidence.previousText !== undefined || evidence.nextText !== undefined
  return [
    `[${evidence.citation}]`,
    `Document: ${evidence.documentId}`,
    `Chunk: ${evidence.chunkId}`,
    ...(evidence.title === undefined ? [] : [`Title: ${evidence.title}`]),
    ...(evidence.sectionPath === undefined ? [] : [`Section: ${evidence.sectionPath}`]),
    ...(evidence.source === undefined ? [] : [`Source: ${evidence.source}`]),
    ...(hasContext ? ['Matched chunk:', evidence.text] : [evidence.text]),
    ...(evidence.previousText === undefined ? [] : ['Previous chunk:', evidence.previousText]),
    ...(evidence.nextText === undefined ? [] : ['Next chunk:', evidence.nextText]),
  ].join('\n')
}

/**
 * Render the canonical value into the exact text sent to the model.
 * @param result - bounded structured tool result.
 * @returns stable model-visible evidence text.
 */
export function renderKnowledgeResult(result: KnowledgeToolResult): string {
  const dense = result.strategy.denseIndex === undefined ? '' : `, ${result.strategy.denseIndex}`
  const strategy = `Strategy: ${result.strategy.retrieval}${dense}, rerank ${result.strategy.rerank ? 'on' : 'off'}.`
  if (result.evidence.length === 0) return `${strategy}\nNo relevant evidence found.`
  return `${strategy}\n\n${result.evidence.map(renderEvidence).join('\n\n')}\n\nCite relevant evidence using its K<n> identifier.`
}

function evidenceFromHit(hit: KnowledgeHit, citation: string, hitMaxChars: number): { evidence?: KnowledgeEvidence; truncated: boolean } {
  const fixed: KnowledgeEvidence = {
    citation,
    documentId: hit.documentId,
    chunkId: hit.chunkId,
    ...(hit.title === undefined ? {} : { title: hit.title }),
    ...(hit.sectionPath === undefined ? {} : { sectionPath: hit.sectionPath }),
    ...(hit.source === undefined ? {} : { source: hit.source }),
    text: '',
  }
  const fixedLength = codePoints(renderEvidence(fixed)).length
  if (fixedLength >= hitMaxChars) return { truncated: true }
  const clipped = clip(hit.text, hitMaxChars - fixedLength)
  let evidence: KnowledgeEvidence = { ...fixed, text: clipped.text }
  let truncated = clipped.truncated
  for (const [field, value] of [
    ['previousText', hit.previousText],
    ['nextText', hit.nextText],
  ] as const) {
    if (value === undefined) continue
    const withEmpty = { ...evidence, [field]: '' }
    const available = hitMaxChars - codePoints(renderEvidence(withEmpty)).length
    if (available <= 0) {
      truncated = true
      continue
    }
    const context = clip(value, available)
    evidence = { ...evidence, [field]: context.text }
    truncated ||= context.truncated
  }
  return { evidence, truncated }
}

/**
 * Project ranked provider hits into a completely bounded tool result.
 * @param hits - provider-ranked retrieval hits.
 * @param hitMaxChars - maximum rendered Unicode code points per evidence item.
 * @param outputMaxChars - maximum rendered Unicode code points for the complete result.
 * @param strategy - resolved retrieval strategy reported with the evidence.
 * @returns evidence that fits both limits plus a truncation indicator.
 */
export function collectKnowledgeResult(
  hits: readonly KnowledgeHit[],
  hitMaxChars: number,
  outputMaxChars: number,
  strategy: ResolvedKnowledgeSearchStrategy,
): KnowledgeToolResult {
  const evidence: KnowledgeEvidence[] = []
  let truncated = false
  for (const hit of hits) {
    const projected = evidenceFromHit(hit, `K${evidence.length + 1}`, hitMaxChars)
    if (projected.evidence === undefined) {
      truncated = true
      continue
    }
    const candidate = {
      evidence: [...evidence, projected.evidence],
      truncated: truncated || projected.truncated,
      strategy,
    }
    if (codePoints(renderKnowledgeResult(candidate)).length > outputMaxChars) {
      truncated = true
      break
    }
    evidence.push(projected.evidence)
    truncated ||= projected.truncated
  }
  if (evidence.length < hits.length) truncated = true
  return { evidence, truncated, strategy }
}
