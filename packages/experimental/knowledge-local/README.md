# @deepseek-ai/dsh-experimental-knowledge-local

English | [中文](README.zh.md)

Experimental local provider for [`ctx.knowledge`](../knowledge/README.md). It loads one immutable BM25 or BM25-plus-Dense index, validates every payload before serving BM25, Dense, or Hybrid queries, and offers the `dsh-knowledge` offline command.

The package root exports only the Loader `Config`, `LocalKnowledge`, and the default plugin class. Index construction, dataset parsing, evaluation, and diagnostic algorithms are internal implementation modules rather than supported package-root APIs.

## Runtime config

```yaml
- id: knowledge-local
  name: '@deepseek-ai/dsh-experimental-knowledge-local'
  config:
    indexDir: ./path/to/index
    defaultRetrieval: auto
    defaultDenseIndex: auto
    defaultRerank: off
    allowedRetrieval: [bm25, dense, hybrid]
    allowedDenseIndexes: [exact, hnsw]
    allowedRerank: true
    candidateCount: 50
    rerankerCandidateCount: 20
    adaptiveRerankMinScoreGapRatio: 0.15
    adjacentChunkCount: 1
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
  --chunking-strategy markdown-structure-v1 \
  --dense-index auto \
  --sqlite-batch-size 500 \
  --embedding-batch-size 32 \
  --derived-cache-dir ./document-cache \
  --vector-cache-dir ./vector-cache
```

The tokenizer and any requested q8 ONNX weights must already exist in the explicit model cache. Use `--components bm25` to build the baseline without loading ONNX weights. `--corpus-format` accepts `generic`, `scifact`, `mldr`, or `t2ranking`. `--chunking-strategy` accepts the default `markdown-structure-v1` or the fixed-boundary `token-window-v1`; the latter omits section paths and primarily supports controlled comparisons. Index format 4 stores document metadata separately from ordinal-aligned chunks and BM25 data in `knowledge.sqlite`; its manifest records the selected chunking strategy, the corpus's coarse Latin/CJK script profile, and the fixed document-metadata schema. `auto` builds Exact-only when `vectorCount × dimensions` is at most `50,000,000` and HNSW-only above it; `exact` and `hnsw` each retain one payload, while `both` retains `dense.f32le` and `dense.usearch`. An interactive terminal shows the exact scale, estimated sizes, and recommendation before embedding and asks for confirmation; non-interactive commands deterministically accept the recommendation. The runtime opens SQLite read-only, validates payload types and sizes on startup, recomputes hashes through `dsh-knowledge verify`, and loads Exact vectors or the HNSW graph only when requested. Older indexes are rejected and must be rebuilt; unchanged Dense inputs can still reuse the separate vector cache.

`--derived-cache-dir` enables a separate SQLite cache for complete per-document chunking, Dense input, and analyzed BM25 text. Its key covers the tokenizer revision, chunking settings, analyzer revision, document id, title, and body; source, version, validity, and replacement metadata remain outside the key because they are projected into the target document row and do not affect retrieval text. A hit skips the tokenizer, chunker, and BM25 analyzer, while the builder assigns fresh global ordinals and writes a complete new index. Cache corruption fails the build with the affected key instead of being treated as a miss. The final JSON `documentBuild` object reports document and chunk reuse plus phase timings.

`--vector-cache-dir` independently enables a build-time SQLite cache addressed by the complete Dense configuration and exact title, section path, and chunk text input. Unchanged inputs reuse byte-identical float32 vectors across document additions, deletions, ordinal changes, and changes limited to source or version metadata; duplicate inputs are encoded once. `--import-vectors-from` first verifies a format-4 index and all payload hashes, requires an Exact `dense.f32le` payload with matching Dense settings, and imports it without modifying the source. Each successful embedding batch is committed to the cache before target payload assembly, so a later build can reuse completed batches after interruption. The final JSON `denseBuild` object reports cache hits, encoded inputs, reuse ratio, imported vectors, and phase timings. Every target still rebuilds SQLite, Exact ordering, and any HNSW graph, and publishes its manifest last.

### Contextual-prefix evaluation tools

Contextual prefixes are retained only as offline evaluation tools. A normal `index` command cannot consume generated prefix records and never reads prefix credentials or calls an LLM. `contextual-statistics` scans every source document and writes only aggregate detector, batching, and token-bound statistics; it does not create SQLite, BM25, Exact, HNSW, generated-prefix, or embedding artifacts. Its default `--sample-modulus 1` tokenizes every document, while a larger value still hashes and validates the complete corpus but estimates chunk-level totals from the deterministic subset selected by document-id hash. `contextual-plan` is for a bounded evaluation corpus and writes a reviewable plan without calling a model. Each request reserves the configured per-prefix content tokens plus 128 output tokens for JSON framing and provider reasoning. `contextual-generate` consumes that exact plan, an explicit OpenAI-compatible endpoint, fixed model identity, cache directory, and cumulative token budgets. The API key is read from the named environment variable and is not written to the plan, cache, records, or errors.

```sh
dsh-knowledge contextual-statistics --corpus ./corpus.jsonl --output ./statistics --model-cache-dir ./model-cache --target dense --max-candidate-ratio 0.15 --max-prefix-tokens 80 --context-window-tokens 1024 --max-chunks-per-request 4 --prompt-version context-prefix-v5 --sample-modulus 100
dsh-knowledge contextual-plan --corpus ./evaluation-subset.jsonl --output ./plan --model-cache-dir ./model-cache --target dense --max-candidate-ratio 0.15 --max-input-tokens 1000000 --max-output-tokens 100000 --max-prefix-tokens 80 --context-window-tokens 1024 --max-chunks-per-request 4 --budget-action deterministic-fallback --prompt-version context-prefix-v5
dsh-knowledge contextual-generate --plan ./plan/contextual-prefix-plan.json --output ./records --cache-dir ./prefix-cache --model-cache-dir ./model-cache --base-url https://api.example/v1 --api-key-env PREFIX_API_KEY --model-id fixed-model --revision fixed-revision --reasoning-effort minimal --max-input-tokens 1000000 --max-output-tokens 100000 --budget-action deterministic-fallback
```

The real-corpus evaluation did not meet its cost, retrieval-quality, generation-success, or factuality thresholds, so generated records are not accepted by the production index command. The tools remain available to reproduce bounded experiments without changing the index format or runtime retrieval behavior.

The generic corpus format is one object per line:

```json
{"id":"policy-v2","title":"Example","text":"Non-empty body","source":"fixture","sourceVersion":"2","validFrom":"2026-01-01T00:00:00Z","validUntil":"2027-01-01T00:00:00Z","supersedes":"policy-v1"}
```

The evaluation command uses strict SciFact, MLDR, T2Ranking, and MLQA Retrieval parsers.

## Calibrate the Exact/HNSW threshold

The threshold experiment uses the fixed T2Ranking development files plus the official fixed-revision `dev.bm25.tsv` run. `slice` keeps every positive for the first queries, adds globally de-duplicated BM25 hard negatives by rank and query order, and writes nested corpora whose padded document identifiers preserve the same ordinal prefix after indexing:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts slice \
  --collection ./rag-data/t2ranking/collection.tsv \
  --queries ./rag-data/t2ranking/queries.dev.tsv \
  --qrels ./rag-data/t2ranking/qrels.retrieval.dev.tsv \
  --bm25-run ./rag-data/t2ranking/dev.bm25.tsv \
  --model-cache-dir ./model-cache \
  --output ./threshold-slices
```

Build the largest slice once with `--dense-index both`, then derive smaller comparison indexes without loading the embedding model:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts derive \
  --source-index ./index-100000 \
  --corpus ./threshold-slices/chunks-10000/corpus.tsv \
  --output ./index-10000 \
  --model-cache-dir ./model-cache \
  --derived-cache-dir ./document-cache \
  --dense-index both
```

Derivation rebuilds SQLite FTS and optional HNSW payloads, copies Exact vectors in bounded batches, and rejects any target whose chunk identity, retrieval text, analyzer, tokenizer, or chunking differs from the source ordinal prefix. It does not change index format 4 or call the Dense encoder.

## Retrieval behavior

Each request may select automatic routing or BM25, Dense, or Hybrid recall, Exact or HNSW Dense search, and optional reranking within the provider's allowed sets. Omitted retrieval defaults to `auto`: URLs, paths, code-like identifiers, long numbers, and hexadecimal identifiers route to BM25, while other queries route to Dense. Hybrid remains an explicit choice. If the preferred route is disallowed, the provider chooses the nearest allowed fallback in a fixed order. Explicit high-level choices override routing. Search results include the concrete executed strategy. The model-facing tool does not expose candidate counts, fusion weights, thresholds, model paths, or HNSW parameters.

Optional `asOf` accepts a millisecond-precision RFC 3339 timestamp with an explicit timezone. Omitting it captures the current time once per request. A document is eligible when `validFrom` is absent or not later than the request instant and `validUntil` is absent or later than that instant; unknown validity remains eligible. BM25 applies the predicate before its candidate limit, Exact skips ineligible ordinals during scanning, HNSW doubles its requested neighbor count until it has enough eligible candidates or has searched the complete graph, and Hybrid fuses only filtered candidates. `supersedes` is evidence metadata and does not hide another document or affect ranking.

The default chunker prefers Markdown ATX heading boundaries, then paragraphs and sentences, while keeping fenced code blocks intact unless a block exceeds the token limit. The active heading path is indexed with each chunk for BM25 and Dense retrieval. The token-window strategy uses only the tokenizer's hard limit and configured overlap. After ranking, `adjacentChunkCount: 1` attaches at most one same-document chunk before and after each hit, removes text duplicated by chunk overlap, and does not change result counts or ranking metrics; set it to `0` to disable expansion and reduce returned context.

`mixed-zh-en-v1` applies Unicode NFKC normalization, lowercases ASCII words, preserves digits and underscores, and emits Chinese unigram and bigram terms. Query terms are de-duplicated. Runtime BM25 uses SQLite FTS5's fixed scoring parameters; score ties use chunk-id Unicode code-point order. `english-v1` remains available for first-phase English reproduction.

The earlier in-memory Okapi scorer remains under `src/offline/evaluation` only for token-level diagnostics and controlled historical comparisons. Product retrieval and dataset quality baselines use SQLite FTS5.

Dense mode uses fixed-revision `onnx-community/bge-m3-ONNX` q8 weights. Documents use title plus body, inputs are right-truncated to the configured model-token limit, and 1024-dimensional CLS embeddings are L2-normalized. Exact scans `dense.f32le`; HNSW searches the persisted USearch graph with ordinal keys and the configured `hnswExpansionSearch`.

Hybrid mode runs BM25 and Dense sequentially, takes up to `candidateCount` results from each route, and fuses their union with Reciprocal Rank Fusion. The default `rrfK` is 60; ties use the better route rank and then chunk-id Unicode code-point order. Either route failing fails the request without returning partial results.

Reranking can be selected independently for BM25, Dense, and Hybrid. `off` never loads the cross-encoder, `on` reranks every non-empty candidate set, and `auto` reranks only when the normalized score gap between the first two candidates is below `adaptiveRerankMinScoreGapRatio`, which defaults to `0.15`. Recall retains 50 candidates by default; the cross-encoder reranks only the leading 20 by default and appends the remaining candidates in recall order. Developers may override both values. The fixed-revision `onnx-community/bge-reranker-v2-m3-ONNX` q8 model scores query and candidate text pairs in batches of eight, uses at most 512 tokens, and sorts by raw logit while preserving recall order on ties.

## Evaluate datasets

The evaluation command selects automatic, BM25, Dense, and Hybrid matrices, folds chunk hits to unique documents, and writes Recall, MRR, nDCG, Success, latency, payload sizes, and HNSW recall relative to Exact:

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts evaluate \
  --index ./index \
  --queries ./rag-data/scifact/queries.jsonl \
  --qrels ./rag-data/scifact/qrels/test.tsv \
  --model-cache-dir ./model-cache \
  --max-results 20 \
  --candidate-count 50 \
  --reranker-candidate-count 20 \
  --modes auto,bm25,dense,hybrid \
  --dense-indexes exact,hnsw \
  --rerank off,auto,on \
  --adaptive-rerank-min-score-gap-ratio 0.02 \
  --output ./report
```

`--dataset` accepts `scifact`, `mldr`, `t2ranking`, or `mlqa`; `--query-limit` supports explicitly labeled sample runs. `--modes auto` permits BM25, Dense, and Hybrid and records the resolved route for each query, while a fixed mode restricts the provider to that route. `--candidate-count` controls recall depth, `--reranker-candidate-count` limits the leading candidates sent through the cross-encoder, and `--adaptive-rerank-min-score-gap-ratio` selects the threshold for one run. `report.json` retains aggregate metrics and resolved-route counts. `queries.jsonl` records each measured query's requested and resolved strategies, relevant and ranked documents, single-query metrics, latency, and the recall top-two score gap when the returned scores have not been replaced by reranking. A BM25-only matrix works with a BM25-only index. Warmup queries are excluded from both outputs, and a failed combination is recorded without calculating partial averages; a query failure also receives a JSONL failure record before its run stops.

## Model Experience

Indirectly, through knowledge Consumers that expose this provider's ranked title, section path, source label, source version, validity, replacement relation, matched chunk, and optional adjacent context while keeping retrieval scores and diagnostics local.

#### KV Cache effect

No direct invalidation; a Consumer owns any request-prefix changes and appends retrieved evidence after that prefix.

## Known Limitations and Deferred Work

- No single benchmark establishes general-domain quality. SciFact is English, MLDR is synthetic long-document retrieval, T2Ranking is Chinese, and MLQA Retrieval `eng-zho` covers Chinese queries over English passages.
- The BGE-M3 and reranker models are each larger than 500 MiB. CPU inference, especially reranking and offline embedding of large corpora, is substantially slower and more memory-intensive than BM25; this package does not add an inference queue or resource scheduler.
- Transformers.js does not expose token offsets. Chunk fallback therefore uses bounded tokenizer-count probes around each chunk and records cumulative local token positions; the result is deterministic for the fixed tokenizer but is not a general offset API for arbitrary tokenizers.
- Index construction permits an absent or empty target directory and leaves an unpublished incomplete directory after a failure; it does not provide atomic directory replacement or recovery. Full benchmark indexes are intended to be built, evaluated, and removed in sequence on storage-constrained machines rather than retained together.
- The document and vector caches accelerate exact reusable work but do not incrementally update the final SQLite, Exact ordering, or HNSW graph; every target remains a complete immutable index.
- HNSW validity filtering may search progressively larger neighbor sets when many high-ranked vectors are ineligible at the requested time; it never returns an ineligible fallback.
- The mixed Chinese-English analyzer is deterministic and dictionary-free; it does not provide word segmentation, stemming, stop-word removal, synonyms, or learned sparse retrieval.
- Automatic routing and adaptive reranking use deterministic heuristics rather than a learned classifier; deployments can override the high-level request or the provider threshold.
- Contextual-prefix generation is an offline evaluation tool, not an index or online retrieval capability. The real-corpus evaluation failed its release thresholds; full-corpus statistics never imply permission to generate full-corpus prefixes.
