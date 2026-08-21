/**
 * 基于 `ctx.lsp`、面向模型的 `lsp` Tool。一个只读 Tool 提供四种操作：
 * `goToDefinition`、`findReferences`、`goToImplementation` 和 `hover`。它把从 1 开始的
 * UTF-16 光标坐标转换为 seam 使用的从 0 开始的位置；必须使用 Session workspace，
 * 不提供回退；对结果执行限量和渲染；并附加可配置的超时预算，交由
 * `dsh-tool-call-timeout-policy` 强制执行。运行时只注入 `tools`、`lsp` 和
 * `systemPrompt`，不导入任何 Provider。
 *
 * 这是 namespace 插件：使用具名导出，不提供 default export。
 * @module @deepseek-ai/dsh-tool-lsp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { LspError } from '@deepseek-ai/dsh-lsp'
import type {} from '@deepseek-ai/dsh-lsp'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatHover,
  formatLocations,
  LSP_OPERATIONS,
  parseLspArgs,
  presentLspCall,
} from './render.ts'
import { sessionCwd } from './session-cwd.ts'

export {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatHover,
  formatLocations,
  LSP_OPERATIONS,
  parseLspArgs,
  presentLspCall,
  renderUri,
} from './render.ts'
export { sessionCwd } from './session-cwd.ts'

/** Loader 诊断使用的 Cordis 插件名。 */
export const name = 'tool-lsp'

/** 本插件需要的服务。 */
export const inject = ['tools', 'lsp', 'systemPrompt']

/** 默认 Tool 调用超时预算（毫秒），覆盖排队后的 open/query/close 生命周期。 */
export const DEFAULT_LSP_TOOL_TIMEOUT_MS = 60_000

// 该英文段落会在注册 `lsp` 工具时加入系统提示词，指导模型何时选用精确导航，
// 并定义坐标和引用结果的语义。它与工具 schema 一起影响模型选路和快照输出；
// 为保持跨模型的一致术语与现有行为，运行时原文不翻译，中文解释由 README 提供。
// 中文译文：普通导航使用 search/read。当文本匹配存在歧义，或修改前需要精确查找定义、
// 实现或引用时，使用 lsp。位置使用从 1 开始的行号和光标处 UTF-16 字符序号；光标不在
// 符号上时可能没有结果。findReferences 始终包含声明本身。
/** 将 LSP 定位为精确辅助工具的稳定 system prompt 指引。 */
export const LSP_PROMPT_TEXT =
  'Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration.'

// 中文说明：插件配置包括结果上限和超时预算。下方公共 JSDoc 保持英文，因为配置目录生成器
// 会将其逐字抽取到英文参考页；中文配置参考页通过文档配对维护。
/** Plugin configuration: result caps and the timeout budget. */
export interface Config {
  /** Largest number of rendered locations before an omission marker (default 100). */
  maxLocations?: number
  /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
  maxResultChars?: number
  /** Tool-call timeout budget in ms (default 60000). */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxLocations: z.number().default(DEFAULT_MAX_LOCATIONS),
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_LSP_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

const LSP_POSITION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true },
    character: { type: 'integer', required: true },
  },
} as const

const LSP_RANGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
    end: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
  },
} as const

/**
 * 注册 `lsp` Tool 及其 system prompt 指引。
 * @param ctx - 插件上下文，必须注入 `tools`、`lsp` 和 `systemPrompt`。
 * @param config - 解析后的插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxLocations', resolved.maxLocations)
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)
  assertTimer('timeoutMs', resolved.timeoutMs)

  ctx.systemPrompt.section({ name: 'tool:lsp', order: 112, text: LSP_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'lsp',
    description:
      'Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, goToImplementation, hover. line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration.',
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: [...LSP_OPERATIONS],
        description: 'goToDefinition, findReferences, goToImplementation, or hover.',
      },
      file_path: { type: 'string', required: true, description: 'The source file to query, relative to the workspace or absolute.' },
      line: { type: 'number', required: true, description: 'One-based line of the cursor.' },
      character: { type: 'number', required: true, description: 'One-based UTF-16 column of the cursor.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'locations' },
              locations: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uri: { type: 'string', required: true },
                    range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
                  },
                },
              },
              resolvedWorkspaceUri: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'hover' },
              hover: {
                required: true,
                oneOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      contents: { type: 'string', required: true },
                      range: LSP_RANGE_OUTPUT_SCHEMA,
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      render: (_args, value) => {
        switch (value.kind) {
          case 'locations':
            return [{ type: 'text', text: formatLocations(value.locations, value.resolvedWorkspaceUri, resolved.maxLocations, resolved.maxResultChars) }]
          case 'hover':
            return [{ type: 'text', text: formatHover(value.hover, resolved.maxResultChars) }]
          /* v8 ignore next -- 已穷尽输出 schema 的封闭联合，不可达 */
          default:
            return assertNever(value, 'tool-lsp output')
        }
      },
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const input = parseLspArgs(args)
      const workspaceRoot = sessionCwd(exec)
      if (workspaceRoot === undefined) {
        throw new LspError('the lsp tool requires a session workspace cwd', 'LSP_WORKSPACE_REQUIRED')
      }
      const result = await ctx.lsp.query({
        operation: input.operation,
        filePath: input.filePath,
        position: input.position,
        workspaceRoot,
      }, exec.signal)
      switch (result.kind) {
        case 'locations':
          return {
            kind: 'locations' as const,
            locations: result.locations.map(location => ({
              uri: location.uri,
              range: {
                start: { line: location.range.start.line, character: location.range.start.character },
                end: { line: location.range.end.line, character: location.range.end.character },
              },
            })),
            resolvedWorkspaceUri: result.resolvedWorkspaceUri,
          }
        case 'hover':
          return {
            kind: 'hover' as const,
            hover: result.hover === null
              ? null
              : {
                contents: result.hover.contents,
                ...result.hover.range === undefined
                  ? {}
                  : {
                    range: {
                      start: { line: result.hover.range.start.line, character: result.hover.range.start.character },
                      end: { line: result.hover.range.end.line, character: result.hover.range.end.character },
                    },
                  },
              },
          }
        /* v8 ignore next -- 已穷尽封闭的 LspQueryResult 联合，不可达 */
        default:
          return assertNever(result, 'tool-lsp result')
      }
    },
    presentCall: presentLspCall,
  }))
}

/** 加载时拒绝非正整数配置，使错误配置立即显式失败。 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-lsp: ${name} must be a positive integer`)
  }
}

/** 拒绝会被 Node 截断、无法按配置调度的 timer 值。 */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-lsp: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
