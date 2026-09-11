/** BM25-, Dense-, and Hybrid-backed local implementation of the experimental knowledge service. */

import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Knowledge, {
  KnowledgeError,
  type KnowledgeHit,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResult,
} from '@deepseek-ai/dsh-experimental-knowledge'
import { resolveConfig, type LocalKnowledgeConfig, type ResolvedConfig } from './config.ts'
import { searchDense } from './dense.ts'
import { searchHybrid } from './hybrid.ts'
import { HnswIndex } from './hnsw.ts'
import { loadDenseVectors, loadKnowledgeIndex, type LoadedKnowledgeIndex } from './index-format.ts'
import { DenseEncoder, loadDenseEncoder } from './model-runtime.ts'
import { loadReranker, Reranker, type RerankMatch } from './reranker.ts'
import { resolveKnowledgeSearchStrategy } from './strategy.ts'
import { compareCodePoints } from './ordering.ts'
import { parseRfc3339Instant } from './rfc3339.ts'

function cancelled(): KnowledgeError {
  return new KnowledgeError('Knowledge search was cancelled.', 'KNOWLEDGE_CANCELLED')
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelled()
}

function shouldRerank(
  preference: 'auto' | 'on' | 'off',
  matches: readonly RerankMatch[],
  minimumGapRatio: number,
): boolean {
  if (matches.length === 0) return false
  if (preference === 'on') return true
  if (preference === 'off' || matches.length === 1) return false
  const first = matches[0]?.score as number
  const second = matches[1]?.score as number
  const scale = Math.max(Math.abs(first), Math.abs(second), Number.EPSILON)
  return (first - second) / scale < minimumGapRatio
}

function trimPreviousOverlap(previous: string, current: string): string | undefined {
  for (let length = Math.min(previous.length, current.length); length > 0; length -= 1) {
    if (previous.endsWith(current.slice(0, length))) {
      const trimmed = previous.slice(0, -length).trimEnd()
      return trimmed.length === 0 ? undefined : trimmed
    }
  }
  return previous
}

function trimNextOverlap(current: string, next: string): string | undefined {
  for (let length = Math.min(current.length, next.length); length > 0; length -= 1) {
    if (current.endsWith(next.slice(0, length))) {
      const trimmed = next.slice(length).trimStart()
      return trimmed.length === 0 ? undefined : trimmed
    }
  }
  return next
}

/** Local immutable BM25, Dense, and Hybrid knowledge provider implementation. */
export class LocalKnowledgeProvider extends Knowledge {
  /** Resolved provider configuration. */
  readonly config: ResolvedConfig

  private index: LoadedKnowledgeIndex | undefined
  private denseVectors: Float32Array | undefined
  private denseVectorsPromise: Promise<Float32Array> | undefined
  private denseEncoder: DenseEncoder | undefined
  private denseEncoderPromise: Promise<DenseEncoder> | undefined
  private hnsw: HnswIndex | undefined
  private hnswPromise: Promise<HnswIndex> | undefined
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
      const index = this.index
      this.index = undefined
      this.denseVectors = undefined
      this.denseVectorsPromise = undefined
      this.hnsw = undefined
      this.hnswPromise = undefined
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
      index?.sqlite.close()
    }, 'knowledgeLocal.close')
  }

  /** Load and validate the complete immutable index before publishing readiness. */
  protected async [Service.init](): Promise<void> {
    const index = await loadKnowledgeIndex(this.config.indexDir, {
      verifyPayloadHashes: this.config.verifyPayloadHashes,
    })
    try {
      const denseAllowed = this.config.allowedRetrieval.some(value => value !== 'bm25')
      if (denseAllowed) {
        const manifest = index.manifest.dense
        if (manifest === undefined || (index.dense === undefined && index.hnsw === undefined)) {
          throw new KnowledgeError('Knowledge index does not contain Dense embeddings.', 'KNOWLEDGE_SEARCH_FAILED')
        }
        if (
          manifest.modelId !== this.config.denseModelId
          || manifest.revision !== this.config.denseModelRevision
          || manifest.modelFile !== this.config.denseModelFile
          || manifest.dimensions !== this.config.denseDimensions
          || manifest.maxTokens !== this.config.denseMaxTokens
          || manifest.queryPrefix !== this.config.denseQueryPrefix
        ) {
          throw new KnowledgeError('Knowledge index Dense model does not match the provider configuration.', 'KNOWLEDGE_SEARCH_FAILED')
        }
      }
      this.index = index
    } catch (error) {
      index.sqlite.close()
      throw error
    }
  }

  private async getDenseVectors(index: LoadedKnowledgeIndex): Promise<Float32Array> {
    if (this.denseVectors !== undefined) return this.denseVectors
    if (this.denseVectorsPromise !== undefined) return this.denseVectorsPromise
    const loading = loadDenseVectors(index).then((vectors) => {
      /* v8 ignore next -- requires disposal to race the single local file read after search starts. */
      if (this.closed) throw new KnowledgeError('Knowledge provider is closed.', 'KNOWLEDGE_SEARCH_FAILED')
      this.denseVectors = vectors
      return vectors
    })
    this.denseVectorsPromise = loading
    try {
      return await loading
    } finally {
      /* v8 ignore next -- this field can only contain the one loading Promise installed above. */
      if (this.denseVectorsPromise === loading) this.denseVectorsPromise = undefined
    }
  }

  /**
   * Create the configured Dense encoder. Subclasses may replace this in keyless tests.
   * @returns an encoder loaded only from the configured local cache.
   */
  protected createDenseEncoder(): Promise<DenseEncoder> {
    const cacheDir = this.config.modelCacheDir
    /* v8 ignore next -- resolved configuration requires this path for every Dense-capable mode. */
    if (cacheDir === undefined) {
      throw new KnowledgeError('Dense retrieval requires a model cache directory.', 'KNOWLEDGE_SEARCH_FAILED')
    }
    return loadDenseEncoder({
      cacheDir,
      localFilesOnly: true,
      modelId: this.config.denseModelId,
      revision: this.config.denseModelRevision,
      dtype: this.config.denseDtype,
      modelFile: this.config.denseModelFile,
      dimensions: this.config.denseDimensions,
      queryPrefix: this.config.denseQueryPrefix,
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

  private async getHnsw(index: LoadedKnowledgeIndex): Promise<HnswIndex> {
    if (this.hnsw !== undefined) return this.hnsw
    if (this.hnswPromise !== undefined) return this.hnswPromise
    const path = index.hnsw?.path
    if (path === undefined) throw new KnowledgeError('Knowledge index does not contain an HNSW index.', 'KNOWLEDGE_SEARCH_FAILED')
    const loading = Promise.resolve().then(() => {
      const dimensions = index.manifest.dense?.dimensions
      /* v8 ignore next -- the validated index format requires Dense metadata whenever an HNSW payload exists. */
      if (dimensions === undefined) throw new KnowledgeError('Knowledge index does not contain Dense metadata.', 'KNOWLEDGE_SEARCH_FAILED')
      const hnsw = new HnswIndex(path, dimensions, this.config.hnswExpansionSearch)
      if (this.closed) throw new KnowledgeError('Knowledge provider is closed.', 'KNOWLEDGE_SEARCH_FAILED')
      this.hnsw = hnsw
      return hnsw
    })
    this.hnswPromise = loading
    try {
      return await loading
    } finally {
      /* v8 ignore next -- this field can only contain the one loading Promise installed above. */
      if (this.hnswPromise === loading) this.hnswPromise = undefined
    }
  }

  /**
   * Create the configured reranker. Subclasses may replace this in keyless tests.
   * @returns a reranker loaded only from the configured local cache.
   */
  protected createReranker(): Promise<Reranker> {
    const cacheDir = this.config.modelCacheDir
    /* v8 ignore next -- resolved configuration requires this path whenever reranking is enabled. */
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
    let asOfMs: number
    try {
      asOfMs = request.asOf === undefined
        ? Date.now()
        : parseRfc3339Instant(request.asOf, 'Knowledge search asOf').epochMs
    } catch (error) {
      throw new KnowledgeError((error as Error).message, 'KNOWLEDGE_INVALID_REQUEST', { cause: error })
    }
    const index = this.index
    /* v8 ignore next -- Cordis publishes the service only after Service.init completes. */
    if (index === undefined) throw new KnowledgeError('Knowledge index is not ready.', 'KNOWLEDGE_SEARCH_FAILED')
    try {
      const plan = resolveKnowledgeSearchStrategy(query, request.strategy, this.config, {
        autoDenseIndex: index.manifest.dense?.autoDenseIndex ?? 'exact',
        availableDenseIndexes: [
          ...(index.dense === undefined ? [] : ['exact' as const]),
          ...(index.hnsw === undefined ? [] : ['hnsw' as const]),
        ],
      })
      const eligibility = index.sqlite.eligibleOrdinals(asOfMs, index.manifest.corpus.chunkCount)
      const searchBm25Candidates = () => index.sqlite.searchBm25(query, this.config.candidateCount, asOfMs)
      const matches = plan.retrieval === 'bm25'
        ? searchBm25Candidates()
        : plan.retrieval === 'dense'
          ? await this.searchDense(index, query, plan.denseIndex as 'exact' | 'hnsw', eligibility, signal)
          : await searchHybrid(
            searchBm25Candidates,
            () => this.searchDense(index, query, plan.denseIndex as 'exact' | 'hnsw', eligibility, signal),
            undefined,
            this.config.rrfK,
            this.config.candidateCount,
          )
      if (matches.some(match => eligibility.mask[match.ordinal] !== 1)) {
        throw new TypeError('knowledge-local: retrieval returned an ineligible document')
      }
      const rerank = shouldRerank(plan.rerank, matches, this.config.adaptiveRerankMinScoreGapRatio)
      const finalMatches = rerank
        ? await this.rerank(query, matches, index, signal)
        : matches
      const selected = finalMatches.slice(0, request.maxResults)
      if (selected.some(match => eligibility.mask[match.ordinal] !== 1)) {
        throw new TypeError('knowledge-local: retrieval returned an ineligible document')
      }
      const chunks = index.sqlite.chunks(selected.map(match => match.ordinal))
      const selectedChunkIds = new Set(chunks.map(chunk => chunk.chunkId))
      const hits = chunks.map((chunk, position): KnowledgeHit => {
        const match = selected[position] as RerankMatch
        if (this.config.adjacentChunkCount === 0) return { ...chunk, score: match.score }
        const adjacent = index.sqlite.adjacentChunks(match.ordinal)
        const previousText = adjacent.previous === undefined || selectedChunkIds.has(adjacent.previous.chunkId)
          ? undefined
          : trimPreviousOverlap(adjacent.previous.text, chunk.text)
        const nextText = adjacent.next === undefined || selectedChunkIds.has(adjacent.next.chunkId)
          ? undefined
          : trimNextOverlap(chunk.text, adjacent.next.text)
        return {
          ...chunk,
          ...(previousText === undefined ? {} : { previousText }),
          ...(nextText === undefined ? {} : { nextText }),
          score: match.score,
        }
      })
      const strategy = {
        retrieval: plan.retrieval,
        ...(plan.denseIndex === undefined ? {} : { denseIndex: plan.denseIndex }),
        rerank,
      }
      return { hits, strategy }
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
    throwIfCancelled(signal)
    const reranker = await this.getReranker()
    throwIfCancelled(signal)
    const candidates = matches.slice(0, this.config.rerankerCandidateCount)
    const chunks = index.sqlite.chunks(candidates.map(match => match.ordinal))
    const byOrdinal = new Map(candidates.map((match, position) => [match.ordinal, chunks[position] as KnowledgeSearchResult['hits'][number]]))
    return [
      ...await reranker.rerank(query, candidates, byOrdinal, this.config.rerankerBatchSize, signal),
      ...matches.slice(candidates.length),
    ]
  }

  private async searchDense(
    index: LoadedKnowledgeIndex,
    query: string,
    denseIndex: 'exact' | 'hnsw',
    eligibility: { readonly mask: Uint8Array; readonly count: number },
    signal: AbortSignal | undefined,
  ): Promise<Array<{ ordinal: number; score: number }>> {
    const dense = index.manifest.dense
    /* v8 ignore next -- activation verifies a Dense payload for every Dense-capable mode. */
    if (dense === undefined) throw new KnowledgeError('Knowledge index does not contain Dense embeddings.', 'KNOWLEDGE_SEARCH_FAILED')
    if (eligibility.count === 0) return []
    throwIfCancelled(signal)
    const encoder = await this.getDenseEncoder()
    throwIfCancelled(signal)
    const queryVector = await encoder.embedQuery(query)
    throwIfCancelled(signal)
    if (denseIndex === 'hnsw') {
      const hnsw = await this.getHnsw(index)
      throwIfCancelled(signal)
      const vectorCount = index.manifest.corpus.chunkCount
      let requested = Math.min(this.config.candidateCount, vectorCount)
      let matches: Array<{ ordinal: number; score: number }> = []
      for (;;) {
        const byOrdinal = new Map<number, { ordinal: number; score: number }>()
        for (const match of hnsw.search(queryVector, requested, vectorCount)) {
          if (eligibility.mask[match.ordinal] !== 1) continue
          const existing = byOrdinal.get(match.ordinal)
          if (existing === undefined || match.score > existing.score) byOrdinal.set(match.ordinal, match)
        }
        matches = [...byOrdinal.values()]
        if (matches.length >= this.config.candidateCount || requested === vectorCount) break
        requested = Math.min(vectorCount, requested * 2)
        throwIfCancelled(signal)
      }
      throwIfCancelled(signal)
      const chunks = index.sqlite.chunks(matches.map(match => match.ordinal))
      return matches
        .map((match, position) => ({ ...match, chunkId: chunks[position]?.chunkId as string }))
        .sort((left, right) => right.score - left.score || compareCodePoints(left.chunkId, right.chunkId))
        .slice(0, this.config.candidateCount)
        .map(({ ordinal, score }) => ({ ordinal, score }))
    }
    /* v8 ignore next -- strategy resolution rejects Exact before this method when the Exact payload is absent. */
    if (index.dense === undefined) {
      throw new KnowledgeError('Knowledge index does not contain Exact Dense vectors.', 'KNOWLEDGE_SEARCH_FAILED')
    }
    const vectors = await this.getDenseVectors(index)
    throwIfCancelled(signal)
    return searchDense(
      vectors,
      queryVector,
      undefined,
      dense.dimensions,
      this.config.candidateCount,
      signal,
      eligibility.mask,
    )
  }
}

export default LocalKnowledgeProvider
