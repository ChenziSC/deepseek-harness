import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  encode: vi.fn((text: string) => Array.from(text)),
  fromPretrained: vi.fn(),
}))

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: mocks.fromPretrained,
  },
}))

import {
  BGE_M3_MODEL_ID,
  BGE_M3_REVISION,
  loadBgeChunkTokenizer,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

describe('BGE chunk tokenizer', () => {
  it('loads default identity and counts tokens without special tokens', async () => {
    mocks.fromPretrained.mockResolvedValue({ encode: mocks.encode })
    const tokenizer = await loadBgeChunkTokenizer({ cacheDir: '/cache', localFilesOnly: true })

    expect(tokenizer.countTokens('ab')).toBe(2)
    expect(mocks.encode).toHaveBeenCalledWith('ab', { add_special_tokens: false })
    expect(mocks.fromPretrained).toHaveBeenCalledWith(BGE_M3_MODEL_ID, {
      cache_dir: '/cache',
      local_files_only: true,
      revision: BGE_M3_REVISION,
    })
  })

  it('passes explicit model identity to Transformers.js', async () => {
    mocks.fromPretrained.mockResolvedValue({ encode: mocks.encode })
    await loadBgeChunkTokenizer({
      cacheDir: '/cache',
      localFilesOnly: false,
      modelId: 'model',
      revision: 'revision',
    })
    expect(mocks.fromPretrained).toHaveBeenLastCalledWith('model', {
      cache_dir: '/cache',
      local_files_only: false,
      revision: 'revision',
    })
  })
})
