/** Fixed BGE embedding runtime for local Dense retrieval. */

import type { PreTrainedTokenizer } from '@huggingface/transformers'
import { DENSE_DIMENSIONS, validateDenseVectors } from './dense.ts'
import { BGE_SMALL_EN_MODEL_ID, BGE_SMALL_EN_REVISION } from './tokenizer.ts'

/** Query instruction required by `bge-small-en-v1.5`. */
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '
/** Fixed quantized ONNX data type used by the first Dense experiment. */
export const BGE_DENSE_DTYPE = 'q8'
/** Default BGE input limit, including special tokens. */
export const DEFAULT_DENSE_MAX_TOKENS = 512

/** Tensor fields consumed from a feature-extraction result. */
export interface DenseTensorOutput {
  readonly type: string
  readonly dims: readonly number[]
  readonly data: unknown
}

/** Fixed feature-extraction behavior requested by `DenseEncoder`. */
export interface DenseFeatureExtractionOptions {
  readonly pooling: 'cls'
  readonly normalize: true
  readonly truncation: true
  readonly maxLength: number
}

/** Injectable feature extractor used by the encoder and its keyless tests. */
export interface DenseFeatureExtractor {
  /**
   * Run one embedding batch.
   * @param texts - complete inputs before right-side truncation.
   * @param options - fixed pooling, normalization, and token limits.
   * @returns one row-major float32 tensor.
   */
  extract(texts: readonly string[], options: DenseFeatureExtractionOptions): Promise<DenseTensorOutput>
  /** Release model resources after offline index construction. */
  dispose(): Promise<void>
}

/** Options for loading one fixed-revision BGE encoder. */
export interface DenseEncoderLoadOptions {
  readonly cacheDir: string
  readonly localFilesOnly: boolean
  readonly modelId?: string
  readonly revision?: string
  readonly dtype?: 'q8'
  readonly maxTokens?: number
}

/** Factory seam used to verify model loading without downloading weights. */
export type DenseFeatureExtractorFactory = (
  options: Required<DenseEncoderLoadOptions>,
) => Promise<DenseFeatureExtractor>

function resolvedOptions(options: DenseEncoderLoadOptions): Required<DenseEncoderLoadOptions> {
  const resolved = {
    cacheDir: options.cacheDir,
    localFilesOnly: options.localFilesOnly,
    modelId: options.modelId ?? BGE_SMALL_EN_MODEL_ID,
    revision: options.revision ?? BGE_SMALL_EN_REVISION,
    dtype: options.dtype ?? BGE_DENSE_DTYPE,
    maxTokens: options.maxTokens ?? DEFAULT_DENSE_MAX_TOKENS,
  } as const
  if (resolved.cacheDir.trim().length === 0) throw new TypeError('knowledge-local: dense cacheDir must be non-empty')
  if (resolved.modelId.trim().length === 0) throw new TypeError('knowledge-local: dense modelId must be non-empty')
  if (!/^[a-f0-9]{40}$/u.test(resolved.revision)) {
    throw new TypeError('knowledge-local: dense revision must be a full lowercase commit SHA')
  }
  if (!Number.isSafeInteger(resolved.maxTokens) || resolved.maxTokens < 1 || resolved.maxTokens > 512) {
    throw new TypeError('knowledge-local: dense maxTokens must be an integer from 1 through 512')
  }
  return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tensorData(output: DenseTensorOutput, rows: number): Float32Array {
  if (output.type !== 'float32') throw new TypeError('knowledge-local: Dense model output must be float32')
  if (output.dims.length !== 2 || output.dims[0] !== rows || output.dims[1] !== DENSE_DIMENSIONS) {
    throw new TypeError(`knowledge-local: Dense model output must have dimensions [${rows}, ${DENSE_DIMENSIONS}]`)
  }
  if (!(output.data instanceof Float32Array)) {
    throw new TypeError('knowledge-local: Dense model output data must be Float32Array')
  }
  const vectors = new Float32Array(output.data)
  validateDenseVectors(vectors, rows, DENSE_DIMENSIONS, 'knowledge-local: Dense model output')
  return vectors
}

async function loadTransformersFeatureExtractor(
  options: Required<DenseEncoderLoadOptions>,
): Promise<DenseFeatureExtractor> {
  const { pipeline } = await import('@huggingface/transformers')
  const extractor = await pipeline('feature-extraction', options.modelId, {
    cache_dir: options.cacheDir,
    local_files_only: options.localFilesOnly,
    revision: options.revision,
    dtype: options.dtype,
  })
  const tokenizer = extractor.tokenizer
  extractor.tokenizer = ((texts: string | string[], tokenizerOptions?: Record<string, unknown>) => tokenizer(texts, {
    ...(isRecord(tokenizerOptions) ? tokenizerOptions : {}),
    truncation: true,
    max_length: options.maxTokens,
  })) as unknown as PreTrainedTokenizer
  return {
    async extract(texts, extractionOptions) {
      const output = await extractor([...texts], {
        pooling: extractionOptions.pooling,
        normalize: extractionOptions.normalize,
      })
      return { type: output.type, dims: output.dims, data: output.data }
    },
    dispose: () => extractor.dispose(),
  }
}

/** BGE encoder that fixes query prompting and validates model output. */
export class DenseEncoder {
  constructor(
    private readonly extractor: DenseFeatureExtractor,
    private readonly maxTokens: number,
  ) {}

  /**
   * Embed complete document strings, preserving their beginning during truncation.
   * @param texts - document strings with any title already prepended.
   * @returns row-major normalized embeddings.
   */
  async embedDocuments(texts: readonly string[]): Promise<Float32Array> {
    if (texts.length === 0) return new Float32Array()
    const output = await this.extractor.extract(texts, {
      pooling: 'cls',
      normalize: true,
      truncation: true,
      maxLength: this.maxTokens,
    })
    return tensorData(output, texts.length)
  }

  /**
   * Embed one query after adding the complete BGE retrieval instruction.
   * @param query - natural-language query without an instruction prefix.
   * @returns one normalized query embedding.
   */
  async embedQuery(query: string): Promise<Float32Array> {
    const vectors = await this.embedDocuments([`${BGE_QUERY_PREFIX}${query}`])
    return vectors.slice(0, DENSE_DIMENSIONS)
  }

  /** Release the underlying model resources. */
  dispose(): Promise<void> {
    return this.extractor.dispose()
  }
}

/**
 * Load a fixed-revision BGE encoder from an explicit cache.
 * @param options - model identity, cache, network policy, and token limit.
 * @param factory - feature-extractor factory, replaceable by keyless tests.
 * @returns validated Dense encoder.
 */
export async function loadDenseEncoder(
  options: DenseEncoderLoadOptions,
  factory: DenseFeatureExtractorFactory = loadTransformersFeatureExtractor,
): Promise<DenseEncoder> {
  const resolved = resolvedOptions(options)
  return new DenseEncoder(await factory(resolved), resolved.maxTokens)
}
