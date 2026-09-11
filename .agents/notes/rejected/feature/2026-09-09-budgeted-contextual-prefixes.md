# Agent Note: Budgeted contextual prefixes for local knowledge indexes

Status: rejected — real-corpus evaluation missed cost, quality, stability, and factuality thresholds

English | [中文](2026-09-09-budgeted-contextual-prefixes.zh.md)

## Problem

An isolated phase-six experiment showed that generated context can make ambiguous chunks easier to retrieve, but its per-chunk design is not suitable for large corpora. It repeated document context for each chunk, increased indexed tokens by 29.49%, missed the generation-success threshold in one run, and used synthetic samples with substantial template bias. Applying that design to every chunk would create large model charges and unnecessary vector invalidation before real-corpus benefit is established.

The existing deterministic retrieval text remains inexpensive and stable, but it cannot always resolve pronouns, relative dates, cross-section references, or generic headings. The useful capability is therefore selective offline enrichment, not an unconditional replacement for the current index path.

## Proposal

Add contextual prefixes as an explicitly enabled, offline-only index option. The default remains `off`; loading an index and answering a query never invokes the prefix model. An enabled build first produces a deterministic plan and cost preview, then generates prefixes only for high-ambiguity chunks within explicit candidate and token budgets.

The detector uses versioned lexical and structural rules without an LLM. Generation groups nearby candidates from one document section into bounded context windows so a long document is not submitted once per chunk. Each request reserves the per-prefix content allowance plus 128 output tokens for JSON framing and provider reasoning. The prompt asks for one compact sentence capped at half of the validated prefix limit, leaving headroom for tokenizer variance while the parser still rejects any prefix above the configured hard limit. The chunker suppresses overlap-only tails caused by trailing whitespace so cached token intervals remain strictly increasing. A separate content-addressed cache keys results by the exact context window, target chunks, detector and prompt versions, model identity, parameters, and output limit. Unselected chunks retain their existing retrieval text and vector-cache identity.

Full corpora are scanned only for aggregate candidate and cost statistics. Exact scans tokenize every document; a deterministic document-id hash sample may estimate chunk-level totals for very large corpora while the scanner still reads, validates, hashes, and counts every source document and records the sampling modulus and tokenized-document count. Quality evaluation builds bounded qrels-complete subsets of at most 10,000 chunks per dataset and 50,000 chunks in total; it does not rebuild a complete corpus index. Generated prefixes remain separate from source evidence and are not returned by the knowledge tool.

## Alternatives considered

**Generate a prefix for every chunk.** Rejected because the complete local corpora contain roughly 9.5 million estimated chunks. The phase-six per-chunk usage would project to billions of generation tokens, and long MLDR documents make repeated full-document prompts worse than that uniform estimate.

**Use only deterministic title and section metadata.** Retained as the default and fallback. It is inexpensive and reproducible, but the phase-six pilot showed that it does not resolve every context-dependent chunk.

**Generate one document summary and attach it to every chunk.** Rejected as the sole strategy because one summary can dilute section-specific entities and add repeated index text. Shared document or section context may be used inside a generation batch, while each selected chunk still receives a bounded prefix.

**Generate context during queries.** Rejected because it adds online latency, makes retrieval depend on another model request, and complicates reproducibility. Prefix generation belongs to the offline artifact build.

## Acceptance criteria

- The default build performs no prefix-model initialization, credential read, or network request.
- Complete-corpus evaluation performs streaming statistics only and creates no complete SQLite, BM25, Exact, or HNSW index.
- Real-corpus quality evaluation uses no more than 10,000 chunks per dataset and 50,000 chunks in total.
- Bounded batching reduces generation input by at least 80% relative to submitting a complete document for each candidate chunk.
- Repeating an unchanged build reuses every successful prefix, and local document changes invalidate only affected context windows.
- Generated prefixes improve high-ambiguity Recall@10 or complete evidence coverage by at least five percentage points over deterministic prefixes without more than one percentage point of nDCG@10 regression on any retrieval path.
- Passing every criterion still leaves the feature explicitly enabled and default-off.

## Risks

Deterministic rules can miss semantic ambiguity or select harmless pronouns, so candidate precision and recall require real-corpus review. Generated text can add unsupported specificity or retrieval keywords that distort ranking. Token estimates can differ from provider billing, especially for long multilingual inputs, so actual usage remains authoritative. A model or prompt upgrade invalidates generated-prefix cache entries and may require re-encoding every selected chunk even when source documents are unchanged.
