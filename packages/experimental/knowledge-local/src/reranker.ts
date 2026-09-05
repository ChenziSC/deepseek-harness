/** Fixed BGE cross-encoder reranking for local retrieval candidates. */

import { KnowledgeError, type KnowledgeHit } from '@deepseek-ai/dsh-experimental-knowledge'

/** Fixed reranker repository used by the first evaluation matrix. */
export const BGE_RERANKER_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX'
/** Fixed reranker revision used by the first evaluation matrix. */
export const BGE_RERANKER_REVISION = '6f5ff65298512715a1e669753bc754d2bc8f367b'
/** Fixed quantized ONNX data type used by the first reranker experiment. */
export const BGE_RERANKER_DTYPE = 'q8'
/** Default number of text pairs submitted in one reranker inference. */
export const DEFAULT_RERANKER_BATCH_SIZE = 8
/** Default reranker input limit, including special tokens. */
export const DEFAULT_RERANKER_MAX_TOKENS = 512

/** One retrieval candidate accepted and returned by the reranker. */
export interface RerankMatch {
  readonly ordinal: number
  readonly score: number
}

/** Tensor fields consumed from one sequence-classification result. */
export interface RerankerTensorOutput {
  readonly type: string
  readonly dims: readonly number[]
  readonly data: unknown
}

/** Tokenization behavior fixed for every reranker batch. */
export interface RerankerInferenceOptions {
  readonly padding: true
  readonly truncation: true
  readonly truncationStrategy: 'longest_first'
  readonly truncationSide: 'right'
  readonly maxLength: number
}

/** Injectable sequence-classification backend used by the runtime and keyless tests. */
export interface RerankerBackend {
  /**
   * Score aligned query and document arrays.
   * @param queries - repeated queries aligned with documents.
   * @param documents - candidate title-and-text inputs.
   * @param options - fixed padding and truncation behavior.
   * @returns one raw logit for each input pair.
   */
  scorePairs(
    queries: readonly string[],
    documents: readonly string[],
    options: RerankerInferenceOptions,
  ): Promise<RerankerTensorOutput>
  /** Release model resources after use. */
  dispose(): Promise<void>
}

/** Options for loading one fixed-revision BGE reranker. */
export interface RerankerLoadOptions {
  readonly cacheDir: string
  readonly localFilesOnly: boolean
  readonly modelId?: string
  readonly revision?: string
  readonly dtype?: 'q8'
  readonly maxTokens?: number
}

/** Factory seam used to verify model loading without downloading weights. */
export type RerankerBackendFactory = (
  options: Required<RerankerLoadOptions>,
) => Promise<RerankerBackend>

function resolvedOptions(options: RerankerLoadOptions): Required<RerankerLoadOptions> {
  const resolved = {
    cacheDir: options.cacheDir,
    localFilesOnly: options.localFilesOnly,
    modelId: options.modelId ?? BGE_RERANKER_MODEL_ID,
    revision: options.revision ?? BGE_RERANKER_REVISION,
    dtype: options.dtype ?? BGE_RERANKER_DTYPE,
    maxTokens: options.maxTokens ?? DEFAULT_RERANKER_MAX_TOKENS,
  } as const
  if (resolved.cacheDir.trim().length === 0) throw new TypeError('knowledge-local: reranker cacheDir must be non-empty')
  if (resolved.modelId.trim().length === 0) throw new TypeError('knowledge-local: reranker modelId must be non-empty')
  if (!/^[a-f0-9]{40}$/u.test(resolved.revision)) {
    throw new TypeError('knowledge-local: reranker revision must be a full lowercase commit SHA')
  }
  if (!Number.isSafeInteger(resolved.maxTokens) || resolved.maxTokens < 1 || resolved.maxTokens > 512) {
    throw new TypeError('knowledge-local: reranker maxTokens must be an integer from 1 through 512')
  }
  return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function logits(output: RerankerTensorOutput, rows: number): Float32Array {
  if (output.type !== 'float32') throw new TypeError('knowledge-local: reranker output must be float32')
  if (
    !(
      (output.dims.length === 1 && output.dims[0] === rows)
      || (output.dims.length === 2 && output.dims[0] === rows && output.dims[1] === 1)
    )
    || !(output.data instanceof Float32Array)
    || output.data.length !== rows
  ) {
    throw new TypeError(`knowledge-local: reranker output must contain ${rows} logits`)
  }
  const values = new Float32Array(output.data)
  if (values.some(value => !Number.isFinite(value))) {
    throw new TypeError('knowledge-local: reranker output contains a non-finite logit')
  }
  return values
}

function candidateText(chunk: KnowledgeHit): string {
  return chunk.title === undefined ? chunk.text : `${chunk.title}\n${chunk.text}`
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new KnowledgeError('Knowledge search was cancelled.', 'KNOWLEDGE_CANCELLED')
  }
}

async function loadTransformersRerankerBackend(
  options: Required<RerankerLoadOptions>,
): Promise<RerankerBackend> {
  const { AutoModelForSequenceClassification, AutoTokenizer } = await import('@huggingface/transformers')
  const common = {
    cache_dir: options.cacheDir,
    local_files_only: options.localFilesOnly,
    revision: options.revision,
  }
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(options.modelId, common),
    AutoModelForSequenceClassification.from_pretrained(options.modelId, {
      ...common,
      dtype: options.dtype,
    }),
  ])
  tokenizer.padding_side = 'right'
  return {
    async scorePairs(queries, documents, inferenceOptions) {
      const inputs = tokenizer([...queries], {
        text_pair: [...documents],
        padding: inferenceOptions.padding,
        truncation: inferenceOptions.truncation,
        max_length: inferenceOptions.maxLength,
      })
      const output: unknown = await model(inputs)
      if (!isRecord(output) || !isRecord(output['logits'])) {
        throw new TypeError('knowledge-local: reranker model did not return logits')
      }
      const modelLogits = output['logits']
      return {
        type: typeof modelLogits['type'] === 'string' ? modelLogits['type'] : '',
        dims: Array.isArray(modelLogits['dims']) ? modelLogits['dims'] : [],
        data: modelLogits['data'],
      }
    },
    async dispose() {
      await model.dispose()
    },
  }
}

/** BGE cross-encoder that validates batches and preserves recall order on ties. */
export class Reranker {
  constructor(
    private readonly backend: RerankerBackend,
    private readonly maxTokens: number,
  ) {}

  /**
   * Rerank candidates by raw sequence-classification logit.
   * @param query - natural-language query.
   * @param candidates - recall candidates in stable input order.
   * @param chunks - ordinal-aligned indexed chunks or a candidate-only ordinal map.
   * @param batchSize - positive number of pairs per inference.
   * @param signal - optional cooperative cancellation signal.
   * @returns candidates ordered by descending logit and original rank.
   */
  async rerank(
    query: string,
    candidates: readonly RerankMatch[],
    chunks: readonly KnowledgeHit[] | ReadonlyMap<number, KnowledgeHit>,
    batchSize: number,
    signal?: AbortSignal,
  ): Promise<RerankMatch[]> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new TypeError('knowledge-local: reranker batchSize must be a positive safe integer')
    }
    const scored: Array<RerankMatch & { sourceRank: number }> = []
    for (let start = 0; start < candidates.length; start += batchSize) {
      throwIfCancelled(signal)
      const batch = candidates.slice(start, start + batchSize)
      const documents = batch.map((candidate) => {
        const chunk = Array.isArray(chunks)
          ? (chunks as readonly KnowledgeHit[])[candidate.ordinal]
          : (chunks as ReadonlyMap<number, KnowledgeHit>).get(candidate.ordinal)
        if (chunk === undefined) throw new TypeError('knowledge-local: reranker candidate ordinal is out of range')
        return candidateText(chunk)
      })
      const output = await this.backend.scorePairs(new Array(batch.length).fill(query), documents, {
        padding: true,
        truncation: true,
        truncationStrategy: 'longest_first',
        truncationSide: 'right',
        maxLength: this.maxTokens,
      })
      const batchLogits = logits(output, batch.length)
      for (const [index, candidate] of batch.entries()) {
        scored.push({
          ordinal: candidate.ordinal,
          score: batchLogits[index] as number,
          sourceRank: start + index,
        })
      }
      throwIfCancelled(signal)
    }
    return scored
      .sort((left, right) => right.score - left.score || left.sourceRank - right.sourceRank)
      .map(({ ordinal, score }) => ({ ordinal, score }))
  }

  /** Release the underlying model resources. */
  dispose(): Promise<void> {
    return this.backend.dispose()
  }
}

/**
 * Load a fixed-revision BGE reranker from an explicit cache.
 * @param options - model identity, cache, network policy, and token limit.
 * @param factory - backend factory, replaceable by keyless tests.
 * @returns validated cross-encoder reranker.
 */
export async function loadReranker(
  options: RerankerLoadOptions,
  factory: RerankerBackendFactory = loadTransformersRerankerBackend,
): Promise<Reranker> {
  const resolved = resolvedOptions(options)
  return new Reranker(await factory(resolved), resolved.maxTokens)
}
