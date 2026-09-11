/** OpenAI-compatible Responses API adapter for offline contextual-prefix generation. */

import { performance } from 'node:perf_hooks'
import {
  ContextualPrefixGenerationError,
  type ContextualPrefixGeneration,
  type ContextualPrefixGenerator,
} from './contextual-prefix-generation.ts'
import {
  CONTEXTUAL_PREFIX_OUTPUT_RESERVE_TOKENS,
  contextualPrefixRequestOutputTokens,
  renderContextualPrefixRequest,
  type ContextualPrefixRequest,
} from './contextual-prefix.ts'
import type { ChunkTokenizer } from '../../tokenizer.ts'

/** Explicit remote settings for one fixed-revision prefix generator. */
export interface OpenAiContextualPrefixGeneratorOptions {
  readonly apiKey: string
  readonly baseUrl: string
  readonly modelId: string
  readonly revision: string
  readonly reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  readonly tokenizer: Pick<ChunkTokenizer, 'countTokens'>
  readonly request?: typeof fetch
}

interface ParsedUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

function required(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`knowledge-local: contextual prefix ${name} must be non-empty`)
  return value
}

function usage(value: unknown): ParsedUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('knowledge-local: contextual prefix response must contain usage')
  }
  const inputTokens = (value as Record<string, unknown>)['input_tokens']
  const outputTokens = (value as Record<string, unknown>)['output_tokens']
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 1) {
    throw new TypeError('knowledge-local: contextual prefix response input token count is invalid')
  }
  if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) {
    throw new TypeError('knowledge-local: contextual prefix response output token count is invalid')
  }
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number }
}

function outputText(value: Record<string, unknown>): string {
  if (typeof value['output_text'] === 'string') return value['output_text']
  if (!Array.isArray(value['output'])) {
    throw new TypeError('knowledge-local: contextual prefix response output must be text')
  }
  const parts: string[] = []
  for (const item of value['output']) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const content = (item as Record<string, unknown>)['content']
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
      const record = part as Record<string, unknown>
      if (record['type'] === 'output_text' && typeof record['text'] === 'string') parts.push(record['text'])
    }
  }
  if (parts.length === 0) throw new TypeError('knowledge-local: contextual prefix response output must be text')
  return parts.join('')
}

function parsedResponse(value: unknown): Omit<ContextualPrefixGeneration, 'latencyMs'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('knowledge-local: contextual prefix response must be an object')
  }
  const response = value as Record<string, unknown>
  return { output: outputText(response), ...usage(response['usage']) }
}

function responseSchema(request: ContextualPrefixRequest): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      prefixes: {
        type: 'array',
        minItems: request.targets.length,
        maxItems: request.targets.length,
        items: {
          type: 'object',
          properties: {
            chunkId: { type: 'string', enum: request.targets.map(target => target.id) },
            context: { type: 'string' },
          },
          required: ['chunkId', 'context'],
          additionalProperties: false,
        },
      },
    },
    required: ['prefixes'],
    additionalProperties: false,
  }
}

/**
 * Create a fixed-revision Responses API generator without reading credentials from ambient state.
 * @param options - explicit credential, endpoint, model identity, tokenizer, and request implementation.
 * @returns generator suitable for the budgeted offline executor.
 */
export function createOpenAiContextualPrefixGenerator(
  options: OpenAiContextualPrefixGeneratorOptions,
): ContextualPrefixGenerator {
  const apiKey = required(options.apiKey, 'API key')
  const baseUrl = required(options.baseUrl, 'baseUrl')
  const modelId = required(options.modelId, 'modelId')
  const revision = required(options.revision, 'revision')
  const request = options.request ?? fetch
  const endpoint = new URL('responses', `${baseUrl.replace(/\/+$/u, '')}/`).toString()
  return {
    modelId,
    revision,
    parameters: {
      api: 'responses',
      outputReserveTokens: CONTEXTUAL_PREFIX_OUTPUT_RESERVE_TOKENS,
      reasoningEffort: options.reasoningEffort,
      responseFormat: 'json_schema',
    },
    countTokens(value) {
      return Promise.resolve(options.tokenizer.countTokens(renderContextualPrefixRequest(value)))
    },
    async generate(value) {
      const startedAt = performance.now()
      const response = await request(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          input: [{ role: 'user', content: [{ type: 'input_text', text: renderContextualPrefixRequest(value) }] }],
          reasoning: { effort: options.reasoningEffort },
          max_output_tokens: contextualPrefixRequestOutputTokens(value),
          text: {
            format: {
              type: 'json_schema',
              name: 'contextual_prefixes',
              strict: true,
              schema: responseSchema(value),
            },
          },
        }),
      })
      const latencyMs = performance.now() - startedAt
      let decoded: unknown
      try {
        decoded = await response.json() as unknown
      } catch (error) {
        if (!response.ok) {
          throw new ContextualPrefixGenerationError(
            `contextual prefix request failed with HTTP ${response.status}`,
            0,
            0,
            latencyMs,
            { cause: error },
          )
        }
        throw new TypeError('knowledge-local: contextual prefix response is not valid JSON', { cause: error })
      }
      if (!response.ok) {
        let measured: ParsedUsage = { inputTokens: 0, outputTokens: 0 }
        if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded) && 'usage' in decoded) {
          measured = usage((decoded as Record<string, unknown>)['usage'])
        }
        throw new ContextualPrefixGenerationError(
          `contextual prefix request failed with HTTP ${response.status}`,
          measured.inputTokens,
          measured.outputTokens,
          latencyMs,
        )
      }
      return { ...parsedResponse(decoded), latencyMs }
    },
  }
}
