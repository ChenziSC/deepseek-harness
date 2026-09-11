import { describe, expect, it, vi } from 'vitest'
import { createOpenAiContextualPrefixGenerator } from '../src/offline/contextual-prefix/contextual-prefix-openai.ts'
import type { ContextualPrefixRequest } from '../src/offline/contextual-prefix/contextual-prefix.ts'

const request: ContextualPrefixRequest = {
  schemaVersion: 1,
  promptVersion: 'v1',
  document: { id: 'doc', title: 'Guide' },
  sectionPath: 'Section',
  context: [{ id: 'doc:0-3', text: 'It needs context.' }],
  targets: [{ id: 'doc:0-3', text: 'It needs context.' }],
  maxPrefixTokens: 20,
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('OpenAI contextual prefix generator', () => {
  it('counts the frozen prompt and sends a strict Responses API request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      output_text: '{"prefixes":[{"chunkId":"doc:0-3","context":"The guide subject."}]}',
      usage: { input_tokens: 30, output_tokens: 8 },
    }))
    const generator = createOpenAiContextualPrefixGenerator({
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
      modelId: 'model',
      revision: 'revision',
      reasoningEffort: 'low',
      tokenizer: { countTokens: text => text.length },
      request: fetch,
    })

    await expect(generator.countTokens(request)).resolves.toBeGreaterThan(100)
    const generation = await generator.generate(request)
    expect(generation.output).toContain('The guide subject.')
    expect(generation).toMatchObject({
      inputTokens: 30,
      outputTokens: 8,
    })
    expect(generator.parameters).toEqual({
      api: 'responses',
      outputReserveTokens: 128,
      reasoningEffort: 'low',
      responseFormat: 'json_schema',
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://example.test/v1/responses')
    expect(init?.headers).toEqual({ authorization: 'Bearer secret', 'content-type': 'application/json' })
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'model', max_output_tokens: 148, reasoning: { effort: 'low' } })
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('accepts nested output parts and requires complete usage', async () => {
    const generator = createOpenAiContextualPrefixGenerator({
      apiKey: 'key',
      baseUrl: 'https://example.test',
      modelId: 'model',
      revision: 'revision',
      reasoningEffort: 'none',
      tokenizer: { countTokens: () => 1 },
      request: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
        output: [null, { ignored: true }, { content: [null, { type: 'ignored', text: 'x' }, { type: 'output_text', text: '{}' }] }],
        usage: { input_tokens: 1, output_tokens: 0 },
      })),
    })
    await expect(generator.generate(request)).resolves.toMatchObject({ output: '{}', inputTokens: 1, outputTokens: 0 })
  })

  it.each([
    [null, 'response must be an object'],
    [{ usage: { input_tokens: 1, output_tokens: 0 } }, 'output must be text'],
    [{ output: [], usage: { input_tokens: 1, output_tokens: 0 } }, 'output must be text'],
    [{ output_text: '{}', usage: null }, 'must contain usage'],
    [{ output_text: '{}', usage: { input_tokens: 0, output_tokens: 0 } }, 'input token count'],
    [{ output_text: '{}', usage: { input_tokens: 1, output_tokens: -1 } }, 'output token count'],
  ] as const)('rejects malformed successful response %#', async (body, message) => {
    const generator = createOpenAiContextualPrefixGenerator({
      apiKey: 'key',
      baseUrl: 'https://example.test',
      modelId: 'model',
      revision: 'revision',
      reasoningEffort: 'minimal',
      tokenizer: { countTokens: () => 1 },
      request: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body)),
    })
    await expect(generator.generate(request)).rejects.toThrow(message)
  })

  it('preserves metered HTTP failures without exposing the response body', async () => {
    const generator = createOpenAiContextualPrefixGenerator({
      apiKey: 'key',
      baseUrl: 'https://example.test',
      modelId: 'model',
      revision: 'revision',
      reasoningEffort: 'high',
      tokenizer: { countTokens: () => 1 },
      request: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
        error: 'sensitive detail',
        usage: { input_tokens: 7, output_tokens: 2 },
      }, 429)),
    })
    await expect(generator.generate(request)).rejects.toMatchObject({
      message: 'contextual prefix request failed with HTTP 429',
      inputTokens: 7,
      outputTokens: 2,
    })
  })

  it('uses the ambient fetch only when no request implementation is injected', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      output_text: '{}',
      usage: { input_tokens: 1, output_tokens: 0 },
    }))
    vi.stubGlobal('fetch', fetch)
    try {
      const generator = createOpenAiContextualPrefixGenerator({
        apiKey: 'key',
        baseUrl: 'https://example.test',
        modelId: 'model',
        revision: 'revision',
        reasoningEffort: 'low',
        tokenizer: { countTokens: () => 1 },
      })
      await generator.generate(request)
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects invalid JSON and unmetered HTTP failures', async () => {
    const invalid = (status: number) => new Response('{', { status })
    const make = (status: number) => createOpenAiContextualPrefixGenerator({
      apiKey: 'key',
      baseUrl: 'https://example.test',
      modelId: 'model',
      revision: 'revision',
      reasoningEffort: 'medium',
      tokenizer: { countTokens: () => 1 },
      request: vi.fn<typeof globalThis.fetch>().mockResolvedValue(invalid(status)),
    })
    await expect(make(200).generate(request)).rejects.toThrow('not valid JSON')
    await expect(make(500).generate(request)).rejects.toMatchObject({ inputTokens: 0, outputTokens: 0 })
    const unmetered = createOpenAiContextualPrefixGenerator({
      apiKey: 'key',
      baseUrl: 'https://example.test',
      modelId: 'model',
      revision: 'revision',
      reasoningEffort: 'medium',
      tokenizer: { countTokens: () => 1 },
      request: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: 'offline' }, 503)),
    })
    await expect(unmetered.generate(request)).rejects.toMatchObject({ inputTokens: 0, outputTokens: 0 })
  })

  it.each([
    [{ apiKey: '', baseUrl: 'https://example.test', modelId: 'model', revision: 'revision' }, 'API key'],
    [{ apiKey: 'key', baseUrl: '', modelId: 'model', revision: 'revision' }, 'baseUrl'],
    [{ apiKey: 'key', baseUrl: 'https://example.test', modelId: '', revision: 'revision' }, 'modelId'],
    [{ apiKey: 'key', baseUrl: 'https://example.test', modelId: 'model', revision: '' }, 'revision'],
  ] as const)('rejects incomplete identity %#', (partial, message) => {
    expect(() => createOpenAiContextualPrefixGenerator({
      ...partial,
      reasoningEffort: 'low',
      tokenizer: { countTokens: () => 1 },
    })).toThrow(message)
  })
})
