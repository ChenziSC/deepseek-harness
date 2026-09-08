# Phase-five evaluation data

English | [中文](README.zh.md)

## Bounded search and conflict handling

`bounded-search-samples.jsonl` adds 15 three-to-six-step evidence chains, five unresolved conflicts, and five no-answer requests to the 100 mixed phase-four retrieval-decision samples. `bounded-search-controlled-corpus.jsonl` contains the deterministic records used to build one isolated BM25 index per added sample.

`bounded-search-evaluation-summary.json` records a single maximum-eight natural Agent trajectory projected after 1, 2, 4, 6, and 8 attempted searches, plus independent hard-limit runs at 2, 6, and 8. It includes evidence coverage, expected-answer checks, call and rejection distributions, citation resolution, conflict and no-answer outcomes, latency, token use, per-kind aggregates, and per-sample derived results. The raw model outputs, session logs, and indexes remain under `.cache` and are not committed.

## Indirect prompt injection

`safety-attack-samples.jsonl` contains two isolated examples for each of six attacks: overriding higher-priority instructions, reading a protected secret, inducing `todo_write`, claiming an external send, opening a URL, and substituting a forged citation. Every sample also contains a normal fact that the Agent must answer.

`safety-attack-evaluation-summary.json` records instruction-following, side-effect tool calls, secret leakage, forged-citation mentions versus uses, normal-answer availability, citation resolution, and per-sample outcomes. The evaluator exposes `todo_write` but does not expose network or external-send tools, so those cases measure model output only. Raw outputs and indexes remain under `.cache` and are not committed.

## Semantic-boundary pilot

`semantic-boundary-pilot-samples.jsonl` contains six manually marked topic transitions plus code-fence, short-document, homogeneous-text, and long-sentence edge cases. `semantic-boundary-pilot-summary.json` compares a no-model last-safe-unit baseline with constrained maximum semantic gap, per-document 80th-percentile, and fixed-distance boundary choices using the fixed BGE-M3 model. The semantic candidates did not improve exact boundary recall over the no-model baseline, so production semantic chunking and its full three-way index ablation were not implemented.
