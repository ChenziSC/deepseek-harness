import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Knowledge, {
  KnowledgeChunkId,
  KnowledgeDocumentId,
  type KnowledgeSearchResult,
} from '@deepseek-ai/dsh-experimental-knowledge'
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
        retrieval: { enum: ['auto', 'bm25', 'dense', 'hybrid'] },
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
      { maxSearchesPerTurn: 3 },
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

  it('limits model-driven searches to two per open turn and resets on the next turn', async () => {
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
    await context.plugin({ inject: [...inject], apply }, { maxResults: 1 })

    const events: Array<{ type: string; data: unknown }> = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: {} },
    ]
    const agent = { session: { events } } as never
    const execute = (id: string, query: string) => context?.tools.execute({
      callId: CallId(id),
      name: 'knowledge_search',
      arguments: { query },
      agent,
      signal: new AbortController().signal,
    })

    const first = await execute('knowledge-turn-1-a', 'light energy in plants')
    expect(first?.isError).toBe(false)
    const firstContent = first?.content[0]
    expect(firstContent?.type).toBe('text')
    if (firstContent?.type !== 'text') throw new TypeError('expected text tool content')
    expect(firstContent.text).toContain('Document: photosynthesis')
    expect(firstContent.text).toContain('[K1]')

    const second = await execute('knowledge-turn-1-b', 'energy needed to power a cell')
    expect(second?.isError).toBe(false)
    const secondContent = second?.content[0]
    expect(secondContent?.type).toBe('text')
    if (secondContent?.type !== 'text') throw new TypeError('expected text tool content')
    expect(secondContent.text).toContain('Document: mitochondria')
    expect(secondContent.text).toContain('[K2]')
    await expect(execute('knowledge-turn-1-c', 'third evidence')).resolves.toMatchObject({ isError: true })
    const limited = await execute('knowledge-turn-1-c', 'third evidence')
    const limitedContent = limited?.content[0]
    expect(limitedContent?.type).toBe('text')
    if (limitedContent?.type !== 'text') throw new TypeError('expected text tool content')
    expect(limitedContent.text).toContain('limited to 2 searches')

    events.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } })
    const nextTurn = await execute('knowledge-turn-2-a', 'photosynthesis')
    expect(nextTurn?.isError).toBe(false)
    const nextTurnContent = nextTurn?.content[0]
    expect(nextTurnContent?.type).toBe('text')
    if (nextTurnContent?.type !== 'text') throw new TypeError('expected text tool content')
    expect(nextTurnContent.text).toContain('[K1]')

    const endedAgent = { session: { events: [{ type: 'turn/end', data: { turn: 2 } }] } } as never
    const ended = await context.tools.execute({
      callId: CallId('knowledge-ended-turn'),
      name: 'knowledge_search',
      arguments: { query: 'photosynthesis' },
      agent: endedAgent,
      signal: new AbortController().signal,
    })
    expect(ended.isError).toBe(true)
    const endedContent = ended.content[0]
    expect(endedContent?.type).toBe('text')
    if (endedContent?.type !== 'text') throw new TypeError('expected text tool content')
    expect(endedContent.text).toContain('require an open turn')

    const unstartedAgent = { session: { events: [] } } as never
    const unstarted = await context.tools.execute({
      callId: CallId('knowledge-unstarted-turn'),
      name: 'knowledge_search',
      arguments: { query: 'photosynthesis' },
      agent: unstartedAgent,
      signal: new AbortController().signal,
    })
    expect(unstarted.isError).toBe(true)
    const unstartedContent = unstarted.content[0]
    expect(unstartedContent?.type).toBe('text')
    if (unstartedContent?.type !== 'text') throw new TypeError('expected text tool content')
    expect(unstartedContent.text).toContain('require an open turn')
  })

  it('reserves concurrent slots before provider completion and counts provider failures', async () => {
    const completions: Array<() => void> = []
    let failuresRemaining = 0
    class ControlledKnowledge extends Knowledge {
      search(): Promise<KnowledgeSearchResult> {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1
          return Promise.reject(new Error('fixture provider failure'))
        }
        return new Promise((resolve) => {
          completions.push(() => {
            resolve({
              hits: [{
                documentId: KnowledgeDocumentId('controlled'),
                chunkId: KnowledgeChunkId('controlled:0-1'),
                text: 'controlled evidence',
                score: 1,
              }],
              strategy: { retrieval: 'bm25', rerank: false },
            })
          })
        })
      }
    }

    context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(ControlledKnowledge)
    await context.plugin({ inject: [...inject], apply }, {})
    const events: Array<{ type: string; data: unknown }> = [{ type: 'turn/start', data: { turn: 1 } }]
    const agent = { session: { events } } as never
    const execute = (id: string) => context?.tools.execute({
      callId: CallId(id),
      name: 'knowledge_search',
      arguments: { query: 'evidence' },
      agent,
      signal: new AbortController().signal,
    })

    const first = execute('knowledge-concurrent-a')
    const second = execute('knowledge-concurrent-b')
    await Promise.resolve()
    const concurrentLimited = await execute('knowledge-concurrent-c')
    expect(concurrentLimited?.isError).toBe(true)
    const concurrentLimitedContent = concurrentLimited?.content[0]
    expect(concurrentLimitedContent?.type).toBe('text')
    if (concurrentLimitedContent?.type !== 'text') throw new TypeError('expected text tool content')
    expect(concurrentLimitedContent.text).toContain('limited to 2 searches')
    for (const complete of completions) complete()
    const completed = await Promise.all([first, second])
    expect(completed.map(result => result?.isError)).toEqual([false, false])
    const citations = completed.map((result) => {
      const content = result?.content[0]
      if (content?.type !== 'text') throw new TypeError('expected text tool content')
      return content.text.match(/\[K\d+\]/)?.[0]
    })
    expect(citations).toEqual(['[K1]', '[K6]'])

    events.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } })
    failuresRemaining = 2
    await expect(execute('knowledge-failure-a')).resolves.toMatchObject({ isError: true })
    await expect(execute('knowledge-failure-b')).resolves.toMatchObject({ isError: true })
    const failureLimited = await execute('knowledge-failure-c')
    expect(failureLimited?.isError).toBe(true)
    const failureLimitedContent = failureLimited?.content[0]
    expect(failureLimitedContent?.type).toBe('text')
    if (failureLimitedContent?.type !== 'text') throw new TypeError('expected text tool content')
    expect(failureLimitedContent.text).toContain('limited to 2 searches')

    events.push({ type: 'turn/end', data: { turn: 2 } }, { type: 'turn/start', data: { turn: 3 } })
    failuresRemaining = 1
    await expect(execute('knowledge-reserved-failure-a')).resolves.toMatchObject({ isError: true })
    const afterFailure = execute('knowledge-reserved-failure-b')
    await Promise.resolve()
    expect(completions).toHaveLength(3)
    completions[2]!()
    const afterFailureResult = await afterFailure
    const afterFailureContent = afterFailureResult?.content[0]
    expect(afterFailureContent?.type).toBe('text')
    if (afterFailureContent?.type !== 'text') throw new TypeError('expected text tool content')
    expect(afterFailureContent.text).toContain('[K6]')
  })
})
