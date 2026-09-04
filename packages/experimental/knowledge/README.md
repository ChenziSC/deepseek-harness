# @deepseek-ai/dsh-experimental-knowledge

English | [中文](README.zh.md)

Experimental Service Definition for read-only retrieval from an external knowledge corpus. It owns the provider-neutral `ctx.knowledge` API, branded document and chunk identifiers, ranked hits, and caller-visible error codes. It does not select a retrieval algorithm, read an index, or register a model tool.

## API

Providers extend the default `Knowledge` service and implement:

```ts
import type { KnowledgeSearchRequest, KnowledgeSearchResult } from '@deepseek-ai/dsh-experimental-knowledge'

interface Knowledge {
  search(request: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResult>
}
```

`request.query` must be non-empty and `request.maxResults` must be a positive integer. A hit carries its source document and chunk identifiers, optional title and source label, original chunk text, and a finite score comparable only within that response.

`KnowledgeError` exposes `KNOWLEDGE_INVALID_REQUEST`, `KNOWLEDGE_CANCELLED`, and `KNOWLEDGE_SEARCH_FAILED`. Provider-specific file and model details remain internal.

## Composition

Do not mount this abstract package in `cordis.yml`. Mount one provider such as `@deepseek-ai/dsh-experimental-knowledge-local`; consumers depend only on `ctx.knowledge`.

## Model Experience

Indirectly, through Consumers such as `dsh-experimental-tool-knowledge`, which decide whether search is exposed and how hits enter model context.

#### KV Cache effect

No direct invalidation; each Consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- The first contract supports one read-only knowledge source per Cordis context.
- It has no write, collection-selection, provider-selection, or algorithm-diagnostic API.
- The API is experimental and carries no compatibility promise.
