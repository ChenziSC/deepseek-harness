/**
 * 模型可见的 `web_search` Tool：在 Web 上发现当前信息。执行经由 `ctx.web`；本模块只负责
 * 模型可见 schema、参数校验、结果数量限制和结果格式化，不负责选择 Provider 或访问网络。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue, ToolResult, WebSearchResultView, WebSource } from '@deepseek-ai/dsh-tools'
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * 返回来源数量的默认上限（`searchMaxResults` 配置）。该限制归 Consumer 所有，而非
 * Provider 或模型，方式与 `dsh-tool-fs` 的 `READ_LIMIT` 相同。模型只负责提出问题，
 * 产品控制返回多少上下文。默认值 `8` 与 OpenCode 的 Exa 默认值一致。
 */
export const WEB_SEARCH_MAX_RESULTS = 8

/** 单次 Tool 调用中并发搜索数量的默认上限。 */
export const WEB_SEARCH_MAX_QUERIES = 4

/** 模型可见的 `web_search` 参数。 */
interface WebSearchArgs {
  queries: string[]
}

/**
 * 校验 schema DSL 无法表达的值约束：`queries` 非空、只包含非空白字符串，且不超过部署
 * 的查询数量上限。完成上限检查后合并完全相同的字符串，否则抛出普通 `Error`。
 *
 * @param args - 经 schema 校验的 `web_search` 参数。
 * @param maxQueries - 部署规定的单次调用查询数量上限。
 * @returns 按首次出现顺序排列的已接受查询。
 */
export function parseSearchArgs(
  args: WebSearchArgs,
  maxQueries: number,
): string[] {
  const queries = args.queries
  if (queries.length === 0) throw new Error('queries must contain at least one query')
  if (queries.length > maxQueries) {
    const noun = maxQueries === 1 ? 'query' : 'queries'
    throw new Error(`queries must contain at most ${maxQueries} ${noun}`)
  }
  if (queries.some(query => query.trim().length === 0)) throw new Error('each query must be a non-empty string')
  return [...new Set(queries)]
}

/** Display label for a source: its title, else its hostname. */
function sourceLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title.length > 0) return title
  try {
    return new URL(url).hostname
  } catch {
    // A provider should return a valid URL, but never let a malformed one throw
    // out of pure formatting — fall back to the raw string.
    return url
  }
}

/**
 * Format a search result as one model-facing text block.
 *
 * @param result - the seam's search outcome.
 * @returns the provider answer (when any), a markdown source list with snippet
 *   and date metadata (or `No results found.`), a refine-the-query note when
 *   truncated, and a standing cite-your-sources instruction.
 */
export function formatSearchOutput(result: WebSearchResult): string {
  const parts: string[] = []
  if (result.content !== undefined && result.content.length > 0) parts.push(result.content)

  if (result.sources.length > 0) {
    const lines = result.sources.map((source) => {
      const label = sourceLabel(source.url, source.title)
      const meta: string[] = []
      if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`)
      const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : ''
      return `- [${label}](${source.url})${suffix}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else if (result.content === undefined || result.content.length === 0) {
    parts.push('No results found.')
  }

  if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

/**
 * 待定调用展示：以查询列表为标题的搜索卡片。
 *
 * @param args - 原始 Tool 参数；只有查询文本会进入视图。
 * @returns 调用执行期间展示的通用卡片视图（`kind: 'search'`）。
 */
export function presentSearchCall(args: WebSearchArgs): GenericCallView {
  const title = args.queries.join(', ')
  return { card: 'generic', title, kind: 'search', rawInput: title }
}

/**
 * The `web_search` tool's private `tool/result` `meta` payload: the structured
 * sources, the optional provider answer, and the truncation flag. Attached
 * opaquely (as `JsonValue`) on the tool result and persisted with the session
 * log, so `presentResult` reproduces the search card on replay. This projection
 * is the only faithful route to the per-source fields, which the lossy render
 * text cannot carry (the owning rationale is the web-result-card Agent Note).
 */
export interface WebSearchMeta {
  /** The faithful structured sources, in result order. */
  sources: WebSource[]
  /** seam 或多查询合并为了遵守结果上限而截断来源列表时为 true。 */
  truncated: boolean
  /** The provider-generated answer text, when any. */
  answer?: string
}

/**
 * Project one seam source into a plain object that omits every absent optional
 * field. Shared by the canonical `execute` result and its replayable
 * presentation meta so both carry byte-identical source shapes.
 *
 * @param source - one source from the `ctx.web` search outcome.
 * @returns `{ url }` plus each present optional field.
 */
function projectSource(source: WebSearchSource): {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
} {
  return {
    url: source.url,
    ...source.title !== undefined ? { title: source.title } : {},
    ...source.snippet !== undefined ? { snippet: source.snippet } : {},
    ...source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {},
  }
}

/**
 * Project a validated `web_search` output value into its replayable
 * presentation meta ({@link WebSearchMeta} as opaque JSON).
 *
 * @param value - the canonical `web_search` output value (the seam's result shape).
 * @returns the structured sources, the truncation flag, and the answer when present.
 */
export function searchMetaFromValue(value: WebSearchResult): JsonValue {
  return {
    sources: value.sources.map(projectSource),
    truncated: value.truncated,
    ...value.content !== undefined ? { answer: value.content } : {},
  }
}

/** Whether `value` is a valid {@link WebSource} (defensive narrowing from opaque `meta`). */
function isWebSource(value: unknown): value is WebSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { url, title, snippet, publishedAt } = value as Record<string, unknown>
  return typeof url === 'string'
    && (title === undefined || typeof title === 'string')
    && (snippet === undefined || typeof snippet === 'string')
    && (publishedAt === undefined || typeof publishedAt === 'string')
}

/**
 * Narrow opaque live or replayed result metadata to a {@link WebSearchMeta}.
 * Malformed metadata returns `undefined` so presentation can fall back to the
 * generic card instead of throwing during replay.
 *
 * @param meta - result metadata.
 * @returns the validated search meta, or `undefined` for absent or malformed data.
 */
export function searchMetaFromResult(meta: unknown): WebSearchMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { sources, truncated, answer } = meta as Record<string, unknown>
  if (!Array.isArray(sources) || !sources.every(isWebSource)) return undefined
  if (typeof truncated !== 'boolean') return undefined
  if (answer !== undefined && typeof answer !== 'string') return undefined
  return {
    sources,
    truncated,
    ...answer !== undefined ? { answer } : {},
  }
}

/**
 * Completed-call presentation: a `web` search card carrying the faithful
 * structured sources from `meta`. It sets no `content` copy — a UI without the
 * `web` capability falls back to the raw `tool/result` content, which is the
 * same text (see the web-result-card Agent Note).
 *
 * @param args - 原始 Tool 参数；查询会成为结果态标题，使窗口截断回放即使丢失调用头部
 *   仍有标题可用。
 * @param result - the final model-facing tool result; `meta` carries the sources.
 * @returns the search result view, or `undefined` (generic card) on failure or
 *   malformed meta.
 */
export function presentSearchResult(args: WebSearchArgs, result: ToolResult): WebSearchResultView | undefined {
  if (result.isError) return undefined
  const meta = searchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'web',
    kind: 'search',
    title: args.queries.join(', '),
    sources: meta.sources,
    truncated: meta.truncated,
    ...meta.answer !== undefined ? { answer: meta.answer } : {},
  }
}

/**
 * 通过 Web seam 执行一个或多个搜索。单个查询保留 Provider 的原始结果；多个查询并发
 * 执行，再合并为最多包含 `maxResults` 项的规范结果。任一搜索失败会中止同级搜索；本函数
 * 等待所有搜索结束后，再重新抛出首个失败。
 *
 * @param ctx - 由其 `web` 服务执行搜索的 context。
 * @param queries - 已校验的非空查询。
 * @param maxResults - 部署规定的合并结果来源上限。
 * @param signal - 转发给每个搜索的取消信号。
 * @returns 合并后的搜索结果。
 */
async function runSearchQueries(
  ctx: Context,
  queries: string[],
  maxResults: number,
  signal: AbortSignal,
): Promise<WebSearchResult> {
  if (queries.length === 1) {
    return ctx.web.search({ query: queries[0] as string, maxResults }, signal)
  }
  const controller = new AbortController()
  const batchSignal = AbortSignal.any([signal, controller.signal])
  let firstFailure: { error: unknown } | undefined
  const results: WebSearchResult[] = []
  const searches = queries.map(async (query, index) => {
    try {
      results[index] = await ctx.web.search({ query, maxResults }, batchSignal)
    } catch (error) {
      if (firstFailure === undefined) firstFailure = { error }
      controller.abort(error)
      throw error
    }
  })
  await Promise.allSettled(searches)
  if (firstFailure !== undefined) throw firstFailure.error
  return mergeSearchResults(queries, results, maxResults)
}

/** 把逐查询结果合并为一个去重、轮询选取且有数量上限的结果。 */
function mergeSearchResults(
  queries: string[],
  results: WebSearchResult[],
  maxResults: number,
): WebSearchResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  let sourceRanks = 0
  for (const result of results) {
    sourceRanks = Math.max(sourceRanks, result.sources.length)
  }
  let droppedSource = false
  merge: for (let rank = 0; rank < sourceRanks; rank++) {
    for (const result of results) {
      const source = result.sources[rank]
      if (source !== undefined && !seen.has(source.url)) {
        seen.add(source.url)
        if (sources.length === maxResults) {
          droppedSource = true
          break merge
        }
        sources.push(source)
      }
    }
  }
  const contents = results.flatMap((result, index) => {
    if (result.content === undefined || result.content.length === 0) return []
    return [`### ${queries[index]}\n\n${result.content}`]
  })
  return {
    ...contents.length > 0 ? { content: contents.join('\n\n') } : {},
    sources,
    truncated: results.some(result => result.truncated) || droppedSource,
  }
}

/**
 * Register the `web_search` tool and its system-prompt guidance.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param maxResults - the deployment's source cap, sent as every seam
 *   request's `maxResults`.
 * @param maxQueries - 调用 Provider 前执行的部署查询数量上限。
 * @param timeoutMs - the cooperative tool-call budget (ms) attached as the tool's
 *   `ToolDefinition.timeoutMs` for `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce.
 * @param fetchEnabled - whether the same composition exposes `web_fetch`, which
 *   controls whether search guidance may recommend that follow-up tool.
 */
export function applyWebSearchTool(
  ctx: Context,
  maxResults: number,
  maxQueries: number,
  timeoutMs: number,
  fetchEnabled: boolean,
): void {
  // 下方两段英文会按 web_fetch 是否可用选择其一，作为 web_search 的 system prompt 指引。
  // 中文译文：使用 web_search 获取当前网络信息；结果包含可选答案和来源 URL。若可用，
  // 需要某条结果全文时继续调用 web_fetch；使用信息时，以 Markdown 链接引用相关 URL。
  // 若 web_fetch 不可用，则应直接引用搜索结果 URL。运行时原文保持不变。
  ctx.systemPrompt.section({
    name: 'tool:web_search',
    order: 110,
    text: fetchEnabled
      ? `Use the web_search tool to discover current information on the web. The required queries array accepts 1–${maxQueries} non-empty search queries; use a one-item array for a single search. It returns an optional answer plus a list of source URLs. Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links.`
      : `Use the web_search tool to discover current information on the web. The required queries array accepts 1–${maxQueries} non-empty search queries; use a one-item array for a single search. It returns an optional answer plus a list of source URLs. Use the returned source snippets when available, and cite the relevant URLs as markdown links.`,
  })

  ctx.tools.register(defineTool({
    name: 'web_search',
    description: `Search the web for current information. Provide 1–${maxQueries} queries in the required queries array. Returns an optional summary answer and a list of source URLs.`,
    parameters: {
      queries: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: `Required search queries; accepts 1–${maxQueries} items and merges their results.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    timeoutMs,
    // Provider 读取不会修改父 Agent 状态。
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const queries = parseSearchArgs(args, maxQueries)
      const result = await runSearchQueries(ctx, queries, maxResults, exec.signal)
      return {
        ...result.content !== undefined ? { content: result.content } : {},
        sources: result.sources.map(projectSource),
        truncated: result.truncated,
      }
    },
    presentCall: presentSearchCall,
    presentResult: (args, result) => presentSearchResult(args, result),
  }))
}
