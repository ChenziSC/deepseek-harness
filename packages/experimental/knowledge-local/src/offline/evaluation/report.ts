/** Markdown projection for machine-readable retrieval evaluation reports. */

import type { EvaluationReport } from './types.ts'

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function tableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\s+/gu, ' ')
}

/**
 * Project one evaluation report into a concise Markdown table.
 * @param report - authoritative machine-readable report.
 * @returns Markdown derived without recomputing any metric.
 */
export function renderEvaluationReport(report: EvaluationReport): string {
  const lines = [
    `# ${report.dataset} RAG Evaluation`,
    '',
    `Created: ${report.createdAt}`,
    '',
    '| Mode | Dense index | Rerank request | Applied | Status | Recall@1 | Recall@5 | Recall@10 | Recall@20 | Recall@100 | MRR@10 | nDCG@10 | Success@1 | Success@5 | Success@10 | Success@20 | Success@100 | ANN recall@10 | ANN recall@100 | p50 ms | p95 ms |',
    '| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const run of report.runs) {
    if (run.status === 'failed' || run.metrics === undefined || run.latencyMs === undefined) {
      lines.push(`| ${run.mode} | ${run.denseIndex ?? '—'} | ${run.rerank} | — | failed: ${tableCell(run.error ?? 'unknown error')} | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |`)
      continue
    }
    lines.push(`| ${run.mode} | ${run.denseIndex ?? '—'} | ${run.rerank} | ${percentage(run.rerankAppliedRate ?? 0)} | success | ${percentage(run.metrics.recallAt1)} | ${percentage(run.metrics.recallAt5)} | ${percentage(run.metrics.recallAt10)} | ${percentage(run.metrics.recallAt20)} | ${percentage(run.metrics.recallAt100)} | ${percentage(run.metrics.mrrAt10)} | ${percentage(run.metrics.ndcgAt10)} | ${percentage(run.metrics.successAt1)} | ${percentage(run.metrics.successAt5)} | ${percentage(run.metrics.successAt10)} | ${percentage(run.metrics.successAt20)} | ${percentage(run.metrics.successAt100)} | ${run.approximation === undefined ? '—' : percentage(run.approximation.recallAt10)} | ${run.approximation === undefined ? '—' : percentage(run.approximation.recallAt100)} | ${run.latencyMs.p50.toFixed(2)} | ${run.latencyMs.p95.toFixed(2)} |`)
  }
  lines.push('', `Index bytes: ${report.build.indexBytes}`)
  for (const [path, bytes] of Object.entries(report.build.payloadBytes)) lines.push(`- ${path}: ${bytes}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}
