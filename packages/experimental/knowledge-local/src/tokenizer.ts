/** BGE tokenizer loading kept separate from ONNX model loading. */

import type { PreTrainedTokenizer } from '@huggingface/transformers'

/** Fixed tokenizer repository used by the first English experiment. */
export const BGE_SMALL_EN_MODEL_ID = 'onnx-community/bge-small-en-v1.5-ONNX'
/** Fixed tokenizer revision used by the first English experiment. */
export const BGE_SMALL_EN_REVISION = '4a9a46c7b88fa408e650a571a1800243f26309bd'
/** Fixed multilingual tokenizer and embedding repository. */
export const BGE_M3_MODEL_ID = 'onnx-community/bge-m3-ONNX'
/** Fixed immutable multilingual model revision. */
export const BGE_M3_REVISION = '25b9af8e87a38eb120cfe87125383677b9cd309e'

/** Minimal tokenizer capability required by the deterministic chunker. */
export interface ChunkTokenizer {
  /** Count model tokens without adding special tokens. */
  countTokens(text: string): number
}

/** Options for loading the BGE tokenizer from an explicit cache. */
export interface BgeTokenizerOptions {
  readonly cacheDir: string
  readonly localFilesOnly: boolean
  readonly modelId?: string
  readonly revision?: string
}

class HuggingFaceChunkTokenizer implements ChunkTokenizer {
  constructor(private readonly tokenizer: PreTrainedTokenizer) {}

  countTokens(text: string): number {
    return this.tokenizer.encode(text, { add_special_tokens: false }).length
  }
}

/**
 * Load the fixed-revision tokenizer without loading ONNX weights.
 * @param options - cache, network-access, model, and revision selection.
 * @returns a tokenizer exposing deterministic token counts.
 */
export async function loadBgeChunkTokenizer(options: BgeTokenizerOptions): Promise<ChunkTokenizer> {
  const { AutoTokenizer } = await import('@huggingface/transformers')
  const tokenizer = await AutoTokenizer.from_pretrained(options.modelId ?? BGE_M3_MODEL_ID, {
    cache_dir: options.cacheDir,
    local_files_only: options.localFilesOnly,
    revision: options.revision ?? BGE_M3_REVISION,
  })
  return new HuggingFaceChunkTokenizer(tokenizer)
}
