# 知识检索

[English](knowledge.md) | 中文

实验性知识 seam 通过 `ctx.knowledge` 提供只读排序检索。[`@deepseek-ai/dsh-experimental-knowledge`](../../packages/experimental/knowledge) 定义服务和提供方无关的数据，[`@deepseek-ai/dsh-experimental-knowledge-local`](../../packages/experimental/knowledge-local) 提供本地检索，[`@deepseek-ai/dsh-experimental-tool-knowledge`](../../packages/experimental/tool-knowledge) 提供面向模型的工具。

源文件：[`packages/experimental/knowledge/src/types.ts`](../../packages/experimental/knowledge/src/types.ts)

## 标识

文档与分片标识在提供方之外均视为不透明值。一个分片标识在对应的已索引片段内保持稳定。

```ts type-equiv
/** Stable identifier of one source document. */
type KnowledgeDocumentId = Branded<'KnowledgeDocumentId'>
```

```ts type-equiv
/** Stable identifier of one indexed document fragment. */
type KnowledgeChunkId = Branded<'KnowledgeChunkId'>
```

## 检索请求

调用方提供非空自然语言查询和最大排序命中数量。提供方通过 [Service Definition README](../../packages/experimental/knowledge/README.zh.md) 记录的错误码拒绝无效请求。

```ts type-equiv
/** One provider-neutral retrieval request. */
interface KnowledgeSearchRequest {
  /** Non-empty natural-language query. */
  readonly query: string
  /** Maximum number of ranked hits the provider may return. */
  readonly maxResults: number
}
```

## 检索结果

命中结果按提供方排序降序排列。分数是有限数值，且只能在同一次响应内比较；消费方应使用提供的顺序，不应跨调用或跨提供方比较分数。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
