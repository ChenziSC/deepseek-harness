# DSH RAG 插件第二阶段详细设计

## 1. 文档职责

本文把[第二阶段概要设计](rag-plugin-phase-two.md)落实为可编码的接口、配置、索引格式、检索流程和评测流程。[实施任务](rag-plugin-phase-two-implementation-tasks.md)负责交付顺序和每项任务的完成条件，不在本文记录开发进度。

第二阶段继续使用第一阶段的三个实验包，不增加新的远程服务或知识库管理层。概要设计拥有阶段范围和验收标准；本文拥有实现约定。实现中如果需要改变范围或默认行为，应先修改概要设计。

## 2. 总体变化

第二阶段在第一阶段结构上增加四项能力：

1. 将英文 Dense 模型扩展为统一处理中英文的 BGE-M3 模型配置。
2. 将英文 BM25 分析器扩展为确定性的中英文混合分析器。
3. 在保留 Exact 正确性基线的同时增加 HNSW，并按索引扫描量解析 `auto`。
4. 让模型在部署允许的范围内请求检索方式、Dense 索引和重排序开关。

包职责保持不变：

| 包 | 第二阶段职责 |
| --- | --- |
| `@deepseek-ai/dsh-experimental-knowledge` | 扩展检索策略请求和已执行策略结果，不包含本地索引实现 |
| `@deepseek-ai/dsh-experimental-knowledge-local` | 多语言分析、BGE-M3、Exact、HNSW、策略解析、索引构建和评测 |
| `@deepseek-ai/dsh-experimental-tool-knowledge` | 将用户意图映射为受控策略字段，继续限制模型可见输入输出 |

不修改 `agent-loop`。工具是否被调用仍由模型根据系统提示词和用户请求决定；Provider 负责校验和执行策略，不能信任模型选择。

## 3. Service 接口

### 3.1 策略类型

Service Definition 增加以下提供方无关类型：

```ts
type KnowledgeRetrieval = 'bm25' | 'dense' | 'hybrid'
type KnowledgeDenseIndex = 'auto' | 'exact' | 'hnsw'
type KnowledgeRerank = 'auto' | 'on' | 'off'

interface KnowledgeSearchStrategy {
  readonly retrieval?: KnowledgeRetrieval
  readonly denseIndex?: KnowledgeDenseIndex
  readonly rerank?: KnowledgeRerank
}

interface ResolvedKnowledgeSearchStrategy {
  readonly retrieval: KnowledgeRetrieval
  readonly denseIndex?: 'exact' | 'hnsw'
  readonly rerank: boolean
}
```

`denseIndex` 只对 `dense` 和 `hybrid` 有意义。BM25 请求携带非 `auto` 的 `denseIndex` 时视为无效请求，不静默忽略。`ResolvedKnowledgeSearchStrategy` 只描述本次实际执行的高层组合，不包含 HNSW 图参数、BM25 参数、候选数量或模型路径。

### 3.2 请求与结果

`KnowledgeSearchRequest` 扩展为：

```ts
interface KnowledgeSearchRequest {
  readonly query: string
  readonly maxResults: number
  readonly strategy?: KnowledgeSearchStrategy
}
```

`KnowledgeSearchResult` 增加 `strategy: ResolvedKnowledgeSearchStrategy`。这样 Consumer、测试和本地评测能够确认实际执行路径，工具可以向模型返回简短的执行模式，但不暴露内部参数和分数轨迹。

Service Definition 增加 `KNOWLEDGE_STRATEGY_NOT_ALLOWED`，用于表示请求的高层组合超出部署允许范围。索引缺少 HNSW、模型缓存缺失或索引损坏仍属于 `KNOWLEDGE_SEARCH_FAILED`；它们是部署问题，不是模型可以通过改写参数修复的问题。

## 4. 策略配置与解析

### 4.1 Provider 配置

第一阶段的固定 `mode` 和布尔 `rerank` 替换为以下配置：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultRetrieval` | `hybrid` | 未指定召回方式时使用 |
| `defaultDenseIndex` | `auto` | 未指定 Dense 索引时使用 |
| `defaultRerank` | `off` | 性能模式默认不重排 |
| `allowedRetrieval` | 全部三种 | 部署允许的召回方式；至少一个值 |
| `allowedDenseIndexes` | 索引实际具备的方式 | 只限制 Dense 和 Hybrid |
| `allowedRerank` | `true` | 是否允许请求开启重排序 |

开发者可以通过只允许一个值实现强制策略，不再增加另一套 `force*` 配置。配置加载时验证默认值属于允许集合，并验证索引产物能够支持所有允许值。

### 4.2 解析顺序

每次查询按以下顺序解析：

1. 使用请求中的显式值；缺失字段使用 Provider 默认值。
2. 验证召回方式和 Dense 索引属于部署允许集合。
3. `rerank: auto` 解析为 `defaultRerank`；显式 `on` 还必须通过 `allowedRerank`。
4. `denseIndex: auto` 解析为索引清单中的 `autoDenseIndex`。
5. 验证解析后的组合所需载荷和本地模型缓存存在。

解析发生在 Provider 的独立纯函数中，并在实际召回前完成。查询失败、超时或取消不得改变后续请求的默认策略。

“性能优先”由默认组合 `hybrid + auto + rerank off` 表示；“质量优先”由 `hybrid + auto + rerank on` 表示。它们不是第四个独立底层维度。

## 5. 工具输入与提示词

`knowledge_search` 的输入扩展为：

```ts
interface KnowledgeSearchToolInput {
  readonly query: string
  readonly retrieval?: 'bm25' | 'dense' | 'hybrid'
  readonly denseIndex?: 'auto' | 'exact' | 'hnsw'
  readonly rerank?: 'auto' | 'on' | 'off'
}
```

模型根据自然语言意图填写这些枚举，不增加独立的关键词解析器或规则路由器。普通查询省略可选字段，使用性能模式。只有用户明确表达“质量优先”“开启重排”或同等含义时，模型才传递 `rerank: 'on'`。

提示词应提供以下映射示例：

| 用户意图 | 工具字段 |
| --- | --- |
| 未指定策略 | 只传 `query` |
| 只按关键词检索 | `retrieval: 'bm25'` |
| 使用精确语义检索 | `retrieval: 'dense', denseIndex: 'exact'` |
| 混合检索且不重排 | `retrieval: 'hybrid', rerank: 'off'` |
| 质量优先 | `rerank: 'on'`，其余使用默认值 |

工具 schema 不包含 HNSW 连接数、构建搜索深度、BM25 参数、RRF 参数、候选数量、阈值、模型或路径。Provider 拒绝不允许的组合时，工具返回可理解的失败信息，不自动替换为另一个策略。

成功结果增加以下模型可见摘要：

```text
Strategy: hybrid + hnsw, reranker off
```

摘要只报告实际执行的三个高层选项。证据内容、`K<n>` 引用和字符上限沿用第一阶段行为。

## 6. 索引格式第二版

### 6.1 不兼容升级

第二阶段将 `INDEX_FORMAT_VERSION` 增加到 `2`，不兼容加载第一阶段索引。第一阶段 SciFact 和微型示例通过同一命令重建为第二版，不维护双格式读取器。

第二版索引目录为：

```text
index/
  manifest.json
  knowledge.sqlite
  dense.f32le          Exact-only 或 Both 时存在
  dense.usearch        HNSW-only 或 Both 时存在
```

`manifest.json` 仍最后写入。运行时以清单为唯一入口，默认验证载荷类型与大小；显式 `verify` 命令重算所有 SHA-256。构建目标必须为空；第二阶段仍不实现目录级原子替换和失败自动清理。

### 6.2 SQLite 载荷

`knowledge.sqlite` 保存分片元数据和 BM25 索引，避免在百万级语料上解析一个完整 JSON 倒排文件。它使用 Node 自带的 `node:sqlite`，不引入独立数据库服务。

固定表包括：

```text
metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)
chunks(ordinal INTEGER PRIMARY KEY, chunk_id TEXT UNIQUE, document_id TEXT,
       title TEXT, source TEXT, text TEXT, start_token INTEGER, end_token INTEGER)
CREATE VIRTUAL TABLE bm25_fts USING fts5(analyzed, detail='column')
```

`ordinal` 同时作为 `chunks` 主键、FTS5 rowid、Dense 行号和 HNSW 数字键；FTS5 不重复保存 ordinal 列。构建按批次事务写入 `chunks` 和 `bm25_fts`，完成后执行 FTS5 优化、关闭数据库并计算文件哈希。运行时只读打开数据库，不创建 WAL、临时业务表或迁移表。

FTS5 输入不是原文，而是分析器生成并编码为安全 ASCII 的词项序列。查询对相同分析结果构建带引号的 OR 表达式，禁止把原始查询直接拼入 MATCH。BM25 使用 SQLite FTS5 的固定评分参数，不向部署配置或提示词开放 `k1`、`b`；结果先按 BM25 排名，再按 `chunk_id` 排序以稳定平局。第二阶段报告必须注明它与第一阶段内存 BM25 实现的差异，SciFact 回归以指标容差而非逐项分数相等验收。

### 6.3 Dense 载荷

`dense.f32le` 是 Exact 的规范向量载荷，按 `ordinal` 保存归一化 float32 行。其字节数必须等于 `vectorCount × vectorDimension × 4`。HNSW-only 不保留该文件。

Exact 只在首次实际使用时加载向量文件，不因默认走 HNSW 而占用相同的常驻内存。显式 Exact 请求若超过可用内存，允许明确失败；不能静默改用 HNSW。

### 6.4 HNSW 载荷

HNSW 使用 `usearch@2.26.2`。该版本要求 Node.js 22 以上，支持 HNSW、持久化索引和只读 `view`，npm 发布物包含 macOS arm64/x64、Linux arm64/x64 和 Windows x64 原生绑定。macOS arm64 已完成本地验证，其他支持平台由 CI 执行相同的加载和持久化测试；Windows arm64 不属于第二阶段支持范围。验证数据见[可行性验证报告](rag-plugin-phase-two-feasibility-report.md)。

初始构建参数为：

| 参数 | 初值 | 归属 |
| --- | ---: | --- |
| metric | cosine | 固定；向量已 L2 归一化 |
| dtype | f32 | 第二阶段固定，不同时引入向量量化 |
| connectivity | 16 | 开发者构建配置 |
| expansionAdd | 128 | 开发者构建配置 |
| expansionSearch | 1024 | 开发者运行配置；在 SciFact、T2Ranking 切片和 MLQA Retrieval 对照中相比 512 改善 Recall@100，同时保持低于 Exact 的查询延迟 |

分片 `ordinal` 作为 USearch key。构建按 ordinal 升序添加向量，保存为 `dense.usearch`。查询结果转换回 ordinal 后读取 SQLite 分片；返回候选按距离、再按 `chunk_id` 排序。HNSW 搜索至少请求 `candidateCount` 个结果，不通过重复扩大请求隐式调参。

图参数和 `usearch` 版本写入清单。`connectivity` 与 `expansionAdd` 属于索引兼容字段；`expansionSearch` 属于运行和报告字段。USearch 文件包含搜索所需的向量和近邻图。HNSW-only 仍会编码全部分片，只是不再额外持久化 Exact 文件。USearch 以自动线程数批量建图时，同一向量输入的图文件和近似结果可能在不同构建间变化；机器可读报告必须记录索引指纹。

### 6.5 Dense 自动选择

构建器在完成分片并确定模型维度后计算：

```text
scanElements = vectorCount × vectorDimension
```

默认 `exactScanMaxElements = 50,000,000`。`scanElements` 不超过阈值时推荐 `exact`；超过时推荐 `hnsw`。构建命令接受 `--dense-index auto|exact|hnsw|both`：

- `auto`：按阈值生成 Exact-only 或 HNSW-only。
- `exact`：只生成 `dense.f32le`，清单默认 Exact。
- `hnsw`：只生成 `dense.usearch`，清单默认 HNSW。
- `both`：同时生成两份载荷，查询默认值仍按阈值推荐结果解析。

Exact 与 HNSW 的比较实验必须显式使用 `both`。运行时按清单和载荷识别可用能力；请求不存在的能力时明确失败。

清单新增：

```json
{
  "dense": {
    "vectorCount": 50000,
    "dimensions": 1024,
    "scanElements": 51200000,
    "exactScanMaxElements": 50000000,
    "requestedIndex": "auto",
    "recommendedIndex": "hnsw",
    "resolvedIndex": "hnsw",
    "autoDenseIndex": "hnsw"
  },
  "hnsw": {
    "library": "usearch",
    "libraryVersion": "2.26.2",
    "metric": "cosine",
    "dtype": "f32",
    "connectivity": 16,
    "expansionAdd": 128
  }
}
```

没有构建 HNSW 时省略 `hnsw`。加载器根据 `resolvedIndex` 验证 Exact 与 HNSW 载荷，重新计算 `scanElements` 和推荐值，不根据当前机器速度改写 `autoDenseIndex`。

## 7. 中英文混合 BM25

第二阶段增加 `mixed-zh-en-v1` 分析器，第一阶段 `english-v1` 不再用于新建的多语言索引。

分析顺序为：

1. Unicode NFKC 规范化并转为小写。
2. 连续拉丁字母、数字和下划线组成一个词项。
3. 每段连续汉字分别生成 unigram 和相邻 bigram。
4. 其他标点和空白只作为边界，不产生词项。
5. 查询词项去重，文档词项保留频次。

写入 FTS5 前对词项增加类型前缀并编码为 ASCII，例如：

```text
API_v2       -> w_api_v2
中           -> c1_4e2d
中文         -> c2_4e2d_6587
```

类型前缀避免英文、数字、汉字 unigram 和 bigram 发生表示冲突。索引和查询必须使用同一分析器版本。第二阶段不增加词典分词、停用词表、同义词、拼音或学习型稀疏向量。

## 8. BGE-M3 模型配置

默认语义模型为 `BAAI/bge-m3`，Node 运行时使用 Transformers.js 兼容的 `onnx-community/bge-m3-ONNX`，固定 revision `25b9af8e87a38eb120cfe87125383677b9cd309e` 和 q8 文件 `onnx/model_quantized.onnx`。本机验证确认中文、英文和中英文混合输入均产生 1024 维归一化向量；详细结果见[可行性验证报告](rag-plugin-phase-two-feasibility-report.md)。

模型配置独立保存以下字段：

```text
modelId
revision
dtype
modelFile = onnx/model_quantized.onnx
dimensions = 1024
pooling = cls
normalized = true
maxTokens
queryPrefix
```

BGE-M3 查询和文档进入同一向量空间，不进行自动语言识别或模型切换。默认 `queryPrefix` 为空；若模型卡和实测要求前缀，只能通过更新模型配置和重建索引引入。默认分片长度仍由实验确定，不能直接把 8192 token 模型上限作为分片长度。

模型继续按需加载并复用。索引构建按批次流式编码和追加向量，不能把全部文档文本和向量同时保存在 JavaScript 对象中。运行时只允许从显式缓存和固定 revision 加载，不下载缺失文件。

Reranker 继续使用第一阶段的多语言 `bge-reranker-v2-m3` 固定 revision 和 q8 配置。第二阶段不新增另一个重排序模型。

## 9. 检索执行流程

### 9.1 BM25

Provider 使用混合分析器生成查询词项，构建参数化 FTS5 MATCH 表达式，从 SQLite 取前 `candidateCount` 条结果，并投影为统一候选。完全没有词项时返回空结果。数据库调用前后检查取消信号；同步 SQL 执行期间不能中断。

### 9.2 Exact Dense

Provider 生成 1024 维归一化查询向量，扫描 `dense.f32le` 并维护固定容量候选。扫描每个固定批次检查取消信号。Exact 是 HNSW 的质量基准，必须保持完整扫描，不增加提前终止或近似剪枝。

### 9.3 HNSW Dense

Provider 延迟打开 `dense.usearch`，使用固定 `expansionSearch` 查询 `candidateCount` 个候选。加载中的并发调用共享一个 Promise；加载失败后允许后续请求重试。原生搜索调用本身不可中断，调用前后检查取消信号。

### 9.4 Hybrid 与 Reranker

Hybrid 仍分别取得 BM25 和 Dense 前 `candidateCount`，按分片标识去重后使用 RRF。Dense 路由可以是 Exact 或 HNSW。任一路失败时整个请求失败，不静默降级。

召回阶段默认保留 `candidateCount = 50` 条候选。Reranker 默认只处理前 `rerankerCandidateCount = 20` 条，再按原召回顺序附加剩余候选。性能模式默认关闭，质量模式显式开启。请求开启重排序但缓存中没有模型时直接失败，不返回未重排结果。

## 10. 构建流程与资源控制

索引构建分为：语料流式解析、确定性分片、SQLite 批量写入、Dense 产物确认、Dense 批量编码、可选 HNSW 构建、载荷校验、最后写入清单。交互式命令在 embedding 前输出结构化计划并请求确认；底层构建器只接受可选选择回调，不自行读取终端。非交互命令不安装回调，直接采用推荐值。

构建配置增加：

| 字段 | 默认值 |
| --- | ---: |
| `denseIndex` | `auto` |
| `exactScanMaxElements` | `50,000,000` |
| `hnswConnectivity` | `16` |
| `hnswExpansionAdd` | `128` |
| `embeddingBatchSize` | 由本机实验确认 |

构建计划包含准确的文档数、分片数、维度、`scanElements`、阈值、推荐模式，以及 Exact、HNSW 和 Both 的预计载荷字节数。Exact 估算为 `chunkCount × dimensions × 4`；HNSW 估算使用 float32 向量加按 `connectivity` 计算的近邻键开销，只作为构建确认信息，不作为磁盘配额保证。

构建前根据已知文档规模只能给出粗略估算；最终选择必须等待实际分片数和向量维度确定。资源不足时明确失败并保留未完成目录供开发者检查，仍不实现自动恢复、分布式构建或后台任务系统。

## 11. 数据集适配与评测

### 11.1 统一输入

所有数据集适配器先转换为第一阶段通用文档、查询和 qrels 结构。下载、解压和转换是显式 `prepare` 操作；运行时 Provider 不包含数据集代码。

新增命令入口：

```text
dsh-knowledge prepare mldr --language zh|en ...
dsh-knowledge prepare t2ranking ...
dsh-knowledge prepare mlqa-eng-zho ...
```

准备命令固定来源、版本或 revision，记录许可证、原始文件摘要和转换后摘要。T2Ranking 默认只准备语料、开发查询和开发 qrels。完整语料和模型不进入 Git。

完整基准索引按实验顺序轮换：一次只构建并保留当前数据集的索引，完成评测并确认机器可读报告后再删除该索引并进入下一组。微型 CI 索引和模型缓存可以常驻；评测报告必须记录被删除索引的各载荷体积，因此无需为复核体积长期保留全部索引。

### 11.2 评测矩阵

每个数据集不必运行所有组合：

| 数据集 | 主要验证 |
| --- | --- |
| SciFact | 第一阶段英文回归；Exact、BM25、Hybrid 和 Reranker |
| MLDR zh/en | 多语言模型、长文档分片和中英文同构质量 |
| T2Ranking | 中文 BM25、Hybrid、百万级 HNSW 和本机资源成本 |
| MLQA Retrieval zho → eng（`eng-zho` 配置） | 跨语言 Dense、HNSW 与 Reranker |

Exact 与 HNSW 对照必须使用相同向量、查询、候选数和结果深度。报告增加：

- `vectorSearchP50Ms`、`vectorSearchP95Ms` 和完整检索 p50/p95。
- HNSW 相对 Exact 的 Recall@10、Recall@100 和加速比。
- 向量文件、SQLite 和 HNSW 各自体积。
- 构建总耗时、Dense 编码耗时、HNSW 建图耗时和峰值 RSS。
- 请求策略、解析后策略、模型 revision、分析器版本和全部 HNSW 参数。

规模实验使用现有数据集切片观察 Exact 与 HNSW 的标准 qrels 指标、查询延迟和结果重合度。默认阈值保持为可覆盖的保守甜点值，不通过单一数据集或单机实验推导普适临界点。

## 12. 生命周期与失败语义

SQLite、Exact 向量和 HNSW 索引分别延迟打开。首次并发请求共享各自的加载 Promise；失败后清除 Promise，允许下一次重试。Provider 释放时关闭 SQLite 和 HNSW 句柄并清空向量引用；第二阶段不增加跨请求推理队列。

启动时完成清单、配置和轻量文件校验。大文件哈希是否在每次启动重算由开发者配置决定，默认验证清单记录的大小并在显式 `verify` 命令中完成全量哈希，避免每次启动读取数 GiB 文件。任何关闭哈希检查的模式都不能跳过格式、版本和文件大小验证。

错误消息区分：策略不允许、索引载荷缺失、模型缓存缺失、数据格式错误、原生 HNSW 不可用、取消和一般检索失败。模型可见错误不包含本机绝对路径和内部堆栈；CLI stderr 可以报告经过脱敏的目标路径和修复建议。

## 13. 测试边界

默认 CI 使用微型中英文语料，不下载真实数据和模型：

- 分析器覆盖中文 unigram/bigram、英文、数字、下划线、中英文混排和规范化。
- 策略解析覆盖默认值、允许集合、无效组合和 Exact/HNSW 产物缺失。
- SQLite BM25 与手算小语料排序一致。
- HNSW 夹具与 Exact 对照，并验证键映射、平局处理、保存和重新加载。
- 工具快照覆盖默认性能模式、显式 BM25、显式 Exact 和质量模式。
- 索引格式覆盖未知版本、哈希错误、SQLite schema 错误和 HNSW 元数据不匹配。

真实模型和数据集评测由显式本地命令运行并在没有缓存时自跳过。完整 T2Ranking、MLDR 和 MLQA Retrieval 不进入默认 CI。新增或修改的正式仓库源文件仍满足仓库逐文件覆盖率和模型可见快照要求，不能以实验包为由整体排除。

## 14. 明确不实现

第二阶段不实现动态语言检测、自动查询改写、多向量表示、BGE-M3 稀疏输出、学习型融合、第二种 ANN、增量建图、在线写入、远程向量数据库、权限过滤、推理队列、后台索引服务和生产监控。
