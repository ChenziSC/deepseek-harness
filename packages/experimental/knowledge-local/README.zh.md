# @deepseek-ai/dsh-experimental-knowledge-local

[English](README.md) | 中文

[`ctx.knowledge`](../knowledge/README.zh.md) 的实验性本地提供方。它加载一份不可变 BM25 或 BM25 加 Dense 索引，在提供 BM25、Dense 或 Hybrid 查询前校验全部载荷，并提供离线命令 `dsh-knowledge`。

## 运行配置

```yaml
- id: knowledge-local
  name: '@deepseek-ai/dsh-experimental-knowledge-local'
  config:
    indexDir: ./path/to/index
    defaultRetrieval: hybrid
    defaultDenseIndex: auto
    defaultRerank: off
    allowedRetrieval: [bm25, dense, hybrid]
    allowedDenseIndexes: [exact, hnsw]
    allowedRerank: true
    candidateCount: 50
    rerankerCandidateCount: 20
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

清单或载荷缺失、损坏、格式不兼容，或者无法支持全部允许策略时，插件会在启动时失败。允许 Dense、Hybrid 或重排序请求时要求显式模型缓存；运行时只从本地加载模型，不会下载缺失文件。只允许 BM25 且禁用重排序时不需要模型缓存，也不会加载 ONNX 权重。

## 准备基准数据与模型

SciFact 准备命令校验官方归档摘要，并把固定 revision 的 BGE-M3 与 Reranker q8 模型写入显式 Transformers.js 缓存：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare scifact \
  --data-dir ./rag-data \
  --model-cache-dir ./model-cache
```

MLDR、T2Ranking 和 MLQA Retrieval 使用固定 Hugging Face revision，并把来源 URL、许可证、大小和 SHA-256 写入 `source.json`：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare mldr --language zh --data-dir ./rag-data
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare t2ranking --data-dir ./rag-data
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare mlqa-eng-zho --data-dir ./rag-data
```

BGE-M3 与 Reranker 的 q8 权重分别约为 542 MiB 和 544 MiB。基准数据和模型属于本地实验输入，不提交到仓库。

## 构建索引

索引命令通过固定大小的 SQLite 事务流式解析文档，使用固定 revision 的 BGE-M3 tokenizer 分片，构建指定的 FTS5 分析器，并可选择按批次为相同分片生成向量；命令先写载荷，最后发布 `manifest.json`：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts index \
  --corpus ./corpus.jsonl \
  --corpus-format scifact \
  --output ./index \
  --model-cache-dir ./model-cache \
  --components bm25,dense \
  --analyzer mixed-zh-en-v1 \
  --dense-index auto \
  --sqlite-batch-size 500 \
  --embedding-batch-size 32
```

显式缓存目录中必须已经存在 tokenizer 文件及所请求的 q8 ONNX 权重。使用 `--components bm25` 可构建不加载 ONNX 权重的基线索引。`--corpus-format` 可为 `generic`、`scifact`、`mldr` 或 `t2ranking`。索引格式 2 把分片元数据和 BM25 数据保存在 `knowledge.sqlite`。`auto` 在 `vectorCount × dimensions` 不超过 `50,000,000` 时生成 Exact-only，否则生成 HNSW-only；`exact` 和 `hnsw` 分别只保留一种载荷，`both` 同时保留 `dense.f32le` 和 `dense.usearch`。交互终端会在 embedding 前显示准确规模、预计体积和推荐模式并请求确认；非交互命令确定性采用推荐值。运行时以只读方式打开 SQLite，启动时校验载荷类型与大小，通过 `dsh-knowledge verify` 重算摘要，并仅在请求需要时加载 Exact 向量或 HNSW 图。

通用语料格式为每行一个对象：

```json
{"id":"doc-1","title":"Example","text":"Non-empty body","source":"fixture"}
```

本包还导出严格的 SciFact、MLDR、T2Ranking 和 MLQA Retrieval 解析器，供评测命令使用。

## 检索行为

每次请求可以在提供方允许集合内选择 BM25、Dense 或 Hybrid 召回、Exact 或 HNSW Dense 检索以及是否重排序。省略的字段使用 `defaultRetrieval`、`defaultDenseIndex` 和 `defaultRerank`；默认值分别为 Hybrid、索引清单记录的自动 Dense 选择和关闭重排序。搜索结果包含解析后的策略。面向模型的工具只公开这些高层选项，不公开候选数、融合权重、阈值、模型路径或 HNSW 参数。

`mixed-zh-en-v1` 执行 Unicode NFKC 规范化，将 ASCII 单词转为小写，保留数字和下划线，并生成中文 unigram 与 bigram 词项。查询词项会去重。运行时 BM25 使用 SQLite FTS5 的固定评分参数；分数相同时按分片标识的 Unicode code point 顺序排序。`english-v1` 继续用于复现第一阶段英文实验。

Dense 模式使用固定 revision 的 `onnx-community/bge-m3-ONNX` q8 权重。文档输入由标题和正文组成，输入从右侧截断到配置的模型 token 上限，1024 维 CLS 向量经过 L2 归一化。Exact 扫描 `dense.f32le`；HNSW 使用持久化 USearch 图、ordinal 键和配置的 `hnswExpansionSearch`。

Hybrid 模式依次执行 BM25 和 Dense，每路最多取 `candidateCount` 条结果，再用 Reciprocal Rank Fusion 融合并集。`rrfK` 默认为 60；平局时依次比较更优的单路名次和分片标识的 Unicode code point 顺序。任一路失败都会使请求失败，不返回部分结果。

重排序可分别为 BM25、Dense 和 Hybrid 开启。召回默认保留 50 条候选，交叉编码器默认只重排前 20 条，再按原召回顺序附加剩余候选；`rerankerCandidateCount` 可由开发者覆盖。固定 revision 的 `onnx-community/bge-reranker-v2-m3-ONNX` q8 模型每批处理 8 个查询与候选文本对，最多使用 512 token，按原始 logit 排序，logit 相同时保持召回顺序。

## 评测数据集

评测命令按需运行 BM25、Dense 和 Hybrid 组合，把分片命中折叠为唯一文档，并写入 Recall、MRR、nDCG、Success、延迟、载荷体积和 HNSW 相对 Exact 的召回率：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts evaluate \
  --index ./index \
  --queries ./rag-data/scifact/queries.jsonl \
  --qrels ./rag-data/scifact/qrels/test.tsv \
  --model-cache-dir ./model-cache \
  --max-results 20 \
  --candidate-count 50 \
  --reranker-candidate-count 20 \
  --modes bm25,dense,hybrid \
  --dense-indexes exact,hnsw \
  --rerank off,on \
  --output ./report
```

`--dataset` 可为 `scifact`、`mldr`、`t2ranking` 或 `mlqa`；`--query-limit` 用于明确标注的样本评测。`--candidate-count` 控制召回深度，`--reranker-candidate-count` 控制其中进入交叉编码器的前部候选。BM25-only 索引可以运行只含 BM25 的矩阵。预热查询不计入延迟统计；某个组合失败时会记录错误，不计算该组合的部分平均值。

## 模型体验

通过知识消费方间接影响模型；消费方可公开本提供方排序后的标题、来源标签和分片正文，但检索分数与诊断保留在本地。

#### KV Cache 影响

本提供方不会直接导致 KV Cache 失效；请求前缀变更由消费方负责，检索证据追加在该前缀之后。

## 已知限制与后续工作

- 单一基准不能证明通用领域质量。SciFact 是英文数据，MLDR 是合成长文档检索，T2Ranking 是中文数据，MLQA Retrieval `eng-zho` 覆盖中文查询检索英文段落。
- BGE-M3 与 Reranker 模型都超过 500 MiB。CPU 推理，尤其是重排序和大规模语料的离线编码，比 BM25 更慢且占用更多内存；本包不增加推理队列或资源调度器。
- Transformers.js 不提供 token offset，因此分片回退通过每个分片附近的有限范围 tokenizer 计数定位原文边界，并记录累积的局部 token 位置。对固定 tokenizer 而言结果确定，但它不是适用于任意 tokenizer 的通用 offset API。
- 索引构建允许目标目录不存在或为空；失败后会留下未发布的不完整目录，不提供目录级原子替换与恢复。存储空间有限时，完整基准索引应按顺序构建、评测和删除，而不是全部长期保留。
- 中英文混合分析器保持确定且不依赖词典；它不提供词典分词、词干化、停用词、同义词或学习型稀疏检索。
