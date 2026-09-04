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
    expect(JSON.stringify(result.content)).not.toContain('score')
  })
})
