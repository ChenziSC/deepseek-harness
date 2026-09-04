# experimental/ — private experimental packages

English | [中文](README.zh.md)

This group contains prototypes and internal-only Cordis plugins that use the repository's real runtime without joining an official release. Its packages are private, carry no stability or support promise, and retain the same engineering, security, documentation, lifecycle, testing, and snapshot requirements as release packages.

| Package | Role | ctx key |
|---|---|---|
| `agent-team/` | Implicit-root Agent Teams roster, durable peer mailbox, shared task DAG, and runtime coordination | `ctx.agentTeams` |
| `knowledge/` | Provider-neutral read-only external knowledge retrieval Service Definition | `ctx.knowledge` |
| `knowledge-local/` | Immutable local BM25 and Dense knowledge provider and offline index command | `ctx.knowledge` |
| `tool-agent-team/` | Scoped model-facing Agent Teams tools and collaboration guidance | — |
| `tool-knowledge/` | Bounded model-facing `knowledge_search` Consumer | — |

The [subtree rules](AGENTS.md) define dependency isolation, release exclusion, and promotion.
