import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalKnowledge } from '@deepseek-ai/dsh-experimental-knowledge-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '@deepseek-ai/dsh-experimental-tool-knowledge'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('BM25 knowledge tool chain', () => {
  it('loads the micro index and returns numbered evidence', async () => {
    context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(LocalKnowledge, {
      indexDir: join(process.cwd(), 'examples/rag-knowledge/index'),
      defaultRetrieval: 'bm25',
      allowedRetrieval: ['bm25'],
      allowedRerank: false,
      candidateCount: 5,
    })
    await context.plugin({ inject: [...inject], apply }, { maxResults: 2 })

    const result = await context.tools.execute({
      callId: CallId('knowledge-1'),
      name: 'knowledge_search',
      arguments: { query: 'What converts light energy in plants?' },
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(result.content).toHaveLength(1)
    const content = result.content[0]
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') throw new TypeError('expected text tool content')
    expect(content.text).toContain('[K1]\nDocument: photosynthesis')
    expect(content.text).toContain('Strategy: bm25, rerank off.')
    expect(JSON.stringify(result.content)).not.toContain('score')

    const tool = context.tools.get('knowledge_search')
    expect(tool?.presentCall?.({ query: 'photosynthesis' })).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Search knowledge',
      rawInput: 'photosynthesis',
    })
    expect(tool?.presentResult?.({ query: 'photosynthesis' }, result)).toEqual({
      card: 'generic',
      title: 'Knowledge search complete',
    })
    expect(tool?.presentResult?.({ query: 'photosynthesis' }, { ...result, isError: true })).toEqual({
      card: 'generic',
      title: 'Knowledge search failed',
    })
  })

  it('forwards high-level strategy fields without exposing tuning parameters', async () => {
    context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(LocalKnowledge, {
      indexDir: join(process.cwd(), 'examples/rag-knowledge/index'),
      defaultRetrieval: 'bm25',
      allowedRetrieval: ['bm25'],
      allowedRerank: false,
      candidateCount: 5,
    })
    await context.plugin({ inject: [...inject], apply }, { maxResults: 2 })

    const tool = context.tools.get('knowledge_search')
    expect(tool?.parameters).toMatchObject({
      properties: {
        query: { type: 'string' },
        retrieval: { enum: ['bm25', 'dense', 'hybrid'] },
        denseIndex: { enum: ['auto', 'exact', 'hnsw'] },
        rerank: { enum: ['auto', 'on', 'off'] },
      },
    })
    expect(JSON.stringify(tool?.parameters)).not.toMatch(/candidate|rrf|connectivity|expansion/i)
    const result = await context.tools.execute({
      callId: CallId('knowledge-strategy'),
      name: 'knowledge_search',
      arguments: { query: 'plants', retrieval: 'bm25', denseIndex: 'auto', rerank: 'off' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Strategy: bm25, rerank off.')
  })

  it('validates tool configuration and query bounds', async () => {
    context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(LocalKnowledge, {
      indexDir: join(process.cwd(), 'examples/rag-knowledge/index'),
      defaultRetrieval: 'bm25',
      allowedRetrieval: ['bm25'],
      allowedRerank: false,
      candidateCount: 5,
    })

    await context.plugin({ inject: [...inject], apply }, { enabled: false })
    expect(context.tools.get('knowledge_search')).toBeUndefined()

    for (const config of [
      { maxResults: 0 },
      { queryMaxChars: 0 },
      { hitMaxChars: 0 },
      { outputMaxChars: 0 },
      { timeoutMs: 2_147_483_648 },
    ]) {
      await expect(context.plugin({ inject: [...inject], apply }, config)).rejects.toThrow('tool-knowledge:')
    }
    await expect(context.plugin({ inject: [...inject], apply }, { outputMaxChars: 1 }))
      .rejects.toThrow('outputMaxChars must be at least')

    await context.plugin({ inject: [...inject], apply }, { queryMaxChars: 3 })
    const empty = await context.tools.execute({
      callId: CallId('knowledge-empty'),
      name: 'knowledge_search',
      arguments: { query: '   ' },
      signal: new AbortController().signal,
    })
    expect(empty).toMatchObject({ isError: true })
    expect(JSON.stringify(empty)).toContain('query must be non-empty')

    const long = await context.tools.execute({
      callId: CallId('knowledge-long'),
      name: 'knowledge_search',
      arguments: { query: 'four' },
      signal: new AbortController().signal,
    })
    expect(long).toMatchObject({ isError: true })
    expect(JSON.stringify(long)).toContain('query must not exceed 3 characters')
  })
})
