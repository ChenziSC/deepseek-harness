# Knowledge retrieval

English | [中文](knowledge.zh.md)

The experimental knowledge seam exposes read-only ranked retrieval through `ctx.knowledge`. [`@deepseek-ai/dsh-experimental-knowledge`](../../packages/experimental/knowledge) defines the service and provider-neutral values, [`@deepseek-ai/dsh-experimental-knowledge-local`](../../packages/experimental/knowledge-local) provides local retrieval, and [`@deepseek-ai/dsh-experimental-tool-knowledge`](../../packages/experimental/tool-knowledge) exposes the model-facing tool.

Source: [`packages/experimental/knowledge/src/types.ts`](../../packages/experimental/knowledge/src/types.ts)

## Identifiers

Document and chunk identifiers are opaque outside their provider. A chunk identifier remains stable for one indexed fragment.

```ts type-equiv
/** Stable identifier of one source document. */
type KnowledgeDocumentId = Branded<'KnowledgeDocumentId'>
```

```ts type-equiv
/** Stable identifier of one indexed document fragment. */
type KnowledgeChunkId = Branded<'KnowledgeChunkId'>
```

## Search strategy

Callers may request only provider-neutral choices. The provider applies its allowed sets and defaults, resolves `auto`, and returns the strategy it actually executed. Dense index details are absent from a resolved BM25 strategy.

```ts type-equiv
/** Provider-neutral recall preference requested for one search. */
type KnowledgeRetrieval = 'auto' | 'bm25' | 'dense' | 'hybrid'
```

```ts type-equiv
/** Concrete recall algorithm executed by a provider. */
type ResolvedKnowledgeRetrieval = Exclude<KnowledgeRetrieval, 'auto'>
```

```ts type-equiv
/** Provider-neutral Dense index preference requested for one search. */
type KnowledgeDenseIndex = 'auto' | 'exact' | 'hnsw'
```

```ts type-equiv
/** Provider-neutral reranking preference requested for one search. */
type KnowledgeRerank = 'auto' | 'on' | 'off'
```

```ts type-equiv
/** Optional source-owned version and validity metadata for one document. */
interface KnowledgeDocumentMetadata {
  /** Opaque version label supplied by the source system. */
  readonly sourceVersion?: string
  /** Inclusive RFC 3339 instant at which the document becomes effective. */
  readonly validFrom?: string
  /** Exclusive RFC 3339 instant at which the document stops being effective. */
  readonly validUntil?: string
  /** Optional identifier of the document directly replaced by this document. */
  readonly supersedes?: KnowledgeDocumentId
}
```

```ts type-equiv
/** Optional high-level retrieval choices for one search. */
interface KnowledgeSearchStrategy {
  /** Recall preference; `auto` lets the provider route the query. */
  readonly retrieval?: KnowledgeRetrieval
  /** Dense index preference; meaningful only for Dense and Hybrid recall. */
  readonly denseIndex?: KnowledgeDenseIndex
  /** Reranking preference; `auto` uses the provider default. */
  readonly rerank?: KnowledgeRerank
}
```

```ts type-equiv
/** High-level retrieval choices executed by a provider. */
interface ResolvedKnowledgeSearchStrategy {
  /** Recall algorithm used for this result. */
  readonly retrieval: ResolvedKnowledgeRetrieval
  /** Dense index used by Dense or Hybrid recall. */
  readonly denseIndex?: Exclude<KnowledgeDenseIndex, 'auto'>
  /** Whether neural reranking was applied. */
  readonly rerank: boolean
}
```

## Search request

The caller supplies a non-empty natural-language query, the maximum number of ranked hits, optional high-level retrieval choices, and optionally an explicit RFC 3339 instant for historical validity filtering. Providers reject invalid or disallowed requests through the error codes documented by the [Service Definition README](../../packages/experimental/knowledge/README.md).

```ts type-equiv
/** One provider-neutral retrieval request. */
interface KnowledgeSearchRequest {
  /** Non-empty natural-language query. */
  readonly query: string
  /** Maximum number of ranked hits the provider may return. */
  readonly maxResults: number
  /** Optional high-level retrieval choices interpreted by the provider. */
  readonly strategy?: KnowledgeSearchStrategy
  /** Optional RFC 3339 instant used for validity filtering at a requested time. */
  readonly asOf?: string
}
```

## Search result

Hits are ordered by descending provider rank. Scores are finite and comparable only within one response; consumers use the supplied order rather than comparing scores across calls or providers. Optional source-owned metadata describes a version, its inclusive start, exclusive end, and direct replacement relation. Optional adjacent text supplies local reading context without creating additional ranked hits.

```ts type-equiv
/** One ranked fragment returned by a knowledge provider. */
interface KnowledgeHit extends KnowledgeDocumentMetadata {
  /** Original source-document identifier. */
  readonly documentId: KnowledgeDocumentId
  /** Stable fragment identifier. */
  readonly chunkId: KnowledgeChunkId
  /** Optional source title. */
  readonly title?: string
  /** Optional Markdown heading path enclosing the ranked fragment. */
  readonly sectionPath?: string
  /** Original fragment text. */
  readonly text: string
  /** Optional de-duplicated text immediately before the ranked fragment. */
  readonly previousText?: string
  /** Optional de-duplicated text immediately after the ranked fragment. */
  readonly nextText?: string
  /** Optional source label; not necessarily a URL or filesystem path. */
  readonly source?: string
  /** Finite score comparable only within this response. */
  readonly score: number
}
```

```ts type-equiv
/** Provider-neutral ranked retrieval result. */
interface KnowledgeSearchResult {
  /** Hits in final descending rank order. */
  readonly hits: readonly KnowledgeHit[]
  /** High-level retrieval choices executed for this result. */
  readonly strategy: ResolvedKnowledgeSearchStrategy
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxknowledge--knowledge-abstract-seam"></a>

### `ctx.knowledge` — `Knowledge` (abstract seam)

Abstract read-only knowledge retrieval service.

```ts cordis-catalog
/**
 * Retrieve ranked evidence for one query.
 * @param request - validated query text and caller-owned result limit.
 * @param signal - optional cooperative cancellation signal.
 * @returns provider-neutral ranked evidence.
 */
abstract search(request: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResult>
```

Source: [`packages/experimental/knowledge/src/index.ts`](../../packages/experimental/knowledge/src/index.ts)
<!-- END GENERATED cordis-surface -->
