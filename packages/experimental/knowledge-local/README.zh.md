# @deepseek-ai/dsh-experimental-knowledge-local

[English](README.md) | 中文

[`ctx.knowledge`](../knowledge/README.zh.md) 的实验性本地提供方。它加载一份不可变 BM25 或 BM25 加 Dense 索引，在提供 BM25、Dense 或 Hybrid 查询前校验全部载荷，并提供离线命令 `dsh-knowledge`。

## 运行配置

```yaml
- id: knowledge-local
  name: '@deepseek-ai/dsh-experimental-knowledge-local'
  config:
    indexDir: ./path/to/index
    defaultRetrieval: auto
    defaultDenseIndex: auto
    defaultRerank: off
    allowedRetrieval: [bm25, dense, hybrid]
    allowedDenseIndexes: [exact, hnsw]
    allowedRerank: true
    candidateCount: 50
    rerankerCandidateCount: 20
    adaptiveRerankMinScoreGapRatio: 0.15
    adjacentChunkCount: 1
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

显式缓存目录中必须已经存在 tokenizer 文件及所请求的 q8 ONNX 权重。使用 `--components bm25` 可构建不加载 ONNX 权重的基线索引。`--corpus-format` 可为 `generic`、`scifact`、`mldr` 或 `t2ranking`。索引格式 3 把分片元数据、Markdown 章节路径和 BM25 数据保存在 `knowledge.sqlite`，清单记录语料的粗粒度 Latin/CJK 脚本画像。`auto` 在 `vectorCount × dimensions` 不超过 `50,000,000` 时生成 Exact-only，否则生成 HNSW-only；`exact` 和 `hnsw` 分别只保留一种载荷，`both` 同时保留 `dense.f32le` 和 `dense.usearch`。交互终端会在 embedding 前显示准确规模、预计体积和推荐模式并请求确认；非交互命令确定性采用推荐值。运行时以只读方式打开 SQLite，启动时校验载荷类型与大小，通过 `dsh-knowledge verify` 重算摘要，并仅在请求需要时加载 Exact 向量或 HNSW 图。

通用语料格式为每行一个对象：

```json
{"id":"doc-1","title":"Example","text":"Non-empty body","source":"fixture"}
```

本包还导出严格的 SciFact、MLDR、T2Ranking 和 MLQA Retrieval 解析器，供评测命令使用。

## 校准 Exact/HNSW 阈值

阈值实验使用固定版本的 T2Ranking 开发集文件和官方 `dev.bm25.tsv` 结果。`slice` 保留前若干查询的全部正例，再按名次和查询顺序加入全局去重的 BM25 困难负例，并通过补零文档标识保证各档语料在构建索引后仍形成相同的 ordinal 前缀：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts slice \
  --collection ./rag-data/t2ranking/collection.tsv \
  --queries ./rag-data/t2ranking/queries.dev.tsv \
  --qrels ./rag-data/t2ranking/qrels.retrieval.dev.tsv \
  --bm25-run ./rag-data/t2ranking/dev.bm25.tsv \
  --model-cache-dir ./model-cache \
  --output ./threshold-slices
```

最大档使用 `--dense-index both` 完整构建一次后，可以在不加载嵌入模型的情况下派生较小的对照索引：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts derive \
  --source-index ./index-100000 \
  --corpus ./threshold-slices/chunks-10000/corpus.tsv \
  --output ./index-10000 \
  --model-cache-dir ./model-cache \
  --dense-index both
```

派生过程重新构建 SQLite FTS 和可选 HNSW 载荷，按有限批次复制 Exact 向量；目标的分片身份、检索文本、分析器、tokenizer 或分片配置只要与源索引 ordinal 前缀不一致，命令就会失败。该流程不修改索引格式 3，也不会调用 Dense 编码器。

## 检索行为

每次请求可以在提供方允许集合内选择自动路由或 BM25、Dense、Hybrid 召回、Exact 或 HNSW Dense 检索以及是否重排序。省略召回选项时默认使用 `auto`：URL、路径、代码式标识符、长数字和十六进制标识符走 BM25；Latin 查询面对 CJK 语料或 CJK 查询面对 Latin 语料时走 Dense；其他查询走 Hybrid。首选路径不在允许集合内时，提供方按固定顺序选择最接近的允许路径；显式高层选择会覆盖自动路由。搜索结果包含实际执行的具体策略。面向模型的工具不公开候选数、融合权重、阈值、模型路径或 HNSW 参数。

分片器优先使用 Markdown ATX 标题边界，其次使用段落与句子边界；围栏代码块会保持完整，除非单个代码块超过 token 上限。每个分片的有效标题路径会同时进入 BM25 与 Dense 索引。完成排序后，`adjacentChunkCount: 1` 最多附加命中块前后各一个同文档分片，删除由 overlap 产生的重复文本，并且不改变结果数量与排序指标；设为 `0` 可关闭扩展。

`mixed-zh-en-v1` 执行 Unicode NFKC 规范化，将 ASCII 单词转为小写，保留数字和下划线，并生成中文 unigram 与 bigram 词项。查询词项会去重。运行时 BM25 使用 SQLite FTS5 的固定评分参数；分数相同时按分片标识的 Unicode code point 顺序排序。`english-v1` 继续用于复现第一阶段英文实验。

Dense 模式使用固定 revision 的 `onnx-community/bge-m3-ONNX` q8 权重。文档输入由标题和正文组成，输入从右侧截断到配置的模型 token 上限，1024 维 CLS 向量经过 L2 归一化。Exact 扫描 `dense.f32le`；HNSW 使用持久化 USearch 图、ordinal 键和配置的 `hnswExpansionSearch`。

Hybrid 模式依次执行 BM25 和 Dense，每路最多取 `candidateCount` 条结果，再用 Reciprocal Rank Fusion 融合并集。`rrfK` 默认为 60；平局时依次比较更优的单路名次和分片标识的 Unicode code point 顺序。任一路失败都会使请求失败，不返回部分结果。

BM25、Dense 和 Hybrid 都可独立选择重排序模式。`off` 不加载交叉编码器，`on` 对每个非空候选集执行重排序，`auto` 仅在前两名候选的归一化分差低于 `adaptiveRerankMinScoreGapRatio` 时执行；该阈值默认为 `0.15`。召回默认保留 50 条候选，交叉编码器默认只重排前 20 条，再按原召回顺序附加剩余候选；开发者可以覆盖这两个值。固定 revision 的 `onnx-community/bge-reranker-v2-m3-ONNX` q8 模型每批处理 8 个查询与候选文本对，最多使用 512 token，按原始 logit 排序，logit 相同时保持召回顺序。

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
  --rerank off,auto,on \
  --output ./report
```

`--dataset` 可为 `scifact`、`mldr`、`t2ranking` 或 `mlqa`；`--query-limit` 用于明确标注的样本评测。`--candidate-count` 控制召回深度，`--reranker-candidate-count` 控制其中进入交叉编码器的前部候选。报告会记录请求的重排序模式和实际触发比例。BM25-only 索引可以运行只含 BM25 的矩阵。预热查询不计入延迟统计；某个组合失败时会记录错误，不计算该组合的部分平均值。

## 模型体验

通过知识消费方间接影响模型；消费方可公开本提供方排序后的标题、章节路径、来源标签、命中分片和可选相邻上下文，但检索分数与诊断保留在本地。

#### KV Cache 影响

本提供方不会直接导致 KV Cache 失效；请求前缀变更由消费方负责，检索证据追加在该前缀之后。

## 已知限制与后续工作

- 单一基准不能证明通用领域质量。SciFact 是英文数据，MLDR 是合成长文档检索，T2Ranking 是中文数据，MLQA Retrieval `eng-zho` 覆盖中文查询检索英文段落。
- BGE-M3 与 Reranker 模型都超过 500 MiB。CPU 推理，尤其是重排序和大规模语料的离线编码，比 BM25 更慢且占用更多内存；本包不增加推理队列或资源调度器。
- Transformers.js 不提供 token offset，因此分片回退通过每个分片附近的有限范围 tokenizer 计数定位原文边界，并记录累积的局部 token 位置。对固定 tokenizer 而言结果确定，但它不是适用于任意 tokenizer 的通用 offset API。
- 索引构建允许目标目录不存在或为空；失败后会留下未发布的不完整目录，不提供目录级原子替换与恢复。存储空间有限时，完整基准索引应按顺序构建、评测和删除，而不是全部长期保留。
- 向量复用只支持确定性的 ordinal 前缀；任意文档子集仍需重新生成嵌入，或使用单独的按身份映射派生工具。
- 中英文混合分析器保持确定且不依赖词典；它不提供词典分词、词干化、停用词、同义词或学习型稀疏检索。
- 自动路由和自适应重排序使用确定性启发式规则，而不是学习型分类器；部署可以覆盖高层请求或提供方阈值。
