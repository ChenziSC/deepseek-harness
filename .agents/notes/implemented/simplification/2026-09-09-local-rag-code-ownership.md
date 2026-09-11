# Agent Note: Keep local RAG code with one owner

Status: implemented

English | [中文](2026-09-09-local-rag-code-ownership.zh.md)

## Problem

The experimental local RAG package accumulated several independent concerns behind a broad package root and a few large files. [`index-builder.ts`](../../../../packages/experimental/knowledge-local/src/index-builder.ts) contained corpus staging, chunk derivation, Dense payload construction, manifest publication, and Exact-index derivation. [`cli.ts`](../../../../packages/experimental/knowledge-local/src/cli.ts) combined command dispatch with command-specific argument handling. [`sqlite-index.ts`](../../../../packages/experimental/knowledge-local/src/sqlite-index.ts) owned both construction-time writes and runtime reads. Offline contextual-prefix and evaluation algorithms were exported beside the Loader plugin, so tests used the package root as a convenience API and obscured which module owned each behavior.

The duplication check reported 17 clone groups and 214 duplicated lines before the cleanup. The largest repeated paths were the ordinary and Exact-derived index finalization flows, three independent SQLite caches, contextual-prefix scripts, and offline output validation. Adding another retrieval experiment to that structure would have increased the same files and made later deletion harder.

## Decision

The package assigns code to Loader/provider, index construction, CLI adaptation, storage, or offline evaluation before implementation. The standing rules live in [`packages/experimental/knowledge-local/AGENTS.md`](../../../../packages/experimental/knowledge-local/AGENTS.md): a production file receives a responsibility review at 400 lines and splits before an edit expected to take it beyond 500 lines; a second copy triggers an ownership check; a third copy requires a shared implementation or a local explanation; and small repetition does not justify a generic framework or base class.

The package root exports only the Loader `Config`, `LocalKnowledge`, and the default plugin class. Package tests import their owning source modules. The package no longer publishes the development-only `./src/*` subpath. A test fixes the runtime export set and walks the provider and index-builder import graphs to reject dependencies on `src/offline`.

Index construction uses focused modules under [`src/build`](../../../../packages/experimental/knowledge-local/src/build). Ordinary Dense encoding and Exact-vector derivation retain separate Dense operations but run through the same build lifecycle in `index-builder.ts`: corpus staging, document derivation, SQLite writing and closure, payload verification, manifest assembly, and publication. SQLite construction writes live in [`sqlite-writer.ts`](../../../../packages/experimental/knowledge-local/src/sqlite-writer.ts); runtime validation and queries remain in [`sqlite-index.ts`](../../../../packages/experimental/knowledge-local/src/sqlite-index.ts).

The vector, document-derivation, and contextual-prefix caches share only length-delimited SHA-256, digest validation, and immediate transaction primitives in [`cache-primitives.ts`](../../../../packages/experimental/knowledge-local/src/storage/cache-primitives.ts). Their schemas, keys, payload validation, and diagnostics remain independent. The 62-line CLI entry owns only help, dispatch, and uniform error handling; `cli/index.ts` and `cli/derive.ts` own their command-specific defaults, dependency setup, and execution. Command modules share scalar option parsers without a generic CLI framework.

Contextual-prefix generation and retrieval evaluation live under `src/offline`. The obsolete root-level evaluation forwarding module was deleted, so callers import the evaluation owner directly. The legacy in-memory Okapi scorer is retained there for token-level diagnostics and historical comparisons; runtime BM25 and dataset quality baselines use SQLite FTS5. This prevents two scoring implementations from appearing to be equivalent product choices. Tests call the production `buildKnowledgeIndex` entry instead of a test-only BM25 alias, and internal build types and Dense helpers are imported from their owner modules rather than re-exported through `index-builder.ts`.

## Alternatives considered

**Keep the broad package root for test convenience.** This would make internal algorithms look supported and would let tests preserve accidental API surface. Direct source imports make ownership explicit, while the Loader entrypoint stays small and testable.

**Introduce generic cache, CLI, repository, or build frameworks.** The shared behavior is narrower than those abstractions. Frameworks would replace visible repetition with configuration and inheritance that every caller must understand, without a current third use case.

**Delete all failed experiment code.** Contextual-prefix artifacts and the in-memory scorer still reproduce recorded evaluations and provide targeted diagnostics. Keeping them under `src/offline` preserves that value without coupling them to provider configuration, index formats, or root exports.

**Enforce a repository-wide maximum file length.** Line count identifies review points but does not prove mixed responsibility. The rule applies a local 400/500-line trigger and allows cohesive tables, protocol definitions, and offline algorithms when their ownership remains clear.

## Consequences

The package has more internal files and tests use deeper imports, but each file has a narrower reason to change. `index-builder.ts` is 418 lines instead of 1,365 and owns one shared build lifecycle. `cli.ts` is 62 lines instead of 930, with 254-line index and 98-line derive command owners. The SQLite reader is 390 lines with a separate 190-line writer. The former 709-line evaluation module is replaced by six owner modules no larger than 269 lines, with no forwarding file at the package root. The package root is 86 lines and has three runtime exports. The package source totals 10,787 lines, about 20 fewer than before the final redundancy pass, and `pnpm run duplication` reports zero clone groups.

The refactor does not change retrieval defaults, index format 4, SQLite schema 3, cache identities, CLI output, or benchmark conclusions. Offline contextual-prefix planning remains available, but no provider or index-construction dependency reaches it. The structural checks, package tests, Loader snapshot, small index builds, and repository checks pin those claims.
