// 已结算节点身份可防止流增量更新重渲染此行。它挂载在
// 'conversation.composer.dock'，因此会在活动会话滚动区中与编辑器粘在一起；
// 见 ConversationRoot data-conversation-scroll。

import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationSnapshot, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// 仅类型：把 sessionStats 键合并进 SessionProjectionMap，供 useProjection 使用。
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { ComposerBarProps } from '../contract/slots.ts'
import { formatTokensPerSecond } from './message-chrome.ts'
import { assistantStepReading } from './turn-metrics.ts'
import css from './StatsLine.module.css'

interface WindowStats {
  turns: number
  steps: number
  /** 请求墙上时间总和（step/start → assistant/message）；没有节点携带 timing 时为 0。 */
  llmMs: number
  /** 工具墙上时间总和（tool/call → tool/result）；窗口内没有配对时为 0。 */
  toolMs: number
  /** `ttftSteps` 上首 token 延迟总和；没有 step 记录时为 0。 */
  ttftMs: number
  /** 带有已记录 TTFT 的 step 数。 */
  ttftSteps: number
  /** 同时报告输出 token 的 step 上 decode 墙上时间总和。 */
  decodeMs: number
  /** 同一批带 decode 时间 step 的输出 token 总和。 */
  decodeTokens: number
}

/**
 * 把助手和 tool-result 节点折叠为窗口作用域展示总计；这是未提供 `sessionStats`
 * 投影的装配所用 fallback。
 *
 * 由于窗口会分页且 compaction 会重写它，每个展示数字都依赖持久化全日志投影，
 * token 计量依赖 `tokenUsage`。只有未提供投影值时，此折叠才回答“屏幕上有什么”。
 * 字段名有意与投影一致，使两者可以整体替换。
 * @param nodes - 快照节点。
 * @returns fallback 计数和墙上时间总和。
 */
export function deriveStats(nodes: ConversationSnapshot['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      ttftMs += reading.ttftMs
      ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      decodeMs += reading.decodeMs
      decodeTokens += reading.outputTokens
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

/**
 * 紧凑 token 数：517 / 12.2K / 517K / 1.2M；三位数以下保留一位小数。
 * @param n - token 数。
 * @returns 展示字符串。
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * 紧凑时长：一分钟内显示 45.2s，之后显示 2m42s。
 * @param ms - 毫秒时长。
 * @returns 展示字符串。
 */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** 把缓存读取比例舍入为整数百分比；正数恰好居中时向上舍入。 */
function roundedIntegerPercent(cacheReadTokens: number, denominator: number): number {
  const denominatorQuotient = Math.floor(denominator / 200)
  const denominatorRemainder = denominator % 200
  let lower = 0
  let upper = 100
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient
      + Math.ceil(factor * denominatorRemainder / 200)
    if (cacheReadTokens >= threshold) {
      lower = candidate
    } else {
      upper = candidate - 1
    }
  }
  return lower
}

/**
 * 整份持久日志中 prompt 侧输入的可展示缓存命中比例。
 * @param usage - 会话 token-usage 投影值。
 * @returns 整数舍入低于 100 时返回整数文本；否则返回仍能舍入到 100 以下的最小
 * 小数精度。完全命中返回 100，没有计费输入时返回 null。
 */
export function cacheHitPercent(usage: TokenUsageProjection): string | null {
  const denominator = billedInputTokens(usage)
  if (denominator === 0) return null
  const missedInputTokens = usage.uncachedInputTokens + usage.cacheWriteTokens
  if (missedInputTokens === 0) return '100'

  const integerPercent = roundedIntegerPercent(usage.cacheReadTokens, denominator)
  if (integerPercent < 100) return String(integerPercent)

  // 在首个可区分精度上，舍入结果是 100 减去末位小数的一到五个单位。只有下一次
  // 乘法仍不超过分母时才继续缩放，然后通过精确小因子比较派生最后一位。
  let decimalPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(denominator / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    decimalPlaces += 1
  }
  const denominatorOnes = denominator % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(decimalPlaces - 1)}${10 - roundedLoss}`
}

/**
 * 汇总三个互不重叠的 prompt 侧计费桶。
 * @param usage - 会话 token-usage 投影值。
 * @returns 已计费输入 token 数。
 */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
}

/**
 * Approximate context occupancy, using the TUI's integer rounding and upper
 * clamp. The numerator is `projectedTokens` — the provider sample carried
 * forward over the surface's movement since — so compaction shows immediately
 * instead of waiting for the next request to report usage; it falls back to the
 * bare sample only for a log whose projection predates that field. Numerator
 * and capacity remain independent last-wins projection fields, so this is a
 * reference figure rather than an exact measurement of one request (see the
 * token-meter README).
 * @param pressure - the session's context-pressure projection value.
 * @returns occupancy with its numerator and denominator, or null until both values are known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}

/** Props: the conversation-snapshot selector plus the projection read seat. */
export interface StatsLineProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useProjection: UseProjection
  /** The owning dock's locale seat. */
  t: ComposerBarProps['t']
}

export const StatsLine = memo(function StatsLine({ useSession, useProjection, t }: StatsLineProps) {
  const settledNodes = useSession(s => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  // Every figure rides the durable sessionStats projection, so paging and
  // compaction cannot change any of them; an assembly without the unit falls
  // back to the window-scoped fold wholesale (same field names), paid only
  // while no projection value is served.
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
  // Pipe-separated groups (figma stats strip); a group with no data drops out whole.
  const groups: string[] = []
  if (stats.steps > 0) {
    groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs) }))
    if (stats.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs) }))
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) {
      speeds.push(t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }))
    }
    if (stats.decodeMs > 0) {
      speeds.push(t('stats.tokensPerSecond', {
        throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
      }))
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  // Context occupancy deliberately lives on the composer's ContextMeter ring,
  // not here — one home per fact.
  // Billing rides the durable projection, so these survive paging and
  // compaction. Gated on actual token activity: a session whose steps all
  // settled without billing (e.g. every request failed) shows its counts
  // without a zero-token group.
  if (usage !== undefined
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(t('stats.cacheHit', { percent: cacheHit }))
    groups.push(t('stats.tokens', {
      input: formatTokens(billedInputTokens(usage)),
      output: formatTokens(usage.outputTokens),
    }))
  }
  const line = groups.join(' | ')
  // The row elides with ellipsis when overlong; a delayed hover tooltip carries
  // the full line, enabled only while content is actually clipped.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null) return
    const measure = () => { setTruncated(el.scrollWidth > el.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [line])
  if (groups.length === 0) return null
  return (
    <Tooltip label={line} side="top" delayMs={500} disabled={!truncated}>
      <div ref={rootRef} className={css.root}>
        {groups.map((group, i) => (
          <Fragment key={group}>
            {i > 0 && <><span className={css.sep} aria-hidden>|</span>{' '}</>}
            <span>{group}</span>
          </Fragment>
        ))}
      </div>
    </Tooltip>
  )
})
