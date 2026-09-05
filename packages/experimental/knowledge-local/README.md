# @deepseek-ai/dsh-experimental-knowledge-local

English | [中文](README.zh.md)

Experimental local provider for [`ctx.knowledge`](../knowledge/README.md). It loads one immutable BM25 or BM25-plus-Dense index, validates every payload before serving BM25, Dense, or Hybrid queries, and offers the `dsh-knowledge` offline command.

## Runtime config

```yaml
- id: knowledge-local
  name: '@deepseek-ai/dsh-experimental-knowledge-local'
  config:
    indexDir: ./path/to/index
    defaultRetrieval: hybrid
    defaultDenseIndex: auto
    defaultRerank: off
    allowedRetrieval: [bm25, dense, hybrid]
    allowedDenseIndexes: [exact, hnsw]
    allowedRerank: true
    candidateCount: 50
    rerankerCandidateCount: 20
    rrfK: 60
    modelCacheDir: ./model-cache
    denseModelId: onnx-community/bge-m3-ONNX
    denseModelRevision: 25b9af8e87a38eb120cfe87125383677b9cd309e
    denseDtype: q8
    denseMaxTokens: 512
    hnswExpansionSearch: 1024
    verifyPayloadHashes: false
    rerankerModelId: onnx-community/bge-reranker-v2-m3-ONNX
    rerankerModelRevision: 6f5ff65298512715a1e669753bc754d2bc8f367b
    rerankerDtype: q8
    rerankerBatchSize: 8
    rerankerMaxTokens: 512
```

Startup fails when the manifest or payloads are missing, corrupted, incompatible, or cannot support every allowed strategy. Allowing Dense, Hybrid, or reranked requests requires an explicit model cache; runtime model loading is local-only and never downloads missing files. A BM25-only policy with reranking disabled needs no model cache and does not load ONNX weights.

## Prepare benchmark data and models

The SciFact preparation command verifies the published archive digest and populates an explicit Transformers.js cache with the fixed BGE-M3 and reranker q8 revisions:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare scifact \
  --data-dir ./rag-data \
  --model-cache-dir ./model-cache
```

MLDR, T2Ranking, and MLQA Retrieval use fixed Hugging Face revisions and write source URLs, licenses, sizes, and SHA-256 digests to `source.json`:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare mldr --language zh --data-dir ./rag-data
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare t2ranking --data-dir ./rag-data
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare mlqa-eng-zho --data-dir ./rag-data
```

The BGE-M3 and reranker q8 weights occupy approximately 542 MiB and 544 MiB respectively. Benchmark data and models are local experiment inputs and are not committed.

## Build an index

The index command streams documents through bounded SQLite transactions, chunks them with the fixed-revision BGE-M3 tokenizer, builds the selected FTS5 analyzer, optionally embeds the same chunks in batches, and publishes `manifest.json` last:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts index \
  --corpus ./corpus.jsonl \
  --corpus-format scifact \
  --output ./index \
  --model-cache-dir ./model-cache \
  --components bm25,dense \
  --analyzer mixed-zh-en-v1 \
  --dense-index auto \
  --sqlite-batch-size 500 \
  --embedding-batch-size 32
```

The tokenizer and any requested q8 ONNX weights must already exist in the explicit cache. Use `--components bm25` to build the baseline without loading ONNX weights. `--corpus-format` accepts `generic`, `scifact`, `mldr`, or `t2ranking`. Index format 2 stores chunk metadata and BM25 data in `knowledge.sqlite`. `auto` builds Exact-only when `vectorCount × dimensions` is at most `50,000,000` and HNSW-only above it; `exact` and `hnsw` each retain one payload, while `both` retains `dense.f32le` and `dense.usearch`. An interactive terminal shows the exact scale, estimated sizes, and recommendation before embedding and asks for confirmation; non-interactive commands deterministically accept the recommendation. The runtime opens SQLite read-only, validates payload types and sizes on startup, recomputes hashes through `dsh-knowledge verify`, and loads Exact vectors or the HNSW graph only when requested.

The generic corpus format is one object per line:

```json
{"id":"doc-1","title":"Example","text":"Non-empty body","source":"fixture"}
```

The package also exports strict SciFact, MLDR, T2Ranking, and MLQA Retrieval parsers for the evaluation command.

## Retrieval behavior

Each request may select BM25, Dense, or Hybrid recall, Exact or HNSW Dense search, and optional reranking within the provider's allowed sets. Omitted fields use `defaultRetrieval`, `defaultDenseIndex`, and `defaultRerank`; the defaults are Hybrid, the index manifest's automatic Dense choice, and reranking off. Search results include the resolved strategy. The model-facing tool exposes only these high-level choices and does not expose candidate counts, fusion weights, thresholds, model paths, or HNSW parameters.

`mixed-zh-en-v1` applies Unicode NFKC normalization, lowercases ASCII words, preserves digits and underscores, and emits Chinese unigram and bigram terms. Query terms are de-duplicated. Runtime BM25 uses SQLite FTS5's fixed scoring parameters; score ties use chunk-id Unicode code-point order. `english-v1` remains available for first-phase English reproduction.

Dense mode uses fixed-revision `onnx-community/bge-m3-ONNX` q8 weights. Documents use title plus body, inputs are right-truncated to the configured model-token limit, and 1024-dimensional CLS embeddings are L2-normalized. Exact scans `dense.f32le`; HNSW searches the persisted USearch graph with ordinal keys and the configured `hnswExpansionSearch`.

Hybrid mode runs BM25 and Dense sequentially, takes up to `candidateCount` results from each route, and fuses their union with Reciprocal Rank Fusion. The default `rrfK` is 60; ties use the better route rank and then chunk-id Unicode code-point order. Either route failing fails the request without returning partial results.

Reranking can be enabled independently for BM25, Dense, and Hybrid. Recall retains 50 candidates by default; the cross-encoder reranks only the leading 20 by default and appends the remaining candidates in recall order. Developers may override `rerankerCandidateCount`. The fixed-revision `onnx-community/bge-reranker-v2-m3-ONNX` q8 model scores query and candidate text pairs in batches of eight, uses at most 512 tokens, and sorts by raw logit while preserving recall order on ties.

## Evaluate datasets

The evaluation command selects BM25, Dense, and Hybrid matrices, folds chunk hits to unique documents, and writes Recall, MRR, nDCG, Success, latency, payload sizes, and HNSW recall relative to Exact:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts evaluate \
  --index ./index \
  --queries ./rag-data/scifact/queries.jsonl \
  --qrels ./rag-data/scifact/qrels/test.tsv \
  --model-cache-dir ./model-cache \
  --max-results 20 \
  --candidate-count 50 \
  --reranker-candidate-count 20 \
  --modes bm25,dense,hybrid \
  --dense-indexes exact,hnsw \
  --rerank off,on \
  --output ./report
```

`--dataset` accepts `scifact`, `mldr`, `t2ranking`, or `mlqa`; `--query-limit` supports explicitly labeled sample runs. `--candidate-count` controls recall depth, and `--reranker-candidate-count` limits the leading candidates sent through the cross-encoder. A BM25-only matrix works with a BM25-only index. Warmup queries are excluded from latency statistics, and a failed combination is recorded without calculating partial averages.

## Model Experience

Indirectly, through knowledge Consumers that expose this provider's ranked title, source label, and chunk text while keeping retrieval scores and diagnostics local.

#### KV Cache effect

No direct invalidation; a Consumer owns any request-prefix changes and appends retrieved evidence after that prefix.

## Known Limitations and Deferred Work

- No single benchmark establishes general-domain quality. SciFact is English, MLDR is synthetic long-document retrieval, T2Ranking is Chinese, and MLQA Retrieval `eng-zho` covers Chinese queries over English passages.
- The BGE-M3 and reranker models are each larger than 500 MiB. CPU inference, especially reranking and offline embedding of large corpora, is substantially slower and more memory-intensive than BM25; this package does not add an inference queue or resource scheduler.
- Transformers.js does not expose token offsets. Chunk fallback therefore uses bounded tokenizer-count probes around each chunk and records cumulative local token positions; the result is deterministic for the fixed tokenizer but is not a general offset API for arbitrary tokenizers.
- Index construction permits an absent or empty target directory and leaves an unpublished incomplete directory after a failure; it does not provide atomic directory replacement or recovery. Full benchmark indexes are intended to be built, evaluated, and removed in sequence on storage-constrained machines rather than retained together.
- The mixed Chinese-English analyzer is deterministic and dictionary-free; it does not provide word segmentation, stemming, stop-word removal, synonyms, or learned sparse retrieval.
