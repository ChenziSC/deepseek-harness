# @deepseek-ai/dsh-experimental-knowledge-local

English | [中文](README.zh.md)

Experimental local provider for [`ctx.knowledge`](../knowledge/README.md). It loads one immutable BM25 or BM25-plus-Dense index, validates every payload before serving BM25, Dense, or Hybrid queries, and offers the `dsh-knowledge` offline command.

## Runtime config

```yaml
- id: knowledge-local
  name: '@deepseek-ai/dsh-experimental-knowledge-local'
  config:
    indexDir: ./path/to/index
    mode: hybrid
    rerank: false
    candidateCount: 50
    bm25K1: 1.2
    bm25B: 0.75
    rrfK: 60
    modelCacheDir: ./model-cache
    denseModelId: onnx-community/bge-small-en-v1.5-ONNX
    denseModelRevision: 4a9a46c7b88fa408e650a571a1800243f26309bd
    denseDtype: q8
    denseMaxTokens: 512
    rerankerModelId: onnx-community/bge-reranker-v2-m3-ONNX
    rerankerModelRevision: 6f5ff65298512715a1e669753bc754d2bc8f367b
    rerankerDtype: q8
    rerankerBatchSize: 8
    rerankerMaxTokens: 512
```

Startup fails when the manifest or payloads are missing, corrupted, incompatible, or use different configured retrieval parameters. Dense, Hybrid, and reranked modes require an explicit model cache; runtime model loading is local-only and never downloads missing files. BM25 without reranking needs no model cache and does not load ONNX weights.

## Prepare SciFact and models

The preparation command downloads the English BEIR SciFact dataset, verifies its published MD5 digest, reports SHA-256, and populates an explicit Transformers.js cache with both fixed q8 model revisions:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare scifact \
  --data-dir ./rag-data \
  --model-cache-dir ./model-cache
```

The downloaded q8 weights occupy approximately 32 MiB for Dense retrieval and 544 MiB for reranking; tokenizers and configuration bring the combined cache to approximately 594 MiB.

## Build an index

The index command parses strict JSONL documents, chunks them with the fixed-revision BGE tokenizer, builds the English BM25 postings, optionally embeds the same chunks, writes payloads, and publishes `manifest.json` last:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts index \
  --corpus ./corpus.jsonl \
  --corpus-format scifact \
  --output ./index \
  --model-cache-dir ./model-cache \
  --components bm25,dense \
  --embedding-batch-size 32
```

The tokenizer and any requested q8 ONNX weights must already exist in the explicit cache. Use `--components bm25` to build the baseline without loading ONNX weights. `--corpus-format` accepts `generic` or `scifact` and defaults to `generic`.

The generic corpus format is one object per line:

```json
{"id":"doc-1","title":"Example","text":"Non-empty body","source":"fixture"}
```

The package also exports strict SciFact corpus, query, and qrels parsers for the later evaluation command.

## Retrieval behavior

`english-v1` applies Unicode NFKC normalization, lowercase conversion, and consecutive Unicode letter-or-number token extraction. Query tokens are de-duplicated. Okapi BM25 uses configurable `k1` and `b`; score ties use chunk-id Unicode code-point order. `explainBm25` exposes local-only token and term-contribution diagnostics.

Dense mode uses the fixed-revision `onnx-community/bge-small-en-v1.5-ONNX` q8 model. Documents are embedded as title, newline, and body; queries receive the BGE retrieval prefix. Inputs are right-truncated to at most 512 model tokens, embeddings use CLS pooling and L2 normalization, and retrieval performs an exact float32 dot-product scan. `dense.f32le` stores one 384-value little-endian row per chunk.

Hybrid mode runs BM25 and Dense sequentially, takes up to `candidateCount` results from each route, and fuses their union with Reciprocal Rank Fusion. The default `rrfK` is 60; ties use the better route rank and then chunk-id Unicode code-point order. Either route failing fails the request without returning partial results.

Reranking can be enabled independently for BM25, Dense, and Hybrid. The fixed-revision `onnx-community/bge-reranker-v2-m3-ONNX` q8 cross-encoder scores query and candidate text pairs in batches of eight, uses at most 512 tokens, and sorts by raw logit while preserving recall order on ties.

## Evaluate SciFact

The evaluation command runs BM25, Dense, and Hybrid with and without reranking, folds chunk hits to unique documents, and writes Recall, MRR, nDCG, Success, and latency measurements:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts evaluate \
  --index ./index \
  --queries ./rag-data/scifact/queries.jsonl \
  --qrels ./rag-data/scifact/qrels/test.tsv \
  --model-cache-dir ./model-cache \
  --max-results 20 \
  --output ./report
```

The six combinations use the same 50-candidate recall depth. Warmup queries are excluded from latency statistics, and a failed combination is recorded without calculating partial averages.

## Model Experience

Indirectly, through knowledge Consumers that expose this provider's ranked title, source label, and chunk text while keeping retrieval scores and diagnostics local.

#### KV Cache effect

No direct invalidation; a Consumer owns any request-prefix changes and appends retrieved evidence after that prefix.

## Known Limitations and Deferred Work

- SciFact contains English scientific claims and abstracts; its results do not establish Chinese retrieval quality or general-domain behavior.
- The 544 MiB reranker is substantially slower and more memory-intensive than BM25 or the 32 MiB embedding model; this package does not add an inference queue or resource scheduler.
- Chunk fallback locates original-text boundaries by repeated tokenizer counts because Transformers.js does not expose token offsets. The result is deterministic for the fixed tokenizer but is not a general offset API for arbitrary tokenizers.
- Index construction permits an absent or empty target directory and leaves incomplete payloads after a failure; it does not provide atomic directory replacement or recovery.
- The default analyzer is an English teaching baseline without stemming, stop-word removal, or synonyms.
