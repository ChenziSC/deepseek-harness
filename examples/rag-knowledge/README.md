# RAG knowledge example

English | [中文](README.zh.md)

This composition adds the experimental local knowledge provider and `knowledge_search` tool to `headless-agent`. Its checked-in two-document BM25 index is deterministic and needs neither network access nor local model weights.

From the repository root, run:

```sh
pnpm dsh --profile headless --patch "$PWD/examples/rag-knowledge/cordis.yml" "What converts light energy into chemical energy in plants?"
```

The agent model still requires the credentials used by `headless-agent`; only the retrieval path is keyless. The expected evidence is the `photosynthesis` document and its call-local citation is `K1`.
