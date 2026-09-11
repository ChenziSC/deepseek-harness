# @deepseek-ai/dsh-experimental-knowledge-local

[English](README.md) | 中文

[`ctx.knowledge`](../knowledge/README.zh.md) 的实验性本地提供方。它加载一份不可变 BM25 或 BM25 加 Dense 索引，在提供 BM25、Dense 或 Hybrid 查询前校验全部载荷，并提供离线命令 `dsh-knowledge`。

包根仅导出 Loader `Config`、`LocalKnowledge` 和默认插件类。索引构建、数据集解析、评测与诊断算法属于内部实现模块，不是受支持的包根 API。

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
  --chunking-strategy markdown-structure-v1 \
  --dense-index auto \
  --sqlite-batch-size 500 \
  --embedding-batch-size 32 \
  --derived-cache-dir ./document-cache \
  --vector-cache-dir ./vector-cache
```

显式模型缓存目录中必须已经存在 tokenizer 文件及所请求的 q8 ONNX 权重。使用 `--components bm25` 可构建不加载 ONNX 权重的基线索引。`--corpus-format` 可为 `generic`、`scifact`、`mldr` 或 `t2ranking`。`--chunking-strategy` 可为默认的 `markdown-structure-v1` 或固定边界的 `token-window-v1`；后者不生成章节路径，主要用于受控对照。索引格式 4 在 `knowledge.sqlite` 中分别保存文档元数据、按 ordinal 对齐的分片和 BM25 数据；清单记录所选分片策略、语料的粗粒度 Latin/CJK 脚本画像和固定文档元数据 schema。`auto` 在 `vectorCount × dimensions` 不超过 `50,000,000` 时生成 Exact-only，否则生成 HNSW-only；`exact` 和 `hnsw` 分别只保留一种载荷，`both` 同时保留 `dense.f32le` 和 `dense.usearch`。交互终端会在 embedding 前显示准确规模、预计体积和推荐模式并请求确认；非交互命令确定性采用推荐值。运行时以只读方式打开 SQLite，启动时校验载荷类型与大小，通过 `dsh-knowledge verify` 重算摘要，并仅在请求需要时加载 Exact 向量或 HNSW 图。旧格式索引会被拒绝并需要重新构建；未改变的 Dense 输入仍可复用独立向量缓存。

`--derived-cache-dir` 启用独立的 SQLite 文档派生缓存，保存每篇文档的完整分片、Dense 输入和已分析 BM25 文本。缓存键覆盖 tokenizer revision、分片配置、分析器 revision、文档 id、标题和正文；来源、版本、有效期和替代关系不影响检索文本，因此不进入键，而是在目标文档行中使用当前值。命中后会跳过 tokenizer、分片器和 BM25 分析器，但构建器仍会重新分配全局 ordinal 并写出完整新索引。缓存损坏会带具体键使构建失败，不会作为普通未命中继续。最终 JSON 的 `documentBuild` 对象报告文档与分片复用数量以及各阶段耗时。

`--vector-cache-dir` 独立启用构建期 SQLite 向量缓存，缓存键由完整 Dense 配置以及准确的标题、章节路径和分片正文输入共同生成。新增、删除文档、ordinal 变化或只修改来源及版本元数据后，未改变的输入会复用逐字节一致的 float32 向量；重复输入只编码一次。`--import-vectors-from` 会先验证格式 4 索引及全部载荷摘要，要求源索引保留 Dense 配置一致的 Exact `dense.f32le`，并在不修改源索引的情况下导入向量。每个成功的 embedding 批次会先提交到缓存，再组装目标载荷，因此中断后的新构建可以复用已完成批次。最终 JSON 的 `denseBuild` 对象包含缓存命中数、编码输入数、复用率、导入向量数和各阶段耗时。每个目标仍会重新构建 SQLite、按新 ordinal 排列 Exact 向量并完整重建可选 HNSW 图，最后才发布清单。

### 上下文前缀评测工具

上下文前缀仅保留为离线评测工具。普通 `index` 命令不能消费生成记录，也不会读取前缀凭据或调用大模型。`contextual-statistics` 扫描每篇源文档，只写入检测器、批处理和 token 上界的聚合统计；它不创建 SQLite、BM25、Exact、HNSW、生成前缀或向量产物。默认的 `--sample-modulus 1` 会对每篇文档执行 tokenizer；更大的值仍会完整读取、校验并计算语料摘要和文档数，但只对按文档 ID 摘要确定性选出的子集进行分片，再估算分片级总量。`contextual-plan` 用于有限评测语料，写出不调用模型的可复核计划。每个请求除了配置的前缀正文额度，还会预留128个输出 token，用于 JSON 结构和供应商计入输出用量的推理过程。`contextual-generate` 读取该计划，并要求显式提供 OpenAI-compatible 地址、固定模型身份、缓存目录和累计 token 预算。API key 从指定环境变量读取，不写入计划、缓存、生成记录或错误。

```sh
dsh-knowledge contextual-statistics --corpus ./corpus.jsonl --output ./statistics --model-cache-dir ./model-cache --target dense --max-candidate-ratio 0.15 --max-prefix-tokens 80 --context-window-tokens 1024 --max-chunks-per-request 4 --prompt-version context-prefix-v5 --sample-modulus 100
dsh-knowledge contextual-plan --corpus ./evaluation-subset.jsonl --output ./plan --model-cache-dir ./model-cache --target dense --max-candidate-ratio 0.15 --max-input-tokens 1000000 --max-output-tokens 100000 --max-prefix-tokens 80 --context-window-tokens 1024 --max-chunks-per-request 4 --budget-action deterministic-fallback --prompt-version context-prefix-v5
dsh-knowledge contextual-generate --plan ./plan/contextual-prefix-plan.json --output ./records --cache-dir ./prefix-cache --model-cache-dir ./model-cache --base-url https://api.example/v1 --api-key-env PREFIX_API_KEY --model-id fixed-model --revision fixed-revision --reasoning-effort minimal --max-input-tokens 1000000 --max-output-tokens 100000 --budget-action deterministic-fallback
```

真实语料评测未达到成本、检索质量、生成成功率和事实性门槛，因此生产索引命令不接受生成记录。这些工具只用于复现实验，不改变索引格式或运行时检索行为。

通用语料格式为每行一个对象：

```json
{"id":"policy-v2","title":"Example","text":"Non-empty body","source":"fixture","sourceVersion":"2","validFrom":"2026-01-01T00:00:00Z","validUntil":"2027-01-01T00:00:00Z","supersedes":"policy-v1"}
```

评测命令使用严格的 SciFact、MLDR、T2Ranking 和 MLQA Retrieval 解析器。

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
  --derived-cache-dir ./document-cache \
  --dense-index both
```

派生过程重新构建 SQLite FTS 和可选 HNSW 载荷，按有限批次复制 Exact 向量；目标的分片身份、检索文本、分析器、tokenizer 或分片配置只要与源索引 ordinal 前缀不一致，命令就会失败。该流程不修改索引格式 4，也不会调用 Dense 编码器。

## 检索行为

每次请求可以在提供方允许集合内选择自动路由或 BM25、Dense、Hybrid 召回、Exact 或 HNSW Dense 检索以及是否重排序。省略召回选项时默认使用 `auto`：URL、路径、代码式标识符、长数字和十六进制标识符走 BM25，其他查询走 Dense。Hybrid 保留为显式选择。首选路径不在允许集合内时，提供方按固定顺序选择最接近的允许路径；显式高层选择会覆盖自动路由。搜索结果包含实际执行的具体策略。面向模型的工具不公开候选数、融合权重、阈值、模型路径或 HNSW 参数。

可选的 `asOf` 接受带明确时区、精确到毫秒的 RFC 3339 时间；省略时每次请求只读取一次当前时间。文档在 `validFrom` 缺失或不晚于查询时点，并且 `validUntil` 缺失或晚于查询时点时可检索；有效期未知的文档仍可检索。BM25 在候选上限之前应用该条件，Exact 在扫描时跳过无效 ordinal，HNSW 在有效候选不足时成倍扩大近邻数量直到满足上限或搜索完整图，Hybrid 只融合过滤后的候选。`supersedes` 只是证据元数据，不会隐藏另一篇文档，也不参与排序。

默认分片器优先使用 Markdown ATX 标题边界，其次使用段落与句子边界；围栏代码块会保持完整，除非单个代码块超过 token 上限。每个分片的有效标题路径会同时进入 BM25 与 Dense 索引。Token 窗口策略只使用 tokenizer 的硬上限和配置的 overlap。完成排序后，`adjacentChunkCount: 1` 最多附加命中块前后各一个同文档分片，删除由 overlap 产生的重复文本，并且不改变结果数量与排序指标；设为 `0` 可关闭扩展并减少返回上下文。

`mixed-zh-en-v1` 执行 Unicode NFKC 规范化，将 ASCII 单词转为小写，保留数字和下划线，并生成中文 unigram 与 bigram 词项。查询词项会去重。运行时 BM25 使用 SQLite FTS5 的固定评分参数；分数相同时按分片标识的 Unicode code point 顺序排序。`english-v1` 继续用于复现第一阶段英文实验。

早期内存 Okapi 评分器仅保留在 `src/offline/evaluation`，用于词项级诊断和受控历史对照。产品检索和数据集质量基线均使用 SQLite FTS5。

Dense 模式使用固定 revision 的 `onnx-community/bge-m3-ONNX` q8 权重。文档输入由标题和正文组成，输入从右侧截断到配置的模型 token 上限，1024 维 CLS 向量经过 L2 归一化。Exact 扫描 `dense.f32le`；HNSW 使用持久化 USearch 图、ordinal 键和配置的 `hnswExpansionSearch`。

Hybrid 模式依次执行 BM25 和 Dense，每路最多取 `candidateCount` 条结果，再用 Reciprocal Rank Fusion 融合并集。`rrfK` 默认为 60；平局时依次比较更优的单路名次和分片标识的 Unicode code point 顺序。任一路失败都会使请求失败，不返回部分结果。

BM25、Dense 和 Hybrid 都可独立选择重排序模式。`off` 不加载交叉编码器，`on` 对每个非空候选集执行重排序，`auto` 仅在前两名候选的归一化分差低于 `adaptiveRerankMinScoreGapRatio` 时执行；该阈值默认为 `0.15`。召回默认保留 50 条候选，交叉编码器默认只重排前 20 条，再按原召回顺序附加剩余候选；开发者可以覆盖这两个值。固定 revision 的 `onnx-community/bge-reranker-v2-m3-ONNX` q8 模型每批处理 8 个查询与候选文本对，最多使用 512 token，按原始 logit 排序，logit 相同时保持召回顺序。

## 评测数据集

评测命令按需运行自动、BM25、Dense 和 Hybrid 组合，把分片命中折叠为唯一文档，并写入 Recall、MRR、nDCG、Success、延迟、载荷体积和 HNSW 相对 Exact 的召回率：

```sh
pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts evaluate \
  --index ./index \
  --queries ./rag-data/scifact/queries.jsonl \
  --qrels ./rag-data/scifact/qrels/test.tsv \
  --model-cache-dir ./model-cache \
  --max-results 20 \
  --candidate-count 50 \
  --reranker-candidate-count 20 \
  --modes auto,bm25,dense,hybrid \
  --dense-indexes exact,hnsw \
  --rerank off,auto,on \
  --adaptive-rerank-min-score-gap-ratio 0.02 \
  --output ./report
```

`--dataset` 可为 `scifact`、`mldr`、`t2ranking` 或 `mlqa`；`--query-limit` 用于明确标注的样本评测。`--modes auto` 允许 BM25、Dense 和 Hybrid，并记录每条查询实际采用的路径；固定模式会把提供方限制为对应路径。`--candidate-count` 控制召回深度，`--reranker-candidate-count` 控制其中进入交叉编码器的前部候选，`--adaptive-rerank-min-score-gap-ratio` 为一次运行选择阈值。`report.json` 保留聚合指标和实际路由数量；`queries.jsonl` 记录每条计量查询的请求与实际策略、相关和排序文档、单查询指标、延迟，以及返回分数未被重排序替换时的召回前两名分差。BM25-only 索引可以运行只含 BM25 的矩阵。预热查询不进入两种输出；某个组合失败时会记录错误，不计算该组合的部分平均值，查询失败也会在该组合停止前写入一条 JSONL 失败记录。

## 模型体验

通过知识消费方间接影响模型；消费方可公开本提供方排序后的标题、章节路径、来源标签、来源版本、有效期、替代关系、命中分片和可选相邻上下文，但检索分数与诊断保留在本地。

#### KV Cache 影响

本提供方不会直接导致 KV Cache 失效；请求前缀变更由消费方负责，检索证据追加在该前缀之后。

## 已知限制与后续工作

- 单一基准不能证明通用领域质量。SciFact 是英文数据，MLDR 是合成长文档检索，T2Ranking 是中文数据，MLQA Retrieval `eng-zho` 覆盖中文查询检索英文段落。
- BGE-M3 与 Reranker 模型都超过 500 MiB。CPU 推理，尤其是重排序和大规模语料的离线编码，比 BM25 更慢且占用更多内存；本包不增加推理队列或资源调度器。
- Transformers.js 不提供 token offset，因此分片回退通过每个分片附近的有限范围 tokenizer 计数定位原文边界，并记录累积的局部 token 位置。对固定 tokenizer 而言结果确定，但它不是适用于任意 tokenizer 的通用 offset API。
- 索引构建允许目标目录不存在或为空；失败后会留下未发布的不完整目录，不提供目录级原子替换与恢复。存储空间有限时，完整基准索引应按顺序构建、评测和删除，而不是全部长期保留。
- 文档缓存和向量缓存只加速可准确复用的计算，不会增量更新最终 SQLite、Exact 顺序或 HNSW 图；每个目标仍是完整的不可变索引。
- 当高排名向量中有较多记录在查询时点无效时，HNSW 有效期过滤可能逐步搜索更大的近邻集合；它不会退回无效候选。
- 中英文混合分析器保持确定且不依赖词典；它不提供词典分词、词干化、停用词、同义词或学习型稀疏检索。
- 自动路由和自适应重排序使用确定性启发式规则，而不是学习型分类器；部署可以覆盖高层请求或提供方阈值。
- 上下文前缀生成是离线评测工具，不是索引或在线检索能力。真实语料评测未通过发布门槛；完整语料统计不表示允许为完整语料生成前缀。
