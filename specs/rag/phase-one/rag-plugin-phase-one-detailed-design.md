# DSH RAG 插件第一阶段详细设计

## 1. 文档职责

本文把[概要设计](rag-plugin-phase-one.md)确定的范围和 E1 工程边界落实为可编码的包结构、公共接口、索引文件、运行流程、配置和测试接口。[实施任务](rag-plugin-phase-one-implementation-tasks.md)负责交付顺序和每项任务的完成条件，不在本文记录进度。

概要设计拥有阶段范围、算法选择和验收标准；本文拥有接口与数据格式。实施中发现两者冲突时先更新概要设计，再同步本文和任务清单。

## 2. 运行组成

第一阶段由三个实验包和一个示例组成：

| 路径 | npm 包 | 类型 | 运行职责 |
| --- | --- | --- | --- |
| `packages/experimental/knowledge` | `@deepseek-ai/dsh-experimental-knowledge` | Service Definition | 定义抽象 `Knowledge`、`ctx.knowledge` 和提供方无关类型 |
| `packages/experimental/knowledge-local` | `@deepseek-ai/dsh-experimental-knowledge-local` | Service Provider | 默认导出 `LocalKnowledge`，加载索引并执行召回、融合与重排序；提供离线命令 |
| `packages/experimental/tool-knowledge` | `@deepseek-ai/dsh-experimental-tool-knowledge` | Consumer | 注册 `knowledge_search` 和系统提示词 |
| `examples/rag-knowledge` | 示例 | Loader 组合 | 使用微型 BM25 索引提供无密钥可运行入口 |

三个包均设置 `private: true`，使用 `@deepseek-ai/dsh-experimental-*` 命名，不设置 `publishConfig`。`knowledge` 默认导出抽象 `Knowledge`，`knowledge-local` 默认导出 `LocalKnowledge extends Knowledge`，`tool-knowledge` 作为函数插件只导出 `name`、`inject`、`Config` 和 `apply`。

## 3. 包内文件

### 3.1 Service Definition

```text
packages/experimental/knowledge/
  package.json
  tsconfig.json
  README.md
  src/index.ts
  src/types.ts
  src/invariant.ts
  tests/knowledge.spec.ts
  tests/invariant.spec.ts
```

`types.ts` 只包含类型声明。`index.ts` 定义 Service、Context 声明合并和运行时代码。第一阶段没有由该包拥有的可变关系，`invariant.ts` 注册空安装器并明确说明原因，仍满足每包提供 `./invariant` 的要求。

### 3.2 本地提供方

```text
packages/experimental/knowledge-local/
  package.json
  tsconfig.json
  tsdown.config.ts
  README.md
  src/index.ts
  src/provider.ts
  src/config.ts
  src/errors.ts
  src/corpus.ts
  src/chunker.ts
  src/manifest.ts
  src/index-loader.ts
  src/bm25.ts
  src/dense.ts
  src/hybrid.ts
  src/reranker.ts
  src/model-runtime.ts
  src/metrics.ts
  src/evaluator.ts
  src/cli.ts
  src/bin.ts
  src/invariant.ts
  tests/fixtures/
  tests/*.spec.ts
```

`bin.ts` 只负责进程入口、错误到退出码的映射和 stdout/stderr 约束；参数解析和操作分发位于可单测的 `cli.ts`。包级 `tsdown.config.ts` 构建 `index`、`invariant` 和 `bin` 三个入口，`package.json` 将 `dsh-knowledge` 指向 `lib/bin.js`。

### 3.3 工具 Consumer

```text
packages/experimental/tool-knowledge/
  package.json
  tsconfig.json
  README.md
  src/index.ts
  src/search.ts
  src/presentation.ts
  src/invariant.ts
  tests/search.spec.ts
  tests/presentation.spec.ts
  tests/lifecycle.spec.ts
  tests/invariant.spec.ts
```

`search.ts` 拥有工具 schema、参数校验、输出裁剪和系统提示词注册。`presentation.ts` 只根据调用参数和工具结果产生通用卡片，不访问文件系统或 Provider。

## 4. Service Definition

### 4.1 标识和枚举

公共类型使用以下名字：

```text
KnowledgeDocumentId = Branded<'KnowledgeDocumentId'>
KnowledgeChunkId = Branded<'KnowledgeChunkId'>
```

只有解析并验证文档、索引或 Provider 结果的函数可以创建品牌化标识。模型工具输入不得接受文档标识或分片标识。`'bm25' | 'dense' | 'hybrid'` 属于本地 Provider 配置，不进入 Service Definition。

### 4.2 搜索请求

`KnowledgeSearchRequest` 字段如下：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `query` | `string` | 非空；Consumer 负责产品限制，Provider 仍拒绝纯空白值 |
| `maxResults` | `number` | 正整数；Provider 返回数量不得超过该值 |

取消信号作为 `search(request, signal?)` 的第二个参数传入，不进入请求对象，不落盘，也不参与索引指纹。

### 4.3 搜索结果

`KnowledgeHit` 字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `documentId` | `KnowledgeDocumentId` | 原始文档标识 |
| `chunkId` | `KnowledgeChunkId` | 稳定分片标识 |
| `title` | `string \| undefined` | 原始可选标题 |
| `text` | `string` | 原始分片正文 |
| `source` | `string \| undefined` | 原始可选来源，不保证是 URL 或路径 |
| `score` | `number` | 当前响应内部可比较的有限数值 |

`KnowledgeSearchResult` 只包含按最终名次排列的只读 `hits`。算法阶段分数、BM25 词项贡献、两路原始名次和重排序 logit 不进入公共结果；评测程序通过提供方内部诊断接口读取这些数据。

### 4.4 Service

默认导出的抽象 `Knowledge` 继承 Cordis `Service`，服务名为 `knowledge`，并通过声明合并增加 `Context.knowledge`。公共方法只有：

```text
search(request: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResult>
```

第一阶段不提供注册表、写入方法、集合选择和 Provider 选择。`LocalKnowledge` 继承 `Knowledge` 并作为 `knowledge-local` 的默认导出，Loader 直接挂载该实现；抽象 `knowledge` 包不单独出现在 `cordis.yml` 中。

### 4.5 错误

`KnowledgeError` 继承 `HarnessError`。Service Definition 只公开调用方需要区分的错误：

| 错误码 | 触发条件 |
| --- | --- |
| `KNOWLEDGE_INVALID_REQUEST` | 查询为空或数量限制无效 |
| `KNOWLEDGE_CANCELLED` | 请求在可取消点终止 |
| `KNOWLEDGE_SEARCH_FAILED` | Provider 无法完成检索 |

`knowledge-local` 内部再区分索引错误和模型错误，用于 CLI 与日志诊断；跨 Service 返回时映射为 `KNOWLEDGE_SEARCH_FAILED`。模型可见消息不得包含模型缓存绝对路径、环境变量值或原始内部堆栈。

## 5. 配置解析

### 5.1 本地提供方配置

`knowledge-local` 的外部 `Config` 和解析后的 `ResolvedConfig` 使用下列字段：

| 字段 | 外部要求 | 默认值或约束 |
| --- | --- | --- |
| `indexDir` | 必填 | 非空路径；加载时解析为绝对路径 |
| `mode` | 可选 | `bm25` |
| `rerank` | 可选 | `false` |
| `candidateCount` | 可选 | `50`，正整数且不小于请求结果数 |
| `bm25K1` | 可选 | `1.2`，有限正数 |
| `bm25B` | 可选 | `0.75`，范围 `[0, 1]` |
| `rrfK` | 可选 | `60`，正整数 |
| `modelCacheDir` | 条件必填 | Dense、Hybrid 或重排序启用时必须配置 |
| `denseModelId` | 可选 | `onnx-community/bge-small-en-v1.5-ONNX` |
| `denseModelRevision` | 可选 | `4a9a46c7b88fa408e650a571a1800243f26309bd` |
| `denseDtype` | 可选 | `q8`；第一阶段只接受 `q8` |
| `denseMaxTokens` | 可选 | `512`，正整数且不超过模型上限 |
| `rerankerModelId` | 可选 | `onnx-community/bge-reranker-v2-m3-ONNX` |
| `rerankerModelRevision` | 可选 | `6f5ff65298512715a1e669753bc754d2bc8f367b` |
| `rerankerDtype` | 可选 | `q8`；第一阶段只接受 `q8` |
| `rerankerBatchSize` | 可选 | `8`，正整数 |
| `rerankerMaxTokens` | 可选 | `512`，正整数 |

`resolveConfig` 在插件加载时一次性应用默认值并验证字段组合。BM25 且不启用重排序时不得要求模型缓存；Dense 和 Hybrid 必须验证稠密载荷与模型配置；启用重排序必须验证重排序模型配置。

### 5.2 工具配置

`tool-knowledge` 使用以下配置：

| 字段 | 默认值 | 约束 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时不注册工具和提示词 |
| `maxResults` | `5` | 正整数 |
| `queryMaxChars` | `2000` | 正整数，按 Unicode code point 计数 |
| `hitMaxChars` | `4000` | 单条证据完整渲染上限 |
| `outputMaxChars` | `12000` | 整个模型可见结果的上限 |
| `timeoutMs` | `30000` | Node timer 范围内的正整数 |

Consumer 无法在加载时读取另一个插件的私有 `candidateCount`，因此 `maxResults <= candidateCount` 由 Provider 在收到请求时检查并明确失败。部署示例必须配置一致值。

## 6. 语料输入和分片

### 6.1 通用语料

`corpus.jsonl` 每行解析成 `CorpusDocument`：

```text
id: string
text: string
title?: string
source?: string
```

解析器逐行处理 UTF-8，允许文件末尾有一个换行，忽略完全空白的行。它拒绝重复 `id`、空 `id`、空 `text`、未知字段和非字符串可选字段。错误包含文件名和一基行号。完成校验后按 `id` 的 Unicode code point 顺序排序文档，使输入行顺序不影响索引。

### 6.2 SciFact 适配

SciFact `corpus.jsonl` 的 `_id` 映射到 `id`，`title` 和 `text` 原样保留，`source` 省略。`queries.jsonl` 的 `_id` 和 `text` 构成候选查询集合；评测只选择 `qrels/test.tsv` 引用的查询，未被 test split 引用的查询合法且忽略。`qrels/test.tsv` 解析为查询标识、文档标识和数值相关性；首行表头必须存在，重复的查询与文档组合、未知查询和未知文档直接失败。每个参与评测的查询必须至少有一个相关性大于 0 的文档。

`prepare scifact` 使用固定 URL `https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip`。下载后验证 BEIR 公布的 MD5 `5f7d1de60b170fc8027bb7898e2efca1`，同时计算 SHA-256 并在成功输出中报告；解压过程拒绝绝对路径和 `..` 路径段。

### 6.3 分片记录

`ChunkRecord` 字段为：

```text
ordinal: number
id: KnowledgeChunkId
documentId: KnowledgeDocumentId
title?: string
text: string
source?: string
startToken: number
endToken: number
```

分片器使用稠密模型对应 tokenizer 计算正文 token 位置，不加入模型 special token。BM25-only 索引仍需要 tokenizer 配置文件，但不加载 ONNX 权重。分片边界优先级和默认长度由概要设计拥有。

句子边界只识别 `. ! ?` 及对应全角符号后的空白；它不引入语言检测。候选段落或句子超过最大 token 数时退回 tokenizer token 边界。重叠从前一个分片结束位置向前取指定 token 数，不得产生空分片或重复的起止区间。

分片完成后按 `documentId`、`startToken`、`endToken` 排序并分配从零开始的 `ordinal`。分片标识编码为 `<percent-encoded-document-id>:<startToken>-<endToken>`。

## 7. 索引目录

### 7.1 文件集合

```text
index/
  manifest.json
  chunks.jsonl
  bm25.json
  dense.f32le        仅包含 Dense 组件时存在
```

构建器要求输出目录不存在或为空。它直接写入固定名称的载荷，完成关闭和校验后最后写入 `manifest.json`。目标目录已存在且非空时直接失败；构建失败可能留下没有清单的目录，运行时必须将其视为未完成索引。目录级原子替换和自动清理属于 E3。

### 7.2 清单

`manifest.json` 使用以下结构，未知字段视为格式不兼容。载荷文件名由格式固定，不允许清单指定任意路径：

```json
{
  "formatVersion": 1,
  "createdBy": {
    "package": "@deepseek-ai/dsh-experimental-knowledge-local",
    "version": "package-version"
  },
  "build": {
    "durationMs": 0
  },
  "corpus": {
    "sha256": "hex",
    "documentCount": 0,
    "chunkCount": 0
  },
  "chunking": {
    "tokenizerModelId": "onnx-community/bge-small-en-v1.5-ONNX",
    "tokenizerRevision": "full-commit-sha",
    "maxTokens": 384,
    "overlapTokens": 64
  },
  "bm25": {
    "analyzer": "english-v1",
    "k1": 1.2,
    "b": 0.75
  },
  "dense": {
    "modelId": "onnx-community/bge-small-en-v1.5-ONNX",
    "revision": "full-commit-sha",
    "dtype": "q8",
    "pooling": "cls",
    "normalized": true,
    "dimensions": 384
  },
  "payloads": [
    { "path": "chunks.jsonl", "bytes": 0, "sha256": "hex" },
    { "path": "bm25.json", "bytes": 0, "sha256": "hex" },
    { "path": "dense.f32le", "bytes": 0, "sha256": "hex" }
  ]
}
```

BM25-only 索引省略 `dense` 和对应载荷项。运行时只接受 `formatVersion = 1`。清单解析、文件大小和 SHA-256 验证全部完成后，索引才可供查询。索引指纹由格式版本、语料、分片、BM25、Dense 和载荷哈希计算，不包含构建耗时和工具版本。

### 7.3 分片载荷

`chunks.jsonl` 按 `ordinal` 顺序写入 `ChunkRecord`，每行只包含公开字段，不含运行时缓存和算法分数。加载器验证 ordinal 连续、分片标识唯一、文档标识非空、token 区间有效，并拒绝清单记录数量不一致。

### 7.4 BM25 载荷

`bm25.json` 结构如下：

```text
version: 1
documentLengths: number[]
averageDocumentLength: number
terms: Array<{
  term: string
  documentFrequency: number
  postings: Array<[ordinal, termFrequency]>
}>
```

`documentLengths` 与 `chunks.jsonl` ordinal 对齐。`terms` 按词项升序排列，每个 postings 按 ordinal 升序排列。加载器验证文档频率、词频、ordinal 范围、平均长度和清单数量的一致性。

### 7.5 Dense 载荷

`dense.f32le` 是无头、行优先的小端 float32 数组，第 `ordinal` 行对应同 ordinal 分片。预期字节数严格等于 `chunkCount * dimensions * 4`。加载器不得接受尾随字节、NaN、Infinity 或未归一化向量；归一化容差固定为 `1e-4`。

运行时把文件读取为一个连续 `Float32Array`，查询扫描只创建命中候选，不为每个文档复制向量。

## 8. 模型准备和运行

本地提供方直接依赖 `@huggingface/transformers`。`package.json` 使用与实现时稳定版本兼容的 semver 范围，`pnpm-lock.yaml` 固定实际版本；首个实现任务审查其传递依赖和安装脚本，只有确实需要执行的脚本才能加入 `pnpm-workspace.yaml` 的 `allowBuilds`。

模型准备使用 ONNX Community 仓库的完整 commit SHA。准备命令允许远程下载到显式 `modelCacheDir`；运行 Provider 始终向 tokenizer、feature-extraction pipeline 和 sequence-classification model 传递相同的 `cache_dir`、`revision` 与 `local_files_only: true`，不修改 Transformers.js 全局缓存配置。

### 8.1 稠密 embedding

`DenseEncoder` 提供 `embedDocuments(texts)` 和 `embedQuery(query)` 两个内部方法。两者使用 feature-extraction pipeline、`dtype: q8`、CLS pooling、归一化、`truncation: true` 和 `max_length: denseMaxTokens`。查询方法先完整添加概要设计规定的英文检索前缀，再从查询正文尾部截断；文档方法保留标题开头，从正文尾部截断。

模型返回值必须是 float32、二维、第二维为 384，且所有值有限。建索引以 CLI 配置批次生成向量；实际批大小进入构建报告，不写入索引兼容字段。

### 8.2 重排序

`Reranker` 使用 `AutoTokenizer` 和 `AutoModelForSequenceClassification`，不使用高层 text-classification pipeline。tokenizer 接收同长度的查询数组和 `text_pair` 文档数组，启用 padding，显式使用 longest-first 右侧截断，并设置概要设计规定的最大 token 数，使查询和文档标题的开头优先保留。

模型输出必须是每个文本对一个有限 logit。批次输出数量不匹配时立即失败。结果按 logit 降序排列；相同 logit 保持输入候选顺序。

### 8.3 模型复用

每个 Provider 实例分别保存 Dense 和 Reranker 的已加载模型引用与加载中的 Promise。第一次需要模型时创建 Promise，并发调用共享它；加载成功后保存模型实例并清空 Promise，加载失败后也清空 Promise，由当前调用报告错误，后续调用可以重新尝试。第一阶段不实现独立的加载状态机和失败缓存。

## 9. 检索执行

### 9.1 通用入口

`LocalKnowledge.search` 按以下顺序执行：验证请求和取消信号；根据加载时解析的 `mode` 执行候选召回；按配置执行重排序；截取 `maxResults`；投影为不含阶段诊断的 `KnowledgeSearchResult`。

配置在加载后不可变；请求不能覆盖 mode、候选数、RRF 参数和模型设置。

### 9.2 BM25

查询使用 `english-v1` 分析器。执行器按首次出现顺序对查询 token 去重，只访问这些词项的 postings，累积分片分数；未命中任何查询词项时返回空数组。公式和排序规则引用[概要设计的 BM25 定义](rag-plugin-phase-one.md#6-bm25-稀疏检索)。

内部诊断为每个候选保留查询 token、词项频率、文档频率、文档长度和词项贡献，仅供 CLI `evaluate --diagnostics` 输出到本地报告。

### 9.3 Dense

查询向量生成后，执行器逐行计算 float32 点积，并维护固定容量的前 k 候选。第一阶段可使用最小堆或完整数组排序，但测试必须证明结果与完整精确排序一致。平局按分片标识处理。

取消信号在生成查询向量前后及扫描每 256 个分片时检查。一次 ONNX 调用内部不可取消。

### 9.4 Hybrid

BM25 和 Dense 各取 `candidateCount`，完成两路结果后按分片标识取并集。RRF 公式和默认值引用[概要设计的 Hybrid 定义](rag-plugin-phase-one.md#8-hybrid-混合检索)。任一路失败使整个请求失败，不降级为另一路。

第一阶段两路顺序执行，避免额外引入并发调度；评测报告记录这一执行策略。

### 9.5 重排序

重排序输入是召回阶段已经排序的前 `candidateCount` 条。执行器按 `rerankerBatchSize` 顺序提交，每批结束检查取消信号，并把原始候选序号作为平局键。任一批失败时不返回部分结果。

## 10. 取消和释放

第一阶段不实现自定义推理队列。`search` 在开始、Dense 编码前后、向量扫描期间和每个 Reranker 批次之间检查取消信号；一次已经进入 ONNX 的调用允许自然结束。

`LocalKnowledge` 随 Cordis fiber 释放。释放后拒绝新请求并清空索引和模型引用，不等待或强行中断正在执行的 ONNX 调用。正式提交仓库时测试 Service、工具和提示词均不会在热重载后重复注册；需要等待所有并发推理静止的释放机制属于 E3。

## 11. 离线命令

命令名为 `dsh-knowledge`。stdout 只输出机器可读结果或明确的人类报告，诊断写 stderr。未知参数、缺少必填参数和输入错误返回非零退出码。

### 11.1 准备数据与模型

```text
dsh-knowledge prepare scifact \
  --data-dir <目录> \
  --model-cache-dir <目录>
```

该命令下载并校验 SciFact，并让 Transformers.js 把两个固定 revision 的 q8 模型及 tokenizer/config 文件写入显式缓存目录。已有缓存由 Transformers.js 复用，不另建模型准备清单。

### 11.2 构建索引

```text
dsh-knowledge index \
  --corpus <corpus.jsonl> \
  --output <索引目录> \
  --model-cache-dir <目录> \
  --components bm25,dense \
  --max-tokens 384 \
  --overlap-tokens 64 \
  --embedding-batch-size 32
```

`--components` 只接受 `bm25` 或 `bm25,dense`；第一阶段不支持只含 Dense 的索引，因为基线实验始终需要 BM25。构建成功向 stdout 输出清单路径、语料哈希、文档数、分片数、耗时和载荷字节数。

### 11.3 评测

```text
dsh-knowledge evaluate \
  --index <索引目录> \
  --queries <queries.jsonl> \
  --qrels <qrels/test.tsv> \
  --model-cache-dir <目录> \
  --max-results 20 \
  --output <报告目录>
```

评测固定运行六组配置，不接受只运行“最佳组合”的参数。`--max-results` 默认 `20` 且不得小于最大指标深度，六组实验都使用 `candidateCount = 50`。`--warmup-queries` 默认 `10`，预热查询按测试查询顺序循环选择，不进入质量或延迟统计。输出包括 `report.json` 和 `report.md`；后者只投影前者，不重复计算指标。

## 12. 评测数据与指标

评测器以 qrels 引用的查询为输入，按查询标识排序，再把分片结果按最终排名折叠为文档结果，同一文档只保留首次出现的分片。它拒绝 qrels 引用不存在的查询或文档、重复查询标识和非有限相关性分数；查询文件中没有被当前 qrels split 引用的记录不参与评测。只有相关性大于 0 的文档算作相关。

每条查询的指标定义为：

```text
Recall@k = 前 k 个结果命中的相关文档数 / 该查询全部相关文档数
ReciprocalRank@10 = 首个相关文档名次的倒数；前 10 名无命中时为 0
DCG@10 = Σ((2^rel_i - 1) / log2(i + 1))
nDCG@10 = DCG@10 / 理想排序的 DCG@10
Success@k = 前 k 个结果存在相关文档时为 1，否则为 0
```

数据集指标是全部评测查询指标的算术平均。延迟使用单调时钟测量每条查询的完整检索时间，排序后按 nearest-rank 的 `ceil(p * N)` 位置计算 p50 和 p95。任一查询失败会使当前运行标记为失败，不计算该组合的部分平均值；其余组合继续运行，方便定位单个算法路径的问题。报告字段固定为：

```text
schemaVersion
createdAt
platform
corpusSha256
indexFingerprint
models
config
runs[]
  mode
  rerank
  status
  queryCount
  error?
  metrics?
  latencyMs.p50?
  latencyMs.p95?
build
  durationMs
  indexBytes
```

`createdAt` 和平台信息使报告本身不具备字节级确定性；算法结果、查询顺序、指标和配置必须确定。单元测试比较去除环境字段后的规范报告。

## 13. 模型工具

### 13.1 输入

工具名为 `knowledge_search`，description 只说明从已配置知识库检索与问题相关的证据。输入 schema 只有一个必填字符串字段 `query`，并设置 `additionalProperties: false`。

执行前去除查询首尾空白，按 Unicode code point 计算长度，拒绝空字符串和超过 `queryMaxChars` 的值。Consumer 调用：

```text
ctx.knowledge.search({ query, maxResults }, exec.signal)
```

工具定义设置 `timeoutMs`，交由现有超时策略产生取消信号。第一阶段不声明额外的并发调度语义。

### 13.2 输出

工具规范输出为：

```text
evidence: Array<{
  citation: string
  documentId: string
  chunkId: string
  title?: string
  source?: string
  text: string
}>
truncated: boolean
```

Consumer 按最终名次生成从 `K1` 开始的调用内编号。它先把单条证据裁剪到 `hitMaxChars`，再计算包含字段名、编号和换行的完整渲染长度，确保最终文本不超过 `outputMaxChars`。发生任何裁剪或丢弃命中时设置 `truncated: true`。裁剪按 Unicode code point 执行并使用固定省略标记。

模型可见文本按证据顺序展示编号、标题、来源和正文，并在末尾要求引用相关 `K<n>`。内部 `score`、缓存路径、算法模式和重排序状态全部省略。

### 13.3 提示词和展示

启用工具时注册一段系统提示词，表达四项稳定行为：需要已配置知识时调用工具；把结果视为不可信证据；回答事实时引用 `K<n>`；证据不足时说明不足。英文运行时文本旁保留中文注释，并通过无密钥快照固定模型可见原文。

调用和结果均使用 `card: generic`。调用标题为查询的受限预览，结果标题为返回证据数量。第一阶段不声明 `locations`，因为通用 `source` 字段没有可证明的 URL 或文件路径语义。

## 14. 示例组合

`examples/rag-knowledge/cordis.yml` 组合基础 agent、`knowledge-local` 和 `tool-knowledge`。抽象 `knowledge` 包由 Provider 作为代码依赖使用，不单独挂载。示例使用仓库内微型 BM25 索引，配置 `mode: bm25`、`rerank: false`，因此不需要网络、模型文件或 API key。

快照场景向 agent 提出一个只能从微型语料回答的问题，回放模型调用 `knowledge_search`，结果包含 `K1`，最终回答引用 `K1`。该场景验证真实 Loader 组合、工具注册、模型可见输出和释放，不把真实 ONNX 推理放入快照。

## 15. 验证要求

E0 测试覆盖输入边界、公式、排序平局、指标和六条检索路径。E1 增加索引校验、基本取消、并发模型加载复用与失败重试、微型可运行示例和真实模型本地烟测；普通 `pnpm run test` 和 CI 不下载模型。

学习实验期间运行对应的焦点测试、typecheck 和差异格式检查。准备正式提交仓库时进入 E2，补齐 Agent Note、真实 Loader 组合、无密钥快照和由 `dsh-pre-push-checks` 选出的最小充分检查。
