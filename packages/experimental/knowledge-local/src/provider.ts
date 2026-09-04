/** BM25-, Dense-, and Hybrid-backed local implementation of the experimental knowledge service. */

import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Knowledge, {
  KnowledgeError,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResult,
} from '@deepseek-ai/dsh-experimental-knowledge'
import { searchBm25 } from './bm25.ts'
import { resolveConfig, type LocalKnowledgeConfig, type ResolvedConfig } from './config.ts'
import { searchDense } from './dense.ts'
import { searchHybrid } from './hybrid.ts'
import { loadKnowledgeIndex, type LoadedKnowledgeIndex } from './index-format.ts'
import { DenseEncoder, loadDenseEncoder } from './model-runtime.ts'
import { loadReranker, Reranker, type RerankMatch } from './reranker.ts'

function cancelled(): KnowledgeError {
  return new KnowledgeError('Knowledge search was cancelled.', 'KNOWLEDGE_CANCELLED')
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelled()
}

/** Local immutable BM25, Dense, and Hybrid knowledge provider implementation. */
export class LocalKnowledgeProvider extends Knowledge {
  /** Resolved provider configuration. */
  readonly config: ResolvedConfig

  private index: LoadedKnowledgeIndex | undefined
  private denseEncoder: DenseEncoder | undefined
  private denseEncoderPromise: Promise<DenseEncoder> | undefined
  private reranker: Reranker | undefined
  private rerankerPromise: Promise<Reranker> | undefined
  private closed = false

  constructor(ctx: Context, config: LocalKnowledgeConfig) {
    super(ctx)
    const resolvedConfig = resolveConfig(config)
    this.config = {
      ...resolvedConfig,
      indexDir: resolve(resolvedConfig.indexDir),
      ...(resolvedConfig.modelCacheDir === undefined
        ? {}
        : { modelCacheDir: resolve(resolvedConfig.modelCacheDir) }),
    }
    ctx.effect(() => async () => {
      this.closed = true
      this.index = undefined
      const denseEncoder = this.denseEncoder
      const reranker = this.reranker
      this.denseEncoder = undefined
      this.denseEncoderPromise = undefined
      this.reranker = undefined
      this.rerankerPromise = undefined
      await Promise.allSettled([
        denseEncoder?.dispose(),
        reranker?.dispose(),
      ])
    }, 'knowledgeLocal.close')
  }

  /** Load and validate the complete immutable index before publishing readiness. */
  protected async [Service.init](): Promise<void> {
    const index = await loadKnowledgeIndex(this.config.indexDir)
    if (index.manifest.bm25.k1 !== this.config.bm25K1 || index.manifest.bm25.b !== this.config.bm25B) {
      throw new KnowledgeError('Knowledge index BM25 configuration does not match the provider configuration.', 'KNOWLEDGE_SEARCH_FAILED')
    }
    if (this.config.mode !== 'bm25') {
      const manifest = index.manifest.dense
      if (manifest === undefined || index.dense === undefined) {
        throw new KnowledgeError('Knowledge index does not contain Dense embeddings.', 'KNOWLEDGE_SEARCH_FAILED')
      }
      if (
        manifest.modelId !== this.config.denseModelId
        || manifest.revision !== this.config.denseModelRevision
      ) {
        throw new KnowledgeError('Knowledge index Dense model does not match the provider configuration.', 'KNOWLEDGE_SEARCH_FAILED')
      }
    }
    this.index = index
  }

  /**
   * Create the configured Dense encoder. Subclasses may replace this in keyless tests.
   * @returns an encoder loaded only from the configured local cache.
   */
  protected createDenseEncoder(): Promise<DenseEncoder> {
    const cacheDir = this.config.modelCacheDir
    if (cacheDir === undefined) {
      throw new KnowledgeError('Dense retrieval requires a model cache directory.', 'KNOWLEDGE_SEARCH_FAILED')
    }
    return loadDenseEncoder({
      cacheDir,
      localFilesOnly: true,
      modelId: this.config.denseModelId,
      revision: this.config.denseModelRevision,
      dtype: this.config.denseDtype,
      maxTokens: this.config.denseMaxTokens,
    })
  }

  private async getDenseEncoder(): Promise<DenseEncoder> {
    if (this.denseEncoder !== undefined) return this.denseEncoder
    if (this.denseEncoderPromise !== undefined) return this.denseEncoderPromise
    const loading = this.createDenseEncoder().then(async (encoder) => {
      if (this.closed) {
        await encoder.dispose()
        throw new KnowledgeError('Knowledge provider is closed.', 'KNOWLEDGE_SEARCH_FAILED')
      }
      this.denseEncoder = encoder
      return encoder
    })
    this.denseEncoderPromise = loading
    try {
      return await loading
    } finally {
      if (this.denseEncoderPromise === loading) this.denseEncoderPromise = undefined
    }
  }

  /**
   * Create the configured reranker. Subclasses may replace this in keyless tests.
   * @returns a reranker loaded only from the configured local cache.
   */
  protected createReranker(): Promise<Reranker> {
    const cacheDir = this.config.modelCacheDir
    if (cacheDir === undefined) {
      throw new KnowledgeError('Reranking requires a model cache directory.', 'KNOWLEDGE_SEARCH_FAILED')
    }
    return loadReranker({
      cacheDir,
      localFilesOnly: true,
      modelId: this.config.rerankerModelId,
      revision: this.config.rerankerModelRevision,
      dtype: this.config.rerankerDtype,
      maxTokens: this.config.rerankerMaxTokens,
    })
  }

  private async getReranker(): Promise<Reranker> {
    if (this.reranker !== undefined) return this.reranker
    if (this.rerankerPromise !== undefined) return this.rerankerPromise
    const loading = this.createReranker().then(async (reranker) => {
      if (this.closed) {
        await reranker.dispose()
        throw new KnowledgeError('Knowledge provider is closed.', 'KNOWLEDGE_SEARCH_FAILED')
      }
      this.reranker = reranker
      return reranker
    })
    this.rerankerPromise = loading
    try {
      return await loading
    } finally {
      if (this.rerankerPromise === loading) this.rerankerPromise = undefined
    }
  }

  async search(request: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    if (this.closed) throw new KnowledgeError('Knowledge provider is closed.', 'KNOWLEDGE_SEARCH_FAILED')
    throwIfCancelled(signal)
    const query = request.query.trim()
    if (query.length === 0 || !Number.isSafeInteger(request.maxResults) || request.maxResults < 1) {
      throw new KnowledgeError('Knowledge search requires a non-empty query and positive result limit.', 'KNOWLEDGE_INVALID_REQUEST')
    }
    if (request.maxResults > this.config.candidateCount) {
      throw new KnowledgeError('Knowledge search result limit exceeds the configured candidate count.', 'KNOWLEDGE_INVALID_REQUEST')
    }
    const index = this.index
    if (index === undefined) throw new KnowledgeError('Knowledge index is not ready.', 'KNOWLEDGE_SEARCH_FAILED')
    try {
      const chunkIds = index.chunks.map(chunk => chunk.chunkId)
      const searchBm25Candidates = () => searchBm25(
        index.bm25,
        query,
        chunkIds,
        this.config.candidateCount,
        this.config.bm25K1,
        this.config.bm25B,
      )
      const matches = this.config.mode === 'bm25'
        ? searchBm25Candidates()
        : this.config.mode === 'dense'
          ? await this.searchDense(index, query, signal)
          : await searchHybrid(
            searchBm25Candidates,
            () => this.searchDense(index, query, signal),
            chunkIds,
            this.config.rrfK,
            this.config.candidateCount,
          )
      const finalMatches = this.config.rerank
        ? await this.rerank(query, matches, index, signal)
        : matches
      const hits = finalMatches.slice(0, request.maxResults).map(({ ordinal, score }) => {
        const chunk = index.chunks[ordinal]
        if (chunk === undefined) throw new KnowledgeError('Knowledge index returned an invalid chunk.', 'KNOWLEDGE_SEARCH_FAILED')
        return { ...chunk, score }
      })
      return { hits }
    } catch (error) {
      if (error instanceof KnowledgeError) throw error
      throw new KnowledgeError('Knowledge search failed.', 'KNOWLEDGE_SEARCH_FAILED', { cause: error })
    }
  }

  private async rerank(
    query: string,
    matches: readonly RerankMatch[],
    index: LoadedKnowledgeIndex,
    signal: AbortSignal | undefined,
  ): Promise<RerankMatch[]> {
    if (matches.length === 0) return []
    throwIfCancelled(signal)
    const reranker = await this.getReranker()
    throwIfCancelled(signal)
    return reranker.rerank(query, matches, index.chunks, this.config.rerankerBatchSize, signal)
  }

  private async searchDense(
    index: LoadedKnowledgeIndex,
    query: string,
    signal: AbortSignal | undefined,
  ): Promise<Array<{ ordinal: number; score: number }>> {
    const dense = index.dense
    if (dense === undefined) throw new KnowledgeError('Knowledge index does not contain Dense embeddings.', 'KNOWLEDGE_SEARCH_FAILED')
    throwIfCancelled(signal)
    const encoder = await this.getDenseEncoder()
    throwIfCancelled(signal)
    const queryVector = await encoder.embedQuery(query)
    throwIfCancelled(signal)
    return searchDense(
      dense.vectors,
      queryVector,
      index.chunks.map(chunk => chunk.chunkId),
      dense.dimensions,
      this.config.candidateCount,
      signal,
    )
  }
}

export default LocalKnowledgeProvider
