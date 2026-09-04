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

## Search request

The caller supplies a non-empty natural-language query and the maximum number of ranked hits. Providers reject invalid requests through the error codes documented by the [Service Definition README](../../packages/experimental/knowledge/README.md).

```ts type-equiv
/** One provider-neutral retrieval request. */
interface KnowledgeSearchRequest {
  /** Non-empty natural-language query. */
  readonly query: string
  /** Maximum number of ranked hits the provider may return. */
  readonly maxResults: number
}
```

## Search result

Hits are ordered by descending provider rank. Scores are finite and comparable only within one response; consumers use the supplied order rather than comparing scores across calls or providers.

```ts type-equiv
/** One ranked fragment returned by a knowledge provider. */
interface KnowledgeHit {
  /** Original source-document identifier. */
  readonly documentId: KnowledgeDocumentId
  /** Stable fragment identifier. */
  readonly chunkId: KnowledgeChunkId
  /** Optional source title. */
  readonly title?: string
  /** Original fragment text. */
  readonly text: string
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
