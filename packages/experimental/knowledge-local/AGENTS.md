# AGENTS.md — Local knowledge provider

These rules supplement the [experimental package rules](../AGENTS.md). The phase-six 6.2 [design](../../../specs/rag/phase-six/rag-plugin-phase-six-two.md) records the first cleanup that established them.

- Assign every change to one owner before implementation: Loader/provider, index build, CLI adaptation, storage, or offline evaluation. A source file must not combine protocol or argument parsing, business execution, persistence, and CLI adaptation.
- Product code may not import `src/offline/`. Offline evaluation may reuse product chunking, indexing, and retrieval code.
- Keep the package root limited to the Loader plugin, its configuration, and symbols with an identified production consumer. Tests import the owning source module instead of expanding the root entrypoint.
- Search for an existing implementation before adding similar logic. At the second copy, decide whether one owner can serve both callers. A third copy requires a shared implementation or a local explanation of why the semantics must remain separate.
- Extract code only when callers share semantics and a reason to change. Do not introduce generic CLI frameworks, cache base classes, repositories, or configuration layers merely to reduce similar lines.
- At 400 lines, review whether a file still has one responsibility. An edit expected to take a production file beyond 500 lines splits it first unless it is a cohesive table, generated source, or single protocol definition; record the exception in the review evidence.
- Failed or product-rejected experiments live under `src/offline/` or repository scripts. They do not add product configuration, provider dependencies, index fields, or root exports.
- End each RAG phase by running relevant coverage and snapshots plus `pnpm run duplication`, `pnpm run hygiene`, and a descending production-file line count. Resolve findings or record a specific reason to retain them; do not evade duplication through cosmetic rewrites or broad ignore regions.
