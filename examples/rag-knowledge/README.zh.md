# RAG knowledge 示例

[English](README.md) | 中文

该组合在 `headless-agent` 上增加实验性本地知识提供方和 `knowledge_search` 工具。仓库内附带的两文档 BM25 索引是确定性的，不需要网络或本地模型权重。

在仓库根目录运行：

```sh
pnpm dsh --profile headless --patch "$PWD/examples/rag-knowledge/cordis.yml" "What converts light energy into chemical energy in plants?"
```

agent 模型仍需要 `headless-agent` 使用的凭证；只有检索路径本身不需要密钥。预期证据是 `photosynthesis` 文档，其本次调用内引用编号为 `K1`。
