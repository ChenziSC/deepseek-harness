# @deepseek-ai/dsh-experimental-knowledge-local

[English](README.md) | 中文

[`ctx.knowledge`](../knowledge/README.zh.md) 的实验性本地提供方。它加载一份不可变 BM25 或 BM25 加 Dense 索引，在提供 BM25、Dense 或 Hybrid 查询前校验全部载荷，并提供离线命令 `dsh-knowledge`。

## 运行配置

```yaml
- id: knowledge-local
  name: '@deepseek-ai/dsh-experimental-knowledge-local'
  config:
    indexDir: ./path/to/index
    mode: hybrid
    rerank: false
    candidateCount: 50
    bm25K1: 1.2
    bm25B: 0.75
    rrfK: 60
    modelCacheDir: ./model-cache
    denseModelId: onnx-community/bge-small-en-v1.5-ONNX
    denseModelRevision: 4a9a46c7b88fa408e650a571a1800243f26309bd
    denseDtype: q8
    denseMaxTokens: 512
    rerankerModelId: onnx-community/bge-reranker-v2-m3-ONNX
    rerankerModelRevision: 6f5ff65298512715a1e669753bc754d2bc8f367b
    rerankerDtype: q8
    rerankerBatchSize: 8
    rerankerMaxTokens: 512
```

清单或载荷缺失、损坏、格式不兼容，或者与检索配置不一致时，插件会在启动时失败。Dense、Hybrid 和开启重排序的模式要求显式模型缓存；运行时只从本地加载模型，不会下载缺失文件。不开启重排序的 BM25 模式不需要模型缓存，也不会加载 ONNX 权重。

## 准备 SciFact 与模型

准备命令下载英文 BEIR SciFact 数据集，校验官方 MD5 并报告 SHA-256，同时把两个固定 revision 的 q8 模型写入显式 Transformers.js 缓存：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare scifact \
  --data-dir ./rag-data \
  --model-cache-dir ./model-cache
```

下载后的 q8 权重约为：Dense 检索 32 MiB，重排序 544 MiB；加上 tokenizer 和配置文件后，缓存合计约 594 MiB。

## 构建索引

索引命令会解析严格 JSONL 文档，使用固定 revision 的 BGE tokenizer 分片，构建英文 BM25 倒排表，并可选择为相同分片生成向量；命令先写载荷，最后发布 `manifest.json`：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts index \
  --corpus ./corpus.jsonl \
  --corpus-format scifact \
  --output ./index \
  --model-cache-dir ./model-cache \
  --components bm25,dense \
  --embedding-batch-size 32
```

显式缓存目录中必须已经存在 tokenizer 文件及所请求的 q8 ONNX 权重。使用 `--components bm25` 可构建不加载 ONNX 权重的基线索引。`--corpus-format` 可为 `generic` 或 `scifact`，默认为 `generic`。

通用语料格式为每行一个对象：

```json
{"id":"doc-1","title":"Example","text":"Non-empty body","source":"fixture"}
```

本包还导出严格的 SciFact corpus、query 和 qrels 解析器，供后续评测命令使用。

## 检索行为

`english-v1` 依次执行 Unicode NFKC 规范化、转小写和连续 Unicode 字母或数字提取。查询 token 会去重。Okapi BM25 使用可配置的 `k1` 与 `b`；分数相同时按分片标识的 Unicode code point 顺序排序。`explainBm25` 提供仅供本地使用的 token 与词项贡献诊断。

Dense 模式使用固定 revision 的 `onnx-community/bge-small-en-v1.5-ONNX` q8 模型。文档输入由标题、换行和正文组成，查询输入添加 BGE 检索前缀。输入从右侧截断到最多 512 个模型 token，向量使用 CLS pooling 和 L2 归一化，检索执行精确 float32 点积扫描。`dense.f32le` 按分片顺序保存 384 个小端数值。

Hybrid 模式依次执行 BM25 和 Dense，每路最多取 `candidateCount` 条结果，再用 Reciprocal Rank Fusion 融合并集。`rrfK` 默认为 60；平局时依次比较更优的单路名次和分片标识的 Unicode code point 顺序。任一路失败都会使请求失败，不返回部分结果。

重排序可分别为 BM25、Dense 和 Hybrid 开启。固定 revision 的 `onnx-community/bge-reranker-v2-m3-ONNX` q8 交叉编码器每批处理 8 个查询与候选文本对，最多使用 512 token，按原始 logit 排序，logit 相同时保持召回顺序。

## 评测 SciFact

评测命令会运行 BM25、Dense、Hybrid 以及它们各自的重排序版本，把分片命中折叠为唯一文档，并写入 Recall、MRR、nDCG、Success 和延迟数据：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts evaluate \
  --index ./index \
  --queries ./rag-data/scifact/queries.jsonl \
  --qrels ./rag-data/scifact/qrels/test.tsv \
  --model-cache-dir ./model-cache \
  --max-results 20 \
  --output ./report
```

六组实验使用相同的 50 条召回深度。预热查询不计入延迟统计；某个组合失败时会记录错误，不计算该组合的部分平均值。

## 模型体验

通过知识消费方间接影响模型；消费方可公开本提供方排序后的标题、来源标签和分片正文，但检索分数与诊断保留在本地。

#### KV Cache 影响

本提供方不会直接导致 KV Cache 失效；请求前缀变更由消费方负责，检索证据追加在该前缀之后。

## 已知限制与后续工作

- SciFact 只包含英文科学主张与摘要；其结果不能证明中文检索质量或通用领域效果。
- 544 MiB 的重排序模型比 BM25 或 32 MiB 的 embedding 模型更慢、内存占用更高；本包不增加推理队列或资源调度器。
- Transformers.js 不提供 token offset，因此分片回退通过重复计算 tokenizer 数量定位原文边界。对固定 tokenizer 而言结果确定，但它不是适用于任意 tokenizer 的通用 offset API。
- 索引构建允许目标目录不存在或为空；失败后可能留下不含完整清单的载荷，不提供目录级原子替换与恢复。
- 默认分析器是英文教学基线，不做词干化、停用词移除和同义词扩展。
