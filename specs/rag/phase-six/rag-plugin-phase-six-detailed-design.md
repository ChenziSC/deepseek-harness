# DSH RAG 插件第六阶段详细技术方案

## 1. 文档职责

本文将[第六阶段概要设计](rag-plugin-phase-six.md)落实为可编码的公共类型、语料格式、索引格式、候选过滤算法、文档级派生缓存和上下文感知检索 Pilot 协议。[实施任务](rag-plugin-phase-six-implementation-tasks.md)负责依赖顺序、工作量和逐项交付条件。

本阶段正式实现版本与有效期过滤、文档级分片及 BM25 派生内容复用；上下文感知检索只完成隔离的小样本 Pilot。运行时继续加载单个完整不可变索引，不增加在线索引更新、多段查询、远程缓存或权限系统。

## 2. 技术总览

### 2.1 组件关系

```text
严格 JSONL 语料
  -> 语料解析与 RFC 3339 规范化
  -> 临时 source_documents SQLite
  -> 文档级派生缓存查询
       -> 命中：读取分片、Dense 输入和 BM25 预处理文本
       -> 未命中：分片、token 计数、BM25 预处理、事务写缓存
  -> 按文档 ID 和分片位置重新分配全局 ordinal
  -> 写完整格式 4 knowledge.sqlite
  -> 复用或生成 Dense 向量
  -> 完整重建可选 HNSW
  -> 最后发布 manifest.json

KnowledgeSearchRequest(query, maxResults, strategy, asOf?)
  -> 固定一次查询时点
  -> 为该时点生成可服务 ordinal 集
  -> BM25 / Exact Dense / HNSW / Hybrid 候选阶段过滤
  -> 可选 Reranker
  -> top-k、相邻分片和版本元数据投影
  -> knowledge_search 有界结果与引用
```

### 2.2 不变量

- 文档是否在某时点有效只影响候选资格，不改变 BM25 文本、Dense 文本、向量或分数。
- BM25、Dense 和 Hybrid 对同一个请求使用同一个已规范化查询时点和同一套有效期判断。
- `validFrom` 包含边界，`validUntil` 不包含边界；缺少一个边界表示该方向无界，两个边界都缺少表示有效期未知且默认可检索。
- `supersedes` 只提供来源链信息，不隐式删除旧文档，不参与打分，也不代替有效期。
- 文档级缓存只复用可确定重算的构建派生内容；最终 SQLite、Exact 顺序、HNSW ordinal 和 manifest 每次都从目标语料完整组装。
- 版本与有效期字段默认不进入 BM25 或 Dense 输入，因此只修改这些字段不会使已有向量失效。
- 格式 4 运行时拒绝格式 3 索引。格式升级不改变独立 `vectors.sqlite` 的键语义，已有内容寻址向量缓存仍可命中。

## 3. 公共类型与查询 API

### 3.1 Provider-neutral 类型

`packages/experimental/knowledge/src/types.ts` 增加以下字段。命名使用来源版本而不是通用“版本”，避免与索引格式、插件版本或模型 revision 混淆。

```ts
export interface KnowledgeDocumentMetadata {
  readonly sourceVersion?: string
  readonly validFrom?: string
  readonly validUntil?: string
  readonly supersedes?: KnowledgeDocumentId
}

export interface KnowledgeSearchRequest {
  readonly query: string
  readonly maxResults: number
  readonly strategy?: KnowledgeSearchStrategy
  readonly asOf?: string
}

export interface KnowledgeHit {
  readonly documentId: KnowledgeDocumentId
  readonly chunkId: KnowledgeChunkId
  readonly title?: string
  readonly sectionPath?: string
  readonly text: string
  readonly previousText?: string
  readonly nextText?: string
  readonly source?: string
  readonly sourceVersion?: string
  readonly validFrom?: string
  readonly validUntil?: string
  readonly supersedes?: KnowledgeDocumentId
  readonly score: number
}
```

`KnowledgeDocumentMetadata` 是字段集合的公共定义，`KnowledgeHit` 保持扁平字段以延续现有工具投影。其他提供方可以不提供这些可选字段；本地提供方对有效期未知的文档省略两个时间字段，模型工具则显式渲染 `Validity: unknown`。

`asOf` 是提供方无关请求字段，不放入 `KnowledgeSearchStrategy`。检索策略选择算法，`asOf` 选择同一索引中的可服务记录，两者具有不同语义。调用方传入时必须是带时区的 RFC 3339 时间；省略时，本地提供方在一次 `search()` 开始时读取一次当前时间，后续所有召回和扩展步骤复用该值。

### 3.2 模型工具规则

`knowledge_search` 增加可选字符串参数 `asOf`。系统提示要求模型仅在用户明确询问某个历史或未来时点，并且能够不猜测地写出带时区时间时传入该字段；普通当前状态查询必须省略。只有年份、月份、“之前”或“当时”等无法唯一确定时点的表述不允许由模型自行补成某一天，必要时先向用户确认。

工具不接受 `latest=true`、版本字符串比较或自由形式日期。当前查询通过省略 `asOf` 表示，历史查询通过一个绝对时间表示。工具把字段原样传给 `ctx.knowledge.search()`，本地提供方负责统一解析和错误码；无效时间返回 `KNOWLEDGE_INVALID_REQUEST`，不退回当前时间。

模型结果增加来源版本、有效期和替代文档字段。渲染规则为：版本缺失显示 `Version: unknown`；两个有效期边界都缺失显示 `Validity: unknown`；单边或双边范围显示标准化 UTC 时间并明确结束边界不包含；只有存在 `supersedes` 时显示替代关系。新增固定元数据计入现有单条和单轮字符预算。

## 4. 语料字段与时间规范化

### 4.1 Generic JSONL

通用 JSONL 文档允许以下精确字段，未知字段继续报错：

```json
{
  "id": "policy-2026-02",
  "title": "Expense policy",
  "source": "handbook",
  "text": "...",
  "sourceVersion": "2026.02",
  "validFrom": "2026-02-01T00:00:00+08:00",
  "validUntil": "2026-06-01T00:00:00+08:00",
  "supersedes": "policy-2025-11"
}
```

SciFact、MLDR 和 T2Ranking 适配器继续产生没有版本元数据的文档，避免把数据集自身 revision 误当作每篇文档的来源版本。评测需要版本字段时使用 generic JSONL 固定语料。

### 4.2 校验规则

- `sourceVersion` 必须是去除首尾空白后仍非空的字符串；内容不做数值、日期或语义版本比较。
- `validFrom` 和 `validUntil` 只接受 `YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:mm)`，必须显式包含时间和时区，不接受日期缩写、本地时间、时区名称和闰秒。
- 解析器验证真实日历日期和时区偏移，再转换为整数 Unix 毫秒；对外保存并返回对应的 UTC ISO 字符串，使相同瞬间具有唯一表示。
- 两个边界同时存在时必须满足 `validFrom < validUntil`。
- `supersedes` 使用与 `id` 相同的文档标识校验，并且不能等于当前文档 ID。允许引用当前裁剪语料之外的文档，因为局部知识库可能不保留完整历史。
- 缺少版本或时间字段是受支持状态，不用空字符串、零或极大时间代替。

解析后的 `CorpusDocument` 同时保留标准化字符串和整数毫秒。字符串用于最终证据，整数用于 SQLite 约束与查询；构建器不得在多个阶段重复解析同一时间。

## 5. 索引格式 4

### 5.1 Manifest

`KnowledgeIndexManifest.formatVersion` 升级为 `4`，`corpus` 增加固定字段：

```json
{
  "formatVersion": 4,
  "corpus": {
    "sha256": "...",
    "documentCount": 800,
    "chunkCount": 1096,
    "scriptProfile": "latin",
    "documentMetadata": "source-version-validity-v1"
  }
}
```

其余 Dense、HNSW、BM25、分片和 payload 字段保持格式 3 的含义。严格解析器要求 `formatVersion === 4` 和准确的 `documentMetadata` 常量，继续拒绝未知、缺失和不一致字段。运行时加载格式 3 时直接报告不兼容，不增加双版本分支或原地迁移。

`knowledge.sqlite` 的 `user_version` 升级为 `3`。索引 payload 文件名和 Exact 向量字节布局不变，因此格式升级本身不改变向量内容；旧索引目录不能直接运行，但同一 Dense 输入可以从现有独立向量缓存重新组装格式 4 索引。

### 5.2 SQLite 表

文档级字段由新 `documents` 表唯一保存，`chunks` 通过外键引用，避免每个分片复制版本和时间元数据。

```sql
CREATE TABLE documents (
  document_id TEXT PRIMARY KEY,
  title TEXT,
  source TEXT,
  source_version TEXT,
  valid_from TEXT,
  valid_from_ms INTEGER,
  valid_until TEXT,
  valid_until_ms INTEGER,
  supersedes_document_id TEXT,
  CHECK (length(document_id) > 0),
  CHECK (source_version IS NULL OR length(source_version) > 0),
  CHECK ((valid_from IS NULL) = (valid_from_ms IS NULL)),
  CHECK ((valid_until IS NULL) = (valid_until_ms IS NULL)),
  CHECK (valid_from_ms IS NULL OR valid_until_ms IS NULL OR valid_from_ms < valid_until_ms),
  CHECK (supersedes_document_id IS NULL OR supersedes_document_id <> document_id)
) STRICT;

CREATE TABLE chunks (
  ordinal INTEGER PRIMARY KEY,
  chunk_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL REFERENCES documents(document_id),
  section_path TEXT,
  text TEXT NOT NULL,
  start_token INTEGER NOT NULL,
  end_token INTEGER NOT NULL,
  CHECK (length(chunk_id) > 0),
  CHECK (length(text) > 0),
  CHECK (start_token >= 0),
  CHECK (end_token > start_token)
) STRICT;
```

FTS5 表继续只保存分析后的检索文本，rowid 与 `chunks.ordinal` 对齐。读取命中、Dense 输入和相邻分片时通过 `documents` 连接出标题、来源和版本元数据。构建连接启用外键检查；发布前验证文档数、分片数、连续 ordinal、每个文档至少一个分片、FTS 行数和外键完整性。

### 5.3 临时语料表

`.source.sqlite` 的 `source_documents` 增加标准化版本与有效期字段。它仍是一次构建的临时排序载体，不是可复用缓存，也不进入 manifest。输入摘要继续覆盖原始字节，因此仅修改元数据会改变 corpus SHA-256，但不会隐式改变 Dense 缓存键。

## 6. 有效期候选过滤

### 6.1 统一资格判断

一次搜索首先解析或生成 `asOfMs`，然后使用以下条件：

```text
eligible(document, asOf) =
  (validFromMs is absent or validFromMs <= asOfMs)
  and
  (validUntilMs is absent or asOfMs < validUntilMs)
```

尚未生效和已经失效的文档均不进入候选。有效期未知的文档始终满足该条件，但工具明确显示未知，避免 Agent 把“没有元数据”解释成“确认当前有效”。替代关系不改变资格判断。

SQLite 提供 `eligibleOrdinals(asOfMs)`，按 ordinal 返回一个长度等于 `chunkCount` 的 `Uint8Array` 和有效数量。该数组在一次请求内由 BM25、Exact、HNSW、Hybrid、Reranker 输入检查和最终投影共同复用，不跨不同时点缓存。没有有效分片时，召回直接返回空结果；Dense 路径不加载模型或生成查询向量。

### 6.2 BM25

BM25 在 FTS 查询中连接 `documents`，把有效期条件放在 `ORDER BY ... LIMIT ?` 之前。禁止先取得固定 top-k 再过滤，因为失效文档可能占满候选窗口并隐藏仍有效结果。

查询 token、FTS 表和 `bm25()` 分数计算保持不变。同一 `asOf` 下返回的每个 ordinal 还要通过共享资格数组断言，以发现 SQLite 条件和内存判断漂移；该断言只验证已有结果，不执行第二次过滤策略。

### 6.3 Exact Dense

`searchDense()` 增加 ordinal 资格输入，在扫描向量矩阵时跳过无资格 ordinal，只对有效行计算或保留分数，最终从有效集合截取 `candidateCount`。这仍是一次全矩阵顺序扫描，不复制有效向量，也不为每个时点建立新的 Exact 文件。

排序继续使用分数降序和 chunk ID 确定性破同分。有效期过滤不改变任一保留向量的浮点计算或分数。

### 6.4 HNSW

USearch 没有当前过滤谓词接口，因此 HNSW 使用逐步扩大候选数的过取方案：

1. 首次请求 `min(candidateCount, chunkCount)` 个近邻。
2. 按共享资格数组删除无效 ordinal，并按 ordinal 去重。
3. 有效候选不足且仍未搜索全部向量时，把请求数扩大为前一次的两倍，最大为 `chunkCount`。
4. 达到 `candidateCount` 个有效候选或已请求全部向量后停止，按分数和 chunk ID 排序并截取候选数。

每轮扩大使用同一个查询向量和 HNSW 实例。实现记录查询次数、最大过取数和被过滤数量，供性能报告识别“历史数据占比过高导致 ANN 退化”的情况。不得以固定二倍过取后直接返回不足结果，也不得回退到未过滤候选。

当请求数达到全部向量仍不足时返回全部有效命中；这表示索引在该时点本来就没有足够记录。Pilot 和回归同时比较 HNSW 与 Exact 的过滤后 Recall@10，防止过取实现引入额外召回损失。

### 6.5 Hybrid、Reranker 与相邻分片

Hybrid 只融合已经过滤的 BM25 与 Dense 列表，因此失效 ordinal 不进入 RRF 排名。Reranker 只接收过滤后的前置候选，不能通过扩大 rerank 窗口重新引入失效记录。最终 top-k 仍执行资格断言，发现内部违规时使搜索失败而不是静默删除。

相邻分片必须属于同一有效文档。由于有效期定义在文档级，只要主命中有效，同文档邻接分片也有效；查询仍连接文档表并断言 document ID 相同。版本元数据从主文档投影一次，不在 `previousText` 或 `nextText` 中重复。

## 7. 文档级派生内容缓存

### 7.1 职责与目录

新增 `DocumentDerivationCache`，使用调用方显式提供的 `derivedCacheDir`，固定文件名为 `documents.sqlite`。它与 `vectorCacheDir/vectors.sqlite` 分离：前者复用分片和词法派生内容，后者复用最终 Dense 输入的向量；任一缓存可以独立启用、删除或失效。

缓存不属于发布索引，不写入 manifest，不随索引目录复制。默认不自动清理旧项；本阶段只提供删除整个缓存目录的运维方式，不实现容量回收、远程共享或后台压缩。同一目录只支持一个主动构建进程，避免把多进程锁竞争扩展成本带入本阶段。

### 7.2 身份

配置摘要包含以下准确值，并使用带长度编码的 SHA-256：

- tokenizer 模型 ID 与完整 revision；
- 分片策略、`maxTokens` 和 `overlapTokens`；
- BM25 analyzer 与实现标识；
- 派生算法实现版本 `knowledge-local-document-derivation-v2`。

条目键由配置摘要以及文档 `id`、`title` 和 `text` 生成。三者会影响 chunk ID、章节路径、分片正文、Dense 输入或 BM25 文本，必须任一变化即失效。

`source`、`sourceVersion`、`validFrom`、`validUntil` 和 `supersedes` 不进入条目键，因为它们只在最终 SQLite 组装时覆盖到文档行，不影响缓存值中的计算结果。该排除是局部元数据更新能够跳过 tokenizer 与 BM25 预处理的必要条件；以后若任何字段进入检索文本，必须提升派生实现版本并把字段加入键。

### 7.3 值与 SQLite 格式

缓存 schema version 1 使用单表：

```sql
CREATE TABLE derived_documents (
  cache_key TEXT PRIMARY KEY,
  config_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload BLOB NOT NULL,
  CHECK (length(cache_key) = 64),
  CHECK (length(config_sha256) = 64),
  CHECK (length(payload_sha256) = 64)
) STRICT;
```

`payload` 是 UTF-8 规范 JSON，字段顺序由编码器固定，不依赖对象枚举。每个文档值包含文档 ID、标题和按原文顺序排列的分片；每个分片包含 chunk ID、可选章节路径、原始正文、起止 token、准确 Dense 输入和已经过 analyzer 处理的 BM25 token 字符串。值不包含全局 ordinal、source 或版本元数据。

读取时验证 schema version、配置摘要、payload SHA-256、精确字段集合、文档身份、非空分片、chunk ID 与 token 范围、分片顺序和 Dense 输入模板。缺少条目是正常未命中；schema 不兼容、摘要冲突、JSON 损坏或结构不一致是带 cache key 的明确错误，不静默删除或使用部分数据。

### 7.4 构建流程

构建器按二进制 code-point 文档 ID 顺序读取临时表。每篇文档先计算条目键并查询缓存：命中时直接取得派生分片；未命中时调用现有分片器、生成 Dense 输入、运行 BM25 analyzer，并在完整验证后提交该条目。缓存提交成功后才把分片写入目标索引，因此进程中断时已完成文档可复用，半写条目不可见。

目标组装忽略缓存中的局部 ordinal，按当前完整语料顺序连续分配新 ordinal。插入、删除或重排文档只改变目标 ordinal，不使未变化文档条目关联到错误位置。`KnowledgeSqliteWriter` 接收已经预分析的 BM25 文本，不能对缓存命中再次调用 analyzer。

Dense 阶段继续从新 SQLite 按 ordinal 读取准确输入并查询现有向量缓存。文档缓存命中不代表向量缓存必然命中；只有最终 Dense 输入和完整模型配置相同才复用向量。HNSW 继续按新 ordinal 从完整向量序列重建。

### 7.5 统计与失败恢复

`DenseVectorBuildStats` 扩展或由更上层 `KnowledgeIndexBuildStats` 包含以下字段：文档缓存查询数、命中文档数、重算文档数、复用分片数、新分片数，以及 `derivedCacheLookup`、`chunking`、`bm25Preprocess`、`derivedCacheWrite`、`sqliteWrite` 等阶段耗时。原有 Dense、Exact 和 HNSW 字段保持可比。

构建失败或取消不得写 manifest。已经提交的文档缓存项和向量缓存项保留，下一次构建可继续复用；目标索引目录仍按现有规则要求为空，不实现目录内断点续写。缓存 I/O 错误使构建失败，不自动绕过缓存后继续，以免性能实验把损坏误记为未命中。

## 8. 上下文感知检索 Pilot

### 8.1 问题与范围

Pilot 只回答“在当前固定分片边界上增加上下文前缀，是否比已有标题与章节路径输入稳定提高检索质量”。它不选择新分片算法，不修改默认索引，不全量生成前缀，也不与 Reranker、有界多轮搜索或相邻扩展同时调参。

固定集合至少包含60条已复核查询，代词指代、相对时间、同名实体、跨章节归属和弱标题结构各不少于12条。每条样本记录目标文档、目标 chunk ID、必需证据范围和歧义类型；同一查询需要多个分片时记录完整证据集合。样本在生成任何 LLM 前缀前冻结。

### 8.2 三种索引输入

所有方案使用完全相同的原文档、分片边界、chunk ID 和 qrels，只替换 BM25 与 Dense 的索引输入。

1. 当前基线：`title`、`sectionPath` 和原始分片按当前 `retrievalText()` 去重拼接。
2. 确定性前缀：使用固定标签依次写入存在的标题、章节路径、来源版本和有效期，再追加原始分片；缺失字段不生成空标签。
3. LLM 前缀：在当前基线前增加模型生成的最多80 token 单段上下文，说明该分片在原文档中的实体、时间、主题和指代对象，不允许回答查询或补充原文档没有的事实。

LLM 输入包含完整标题、版本元数据、目标分片和受模型上下文上限约束的原文档。超长文档使用包含目标分片的确定性章节窗口，并在运行记录中标明窗口范围；不同运行不能按检索结果动态改变窗口。

### 8.3 生成协议与缓存隔离

生成器要求 JSON 输出 `{ "context": "..." }`，拒绝额外字段、空文本、超过80 token、引用查询、复制大段分片或包含文档外事实的结果。生成失败时使用确定性前缀作为该分片的运行时回退，同时把失败计入质量、成本和失败率，不从主指标移除。

每个前缀记录模型 ID、完整 revision、推理参数、提示版本、文档摘要、chunk ID、输入 token、输出 token、延迟、原始输出摘要、校验结果和失败类型。完全相同的生成输入在一次运行内只请求一次；三次稳定性运行使用独立命名空间，不能让第一次生成结果替代后两次独立输出。

Baseline 可以复用现有向量缓存。确定性前缀和 LLM 前缀改变最终 Dense 输入，必须使用各自带策略与提示版本的向量缓存命名空间，不能命中普通分片向量。Pilot 的前缀记录、向量和索引只保留在 `.cache/`，提交范围只包含固定样本、机器摘要和不含模型原始大文本的报告。

### 8.4 检索矩阵

三种输入分别运行 BM25、Exact Dense 和 Hybrid。所有运行固定 tokenizer、Dense 模型 revision、分片参数、候选数、`maxResults=10`、RRF 参数，关闭 Reranker 和相邻扩展。主指标为完整证据覆盖率、Recall@10 和 nDCG@10；辅助指标为 MRR@10、索引 token 增幅、构建时间、峰值 RSS、前缀生成 token、延迟和失败率。

LLM 方案至少独立生成并运行三次，报告每次结果和均值，不只保留最好一次。当前基线和确定性前缀是确定性对照，可构建一次后重复校验摘要；若重复结果不一致，Pilot 直接判为基础设施失败。

### 8.5 继续与停止

LLM 前缀只有同时满足以下条件才进入后续正式实现规格：

- 相对当前基线，完整证据覆盖率或 Recall@10 至少提高5个百分点。
- 相对确定性前缀，主指标仍为正收益，且三次运行方向一致。
- BM25、Dense 和 Hybrid 任一路 nDCG@10 下降不超过1个百分点。
- 平均索引 token 增幅不超过25%，正文没有因前缀占用模型上限而静默截断关键证据。
- 前缀生成成功率不低于99%，所有回退和失败均计入结果。

未通过时保留当前标题与章节路径方案，并把 LLM 前缀记录为负面 Pilot 结论。通过时只编写下一阶段正式规格，另行决定生产模型、缓存生命周期、迁移批次和全量重建成本；第六阶段不改变默认值。

## 9. 测试与验证

### 9.1 单元测试

- `knowledge`：公共请求与命中类型的编译面，以及服务错误传播。
- `corpus`：字段集合、时区、日历日期、边界顺序、自替代、缺失字段和各外部数据集适配器。
- `index-format` 与 `sqlite-index`：格式 4 严格解析、格式 3 拒绝、schema version 3、外键、计数、元数据往返和损坏载荷。
- `dense`、`hnsw`、`hybrid` 与 `provider`：候选阶段过滤、边界时点、全部无效、未知有效期、HNSW 多次过取、Reranker 输入和相邻分片。
- `document-derivation-cache`：身份变化矩阵、重复文档内容、元数据覆盖、损坏条目、事务回滚、中断恢复和重新分配 ordinal。
- `tool-knowledge`：`asOf` schema、提示限制、字段投影、显式未知、字符预算和不可信证据边界。

### 9.2 集成与快照

使用一个小型格式 4 索引覆盖当前、未来、过期、未知、历史时点、替代链和同时有效冲突。对 BM25、Exact Dense、HNSW 和 Hybrid 执行同一组查询，断言结果集合满足统一资格判断。格式与工具输出变化更新真实 Loader 快照，快照使用显式固定 `asOf`，不记录运行机器当前时间。

增量构建集成覆盖0%、约1%、约10%、100%、插入、删除和输入重排。冷构建、缓存构建和中断恢复的 `knowledge.sqlite` 逻辑记录、Exact 字节、BM25 排名和固定指标必须一致；manifest 的 `build.durationMs` 和 payload 摘要按现有规则单独比较，不能要求不同运行的完整 manifest 字节相同。

### 9.3 性能与 Pilot 报告

增量性能沿用第四阶段1,096分片配置，每组至少三次，报告均值、标准差、峰值 RSS、派生缓存命中、向量缓存命中和各阶段耗时。0%与约1%变化相对65.7秒和68.0秒至少降低30%；100%变化相对273.2秒回退不超过5%，RSS增加不超过10%。

上下文 Pilot 输出固定样本、每次生成摘要、三路检索逐查询指标和总成本。报告必须区分“确定性元数据已经解释的收益”和“LLM 前缀额外收益”，不能把两者合并归因于上下文生成。

## 10. 失败处理、发布与回退

- 语料字段无效、索引格式不匹配、缓存损坏和候选资格内部不一致均提前失败，不静默降级。
- `asOf` 无效时不执行任何召回；取消信号继续在模型加载、查询编码、Exact 扫描、HNSW 过取和 Reranker 之间检查。
- 构建仍以 manifest 最后写入作为完成标志。没有 manifest 的目录不是可加载索引。
- 功能回退通过重新构建格式 4 索引并省略版本元数据完成，不重新支持格式 3。性能回退可以停止传入 `derivedCacheDir`，向量缓存与最终索引语义不受影响。
- 上下文 Pilot 不接入生产配置，因此负结果不需要运行时代码回退。

## 11. 明确不做

- 不依据版本字符串排序，不自动沿 `supersedes` 选择“最新”文档，不引入来源权威分数。
- 不实现文档级权限、撤回策略、租户过滤或历史访问授权；`asOf` 不能绕过部署已有权限。
- 不修改 Dense 文本以加入版本或时间，不因格式升级重新训练或更换模型。
- 不实现 HNSW 删除标记、在线增删、分段 ANN、多版本运行时索引或后台索引服务。
- 不为派生缓存实现网络共享、垃圾回收、容量配额或多进程协调。
- 不在 Pilot 通过前实现生产 LLM 前缀服务、全量前缀生成或默认策略切换。
