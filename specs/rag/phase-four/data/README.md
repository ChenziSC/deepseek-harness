# Phase-four evaluation data

English | [中文](README.zh.md)

## Automatic routing

This directory contains two fixed query groups for the format-3 T2Ranking 10k index. The index manifest SHA-256 is `55b23dd3d7ab47f6f89b81ef900634f9979a3b59bb05222f196932ab57938e6c`; the corpus SHA-256 is `1d800b8a4d78f0252f35b0ae66f351d089ca6d380a35f73f81969e024caab960`.

`automatic-routing-cross-script-queries.tsv` contains manually checked English rewrites of 20 Chinese T2Ranking queries while preserving the original query IDs and qrels. The script classifier identifies every query as `latin`; Dense is the expected route against the CJK corpus.

`automatic-routing-identifiers-queries.tsv` contains 18 unique telephone numbers and two unique code identifiers copied verbatim from indexed text. Its qrels mark only documents containing the complete identifier; BM25 is the expected route for every query.

These files evaluate routing and retrieval only; they are not general question-answering samples. The ordinary same-script group continues to use the 10k slice's original `queries.tsv` and `qrels.tsv`.

## Adaptive Reranker

`reranker-threshold-evaluation-summary.json` combines BM25, Dense, and Hybrid `off`/`on` details for 100 T2Ranking queries and 30 SciFact queries, then simulates the fixed candidate thresholds from each unre-ranked top-two score gap. It retains each threshold's trigger-set digest, trigger rate, MRR@10 and nDCG@10 gain retention, and latency for the complete, triggered, and untriggered query groups.

The raw `report.json`, `queries.jsonl`, and indexes remain under `.cache` and are not committed. The summary records query, qrels, corpus, and index digests so local inputs can be checked. For triggered queries the simulation uses the matching query's `on` ranking and latency; for untriggered queries it uses the `off` ranking and latency. The thresholds selected in the report are also verified through real `auto` runs.

## Two-search evidence collection

`multi-hop-samples.jsonl` contains the original 100 conjunctive questions. Each question combines two different T2Ranking development queries and carries the official positive document IDs for both parts. `multi-hop-deterministic-queries.tsv` and `multi-hop-deterministic-qrels.tsv` flatten the first and complementary searches for the ordinary evaluator. `multi-hop-data-summary.json` records construction parameters and digests.

`multi-hop-semantic-review.jsonl` records the independent Agent review of every original sample under a constrained prompt. Reviewers inspected document text instead of treating official qrels as proof. Only 51 samples passed both subquestions and evidence groups; 49 failed because at least one evidence group did not directly support its subquestion or the subquestion was ill-posed. `multi-hop-semantic-review-summary.json` records the protocol, counts, IDs, and digests. The original dataset is invalid for product-effect claims and remains only as diagnostic input.

`multi-hop-validated-samples.jsonl` is the replacement 100-sample set. `multi-hop-validated-semantic-review.jsonl` records the independent review of its final contents; all 100 samples pass. `multi-hop-validated-queries.tsv` and `multi-hop-validated-qrels.tsv` flatten its two predefined queries, while the `combined` variants contain the complete conjunctive question as one query. `multi-hop-validated-data-summary.json` records construction, review constraints, counts, and file digests.

`multi-hop-baseline-summary.json` records the complete-question single search, the cost-aligned single search, and the two-predefined-query Oracle on the validated samples. `multi-hop-agent-baseline-summary.json` records the tool-enforced single-query Agent and the autonomous Agent, including generated queries, evidence coverage, call distributions, rejected calls, citation checks, latency, and token usage. The older `multi-hop-deterministic-summary.json` and `multi-hop-agent-summary.json` remain diagnostic results for the invalid original samples. Raw model results and session logs remain under `.cache` and `.sessions` and are not committed.

## Second-search decisions

`retrieval-decision-samples.jsonl` contains 100 mixed requests: 25 single-topic, 25 dual-topic, 20 intermediate-fact questions that require an identifier found in the first result, 15 compound questions fully answered by the first result, and 15 questions whose first evidence conflicts. The first two groups reuse the reviewed T2Ranking samples; the other groups use the fixed corpus in `retrieval-decision-controlled-corpus.jsonl`.

`retrieval-decision-data-summary.json` records counts and SHA-256 digests for the samples and controlled corpus. `retrieval-decision-evaluation-summary.json` records real-Loader continue/stop decisions, final evidence coverage, bridge identifiers, conflict handling, call limits, citations, latency, and token usage. Each controlled sample derives an isolated small BM25 index from the fixed corpus without generating Dense vectors. Indexes, raw model outputs, and session logs are not committed.

## Markdown chunking ablation

`markdown-ablation-files.json` fixes 20 repository Markdown files at revision `955a9acb56acfbc9b0c7ff3760550d6819fb2f75`, including each file's SHA-256 and byte count. `markdown-ablation-samples.jsonl` contains 25 manually checked queries, with five each for headings, section bodies, fenced code, cross-chunk evidence, and duplicate headings. Every required phrase was checked against the relevant document at the fixed revision.

`markdown-ablation-evaluation-summary.json` compares a fixed token window, Markdown-aware boundaries without adjacent expansion, and the same Markdown index with one adjacent chunk in each direction. It records build counts and timings plus BM25, Dense, and Hybrid MRR@10, nDCG@10, Recall@5/10/20, evidence completeness, returned tokens, exact duplicate segments, section-path presence, and latency. Ranking metrics use 20 hits; evidence and token metrics use the model tool's default five-hit budget. Indexes, vector caches, expanded corpus text, and per-query output remain under `.cache` and are not committed.
