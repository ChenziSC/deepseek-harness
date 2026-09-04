# Agent Note: Local read-only RAG retrieval seam

Status: implemented

English | [中文](2026-09-04-local-rag-retrieval.zh.md)

## Problem

DSH had no provider-neutral way for an agent to retrieve evidence from a developer-supplied knowledge corpus. A learning implementation also needed to compare sparse retrieval, dense retrieval, rank fusion, and neural reranking under one corpus and evaluator without coupling those algorithms to the agent loop or exposing deployment controls to the model.

## Decision

The experimental capability is split into the three complete seam roles. `@deepseek-ai/dsh-experimental-knowledge` defines the provider-neutral `ctx.knowledge` service, branded document and chunk identifiers, ranked hits, and stable caller-visible errors. `@deepseek-ai/dsh-experimental-knowledge-local` provides that service from one immutable local index. `@deepseek-ai/dsh-experimental-tool-knowledge` consumes the service through the read-only `knowledge_search(query)` model tool.

The local provider supports Okapi BM25, exact float32 dense-vector scan with the fixed-revision BGE small English embedding model, and Reciprocal Rank Fusion over both routes. A fixed-revision multilingual BGE cross-encoder can optionally rerank candidates for any retrieval mode. Retrieval mode, candidate count, model revisions, cache paths, and reranking are deployment configuration; the model supplies only the query. The Consumer bounds query and evidence text, labels retrieved passages as untrusted evidence, assigns call-local citations, and omits scores and implementation details from model context.

Index preparation is an explicit offline operation. The index records corpus, chunking, analyzer, model, configuration, and payload hashes, and runtime loading rejects missing, corrupted, unknown, or mismatched artifacts. Plugin startup and search never download corpora or models and never rebuild or modify the index. Dense retrieval and reranking require an explicit populated local model cache; BM25 can run without model weights.

The offline command prepares the English BEIR SciFact fixture, builds an index, and evaluates BM25, Dense, and Hybrid with and without reranking under one document-level evaluator. The evaluator folds chunk hits to unique documents and reports Recall, MRR, nDCG, Success, and latency. SciFact establishes a reproducible English scientific-retrieval experiment only; it does not establish Chinese, general-domain, production-scale, or answer-generation quality.

## Alternatives considered

**Add retrieval behavior directly to `agent-loop`.** Rejected: retrieval is an optional capability with its own provider and Consumer lifecycle. The existing tool path already lets the model request evidence and keeps the loop independent of corpus and ranking choices.

**Implement the service, local algorithms, and model tool in one package.** Rejected: this would make a future provider depend on local index formats and make a non-model Consumer depend on prompt and rendering policy. The three roles change for different reasons and satisfy the repository's capability-seam structure without adding a provider registry.

**Use a remote vector database or managed search service.** Rejected for this phase: it would add deployment, credentials, network behavior, and provider-specific indexing before the retrieval algorithms can be compared locally. The provider-neutral service leaves that option open without putting remote concerns in the teaching implementation.

**Expose embedding or reranker inference as the product API.** Rejected: callers need ranked evidence, not model tensors. Making model execution the service would leak pooling, dimensions, prompts, and cache layout across the package boundary and would not represent BM25 or Hybrid retrieval.

**Download missing corpora or models at runtime.** Rejected: startup would become network-dependent and mutable, while experiments could silently use changed assets. Explicit preparation and fixed revisions make runtime behavior reproducible and let missing prerequisites fail clearly.

## Consequences

Deployments mount one Knowledge provider and may mount the tool Consumer; they do not mount the abstract Service Definition. The first implementation intentionally supports one read-only corpus, immutable whole-index publication, exact dense scan, and deployment-selected retrieval behavior. It does not provide incremental updates, multi-corpus routing, access control, remote storage, approximate vector indexes, inference scheduling, or production recovery.

The checked-in `rag-knowledge` example exercises the assembled BM25 path without external models. Package tests cover the service lifecycle, index validation, chunking, BM25, Dense, RRF, reranking, tool bounds, cancellation, offline commands, and SciFact evaluation. The complete local SciFact experiment covers 300 queries over 5,183 documents and records all six retrieval combinations; its results and hardware-specific latency remain experimental evidence rather than product defaults.
