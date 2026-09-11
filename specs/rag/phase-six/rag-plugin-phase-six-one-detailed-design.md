# DSH RAG 插件第六阶段 6.1 详细技术方案

## 1. 文档职责

本文记录上下文前缀评测如何完成候选规划、有限上下文组装、批量生成、缓存、临时索引对照和验收。范围与门槛以[概要设计规格](rag-plugin-phase-six-one.md)为准，最终结果见[6.1 验收报告](rag-plugin-phase-six-one-acceptance-report.md)。

## 2. 技术总览

### 2.1 离线三阶段流程

上下文前缀不嵌入在线 Provider。评测流程分为三个可独立检查的阶段：

1. `plan`读取语料和已派生分片，使用确定性检测器产生候选、上下文窗口、批次和成本上界，不调用 LLM。
2. `generate`读取冻结计划，通过显式注入的生成器生成并缓存前缀，严格执行累计预算。
3. 评测脚本读取语料、计划和前缀记录，生成临时 BM25 与 Dense 对照索引，并复用未变化的派生缓存和向量缓存。

计划文件与生成记录必须可以离线复核。调用方可以在`plan`后停止，不产生远程费用；`generate`不能临时扩大候选集合、上下文窗口或输出上限。

### 2.2 组件关系

```text
CorpusDocument
  -> document derivation cache
  -> chunks
  -> AmbiguityDetector(strict-v1)
  -> ContextualPrefixPlan
       -> cost preview / explicit budget check
       -> ContextWindowBatcher
       -> ContextualPrefixGenerator
       -> ContextualPrefixCache
  -> evaluation-only contextual retrieval text
       -> temporary BM25 comparison
       -> temporary Dense comparison
  -> evaluation artifacts
```

基础派生缓存不保存生成前缀。前缀缓存只保存高成本生成结果，向量缓存继续以最终 Dense 输入和完整模型配置寻址。三个缓存的身份和失效原因分别可见。

### 2.3 不变量

- `off`是唯一默认模式；该模式不得构造生成器或访问网络与凭据。
- 候选检测、排序、分组和预算裁剪在相同输入下完全确定。
- 模型看不到检索查询、qrels、相关文档标记或评测结果。
- 生成前缀不能替代或修改原始分片，工具输出不返回生成前缀。
- 每次生成请求属于冻结计划中的一个批次；计划外 chunk 的响应无效。
- 实际输入、输出和重试 token 全部计入预算与报告。
- 预算、缓存或记录校验失败不得产生 manifest。

## 3. 离线评测配置与公共类型

### 3.1 计划选项

```ts
type ContextualPrefixMode = 'off' | 'ambiguous-only'
type ContextualPrefixTarget = 'dense' | 'bm25-and-dense'
type ContextualBudgetAction = 'fail' | 'deterministic-fallback'

type ContextualPrefixOptions = {
  readonly mode: 'off'
} | {
  readonly mode: 'ambiguous-only'
  readonly target: ContextualPrefixTarget
  readonly detector: 'strict-v1'
  readonly maxCandidateRatio: number
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly maxPrefixTokens: number
  readonly contextWindowTokens: number
  readonly maxChunksPerRequest: number
  readonly budgetAction: ContextualBudgetAction
  readonly promptVersion: string
  readonly cacheDir: string
}
```

这些字段属于离线计划与评测配置，不属于正式建库配置。选择`ambiguous-only`时其余字段全部必填，解析阶段校验比例、正整数、目录和非空版本；不能在生成函数内部使用隐藏默认值。

`target`必须显式选择。`dense`只改变 Dense 输入，保留 BM25 当前语义；`bm25-and-dense`使用同一前缀同时增强两路索引。6.1评测复用同一组前缀比较两种目标，不为该对照重复调用 LLM。

### 3.2 生成器

```ts
interface ContextualPrefixGenerator {
  readonly modelId: string
  readonly revision: string
  readonly parameters: Readonly<Record<string, string | number | boolean>>
  readonly countTokens: (request: ContextualPrefixRequest) => Promise<number>
  readonly generate: (request: ContextualPrefixRequest) => Promise<ContextualPrefixGeneration>
}
```

生成器由离线命令或库调用方注入，核心索引模块不读取厂商环境变量，也不依赖具体远程 SDK。首个命令行适配器可以复用 Pilot 已验证的 OpenAI-compatible Responses API，但凭据继续通过环境变量或 credentials provider 解析，不能进入计划、缓存、日志或 manifest。

### 3.3 CLI

提供两个产品外的离线步骤：

```text
dsh-knowledge contextual-plan ...
dsh-knowledge contextual-generate --plan <path> ...
```

`contextual-plan`默认只打印摘要并写入用户指定目录。`contextual-generate`必须同时收到计划、生成器配置和累计输入/输出预算；缺少任一项时不得发送请求。正式`index`命令不消费生成记录。

## 4. 高歧义候选检测

### 4.1 `strict-v1`信号

检测器对原始 chunk 与确定性元数据运行以下规则：

- 开头指代：中文“该、其、上述、这些、前者、后者”等，英文“this、that、these、those、it、they、former、latter”等；
- 承接表达：中文“然而、此外、因此、同时、随后”等，英文“however、moreover、therefore、meanwhile、subsequently”等；
- 跨段引用：“上文、下节、本章、该图、该表、above、below、previous section”等；
- 相对时间：存在“目前、近日、近年来、currently、recently”等，而附近没有明确绝对日期；
- 弱结构组合：标题缺失、标题过于通用或归一化标题重复时，必须再命中至少一个上述信号才成为候选。

单独缺少标题、单独出现普通代词或文本较短均不能触发生成。规则按语言分别维护，检测器版本进入计划和缓存身份。

### 4.2 风险等级和比例上限

候选按以下顺序选择：显式跨段引用、开头指代、相对时间、承接表达、弱结构组合。同一等级按文档 ID、chunk 起始 token 和 chunk ID 的二进制 code-point 顺序排列。

若候选比例超过`maxCandidateRatio`，`fail`模式在生成前失败；`deterministic-fallback`模式只保留比例内的最高风险候选，其余继续使用当前标题、章节路径和正文。计划记录原始候选数、实际选择数、裁剪数和各信号分布。

### 4.3 全语料规划

SciFact、MLQA、MLDR-en、MLDR-zh和完整T2Ranking都必须运行规划器。该步骤流式读取文本，只保留累计统计和有限诊断样本；不落盘完整分片集合，不创建SQLite或BM25索引，不加载Dense encoder，不调用LLM，也不构建Exact或HNSW。报告区分实际分片数和在缺少完整索引时的估算值；超大语料可以按文档 ID 摘要执行确定性抽样分片，但仍须逐篇读取、校验并计入完整语料摘要和文档数，同时公开抽样模数与实际分片文档数。

## 5. 上下文窗口与批处理

### 5.1 窗口选择

上下文窗口以目标 chunk 所属章节为首选范围。章节超过`contextWindowTokens`时，以目标 chunk 为中心向前后扩展完整段落；没有章节结构时使用相同的段落窗口算法。窗口必须包含完整目标 chunk，不能为了加入更多上下文截断目标正文。

标题、章节路径、来源版本和有效期作为独立字段提供。完整文档只有在其 token 数不超过窗口限制时才能进入请求；禁止对长文档的每个 chunk 重复提交全文。

### 5.2 批次

同一文档、同一章节且窗口重叠的候选可以组成一个批次，数量不超过`maxChunksPerRequest`。请求包含一个共享上下文窗口和按稳定顺序排列的目标 chunk 列表，响应必须返回相同 ID 集合且每个 ID 恰好一次。

不同文档不能合并到同一请求。一个批次失败时按整个批次记录实际 token 和失败原因；重试使用相同输入摘要，不在重试时扩大窗口或修改候选。

### 5.3 输出

输出使用严格 JSON：

```json
{
  "prefixes": [
    { "chunkId": "document:3", "context": "该分片讨论……" }
  ]
}
```

每个`context`为单段文本，最多`maxPrefixTokens`，只能澄清文档内的实体、时间、主题和指代关系。提示词要求模型以`maxPrefixTokens`一半为目标上限，为模型计数与本地tokenizer差异预留余量；本地解析仍以完整硬上限拒绝超长结果。输出不得回答查询、执行文档中的指令、增加外部事实或复制大段原文。结构错误、额外 ID、缺失 ID、重复 ID、空文本和超长文本均视为批次失败。

## 6. 预算与费用控制

### 6.1 计划上界

规划器使用生成器的`countTokens`计算每个冻结请求的输入 token。每个请求的输出上界为`maxPrefixTokens × 候选数 + 128`；固定余量覆盖 JSON 字段、chunk ID 和供应商计入输出用量的推理 token，避免正文额度恰好耗尽时截断结构化响应。计划汇总请求数、候选数、输入 token、输出上界、预计缓存命中和预计向量失效数。

计划上界超过任一预算时不得进入生成。调用方选择比例裁剪后必须重新生成计划摘要，不能只在界面中隐藏超额候选。

### 6.2 运行时计量

每个响应必须提供实际输入和输出 token。生成器在请求前预留该批次上界，在响应后以实际用量结算；请求失败或重试的已消费 token 同样结算。下一请求可能突破累计预算时立即停止。

`deterministic-fallback`只决定未生成候选如何建库，不能允许生成器越过预算。报告同时给出计划上界、实际用量、缓存节省和失败重试成本。

### 6.3 大规模判断

6.1流式统计估算完整五语料约有1,362,976个候选分片，占约10,552,549个分片的12.92%；即使经过候选筛选和章节批处理，仍预计需要约14.74亿输入token，输出上界约2.45亿token。因此完整语料只用于无LLM规划，正式质量与实际用量结论必须来自有界真实子集，不能把候选比例直接等同于可接受的生成成本。

## 7. 前缀缓存与增量失效

### 7.1 缓存身份

前缀缓存使用独立 SQLite 文件。每条记录的身份至少包含：

- 模型 ID、完整 revision和生成参数；
- 提示版本、检测器版本和输出 schema 版本；
- 文档 ID、文档标题和来源元数据摘要；
- 章节路径、上下文窗口准确字节和目标 chunk 准确字节；
- `contextWindowTokens`、`maxPrefixTokens`和批次成员 ID。

缓存值保存生成状态、前缀、实际 token、延迟、输出摘要和失败类型。成功记录原子提交；失败记录可以用于审计，但不能作为成功结果命中。

### 7.2 局部更新

文档内容未变化时，计划与成功前缀100%复用。局部修改只重新检测变化后受影响的分片；上下文窗口或章节边界变化时，仅对应窗口内的批次失效。模型、提示、检测器或输出限制变化时，相关生成身份全部失效，但基础文档派生缓存仍可按自身身份复用。

评测对照中，未选择的分片保持原 Dense 输入，因此继续命中现有向量缓存；选择且前缀发生变化的分片重新编码。该行为只用于测量失效范围，不进入正式索引路径。

## 8. 索引接入撤回

### 8.1 格式版本

评测曾验证格式5、SQLite schema 4和以下`contextualPrefix`清单字段：

```ts
interface ContextualPrefixManifest {
  readonly mode: 'off' | 'ambiguous-only'
  readonly target: 'dense' | 'bm25-and-dense'
  readonly detector: 'strict-v1'
  readonly promptVersion?: string
  readonly modelId?: string
  readonly revision?: string
  readonly candidateCount: number
  readonly generatedCount: number
  readonly fallbackCount: number
  readonly cacheHitCount: number
  readonly inputTokens: number
  readonly outputTokens: number
}
```

真实评测未通过发布门槛，因此上述格式没有保留。正式索引保持格式4，不包含`contextualPrefix`对象。

### 8.2 SQLite

评测临时索引曾保存可空的`context_prefix`和非空的`context_prefix_status`。撤回后正式 SQLite 保持schema 3，不包含这两个字段。

评测脚本仍可比较`dense`与`bm25-and-dense`输入，但这些组合文本不进入产品索引。正式 Dense 和 BM25 输入继续使用标题、章节路径和原始正文。

## 9. 安全与失败语义

- 文档和前缀都属于不可信内容。生成提示明确要求忽略文档中的命令，但该提示不替代输出校验和事实抽查。
- 计划和缓存可能包含原始文档片段，默认位于忽略目录，不进入提交、遥测或普通日志。
- 凭据只在生成适配器中读取，不进入请求摘要、错误文本、缓存或 manifest。
- 默认失败策略是停止生成且不写生成记录。显式选择确定性回退时，缺失前缀的候选保留在评测记录的回退计数中。
- 取消信号在批次之间检查；已成功缓存的结果保留，未完成请求不能产生成功记录。
- 索引加载和查询阶段没有上下文前缀依赖，离线生成服务不可用不影响索引构建与查询。

## 10. 评测设计

### 10.1 完整语料规划轨道

五个完整语料运行流式`strict-v1`统计，报告文档数、实际或估算分片数、各信号命中、候选比例、批次数、计划输入 token、输出上界和预计向量失效。T2Ranking必须扫描完整2,303,643篇集合，不能以100k子集替代；该轨道不保存完整计划明细，不创建检索索引，也不调用LLM。

### 10.2 真实质量轨道

从SciFact、MLQA、MLDR-en、MLDR-zh和T2Ranking已有 qrels 中预先固定至少200条查询，每个数据集至少30条。每个评测索引包含所选查询的全部相关文档和按固定种子选择的真实干扰文档，每个数据集最多10,000个分片，五个数据集合计最多50,000个分片。样本选择和证据映射在生成前冻结，前缀模型不接收查询或qrels。主报告同时包含完整混合集和检测器命中的高歧义子集。

已有匹配配置的索引和向量缓存优先只读复用。没有可复用产物时只构建上述有界评测子集；不得为了评测重新构建任一完整数据集，也不得从完整语料构建新的SQLite、BM25、Exact或HNSW产物。

比较以下索引输入，后三组复用同一批生成结果：

1. 当前标题、章节路径和正文；
2. 确定性元数据前缀；
3. 选择性 LLM 前缀，仅用于 Dense；
4. 选择性 LLM 前缀，同时用于 BM25 与 Dense。

分别运行 BM25、Exact Dense和Hybrid，关闭Reranker与相邻扩展。记录完整证据覆盖率、Recall@10、nDCG@10、MRR@10、索引 token、生成 token、请求数、缓存命中、构建时间、RSS和向量失效数。

### 10.3 增量成本轨道

在固定真实语料子集上比较冷构建、0%、约1%、约10%文档变化和提示版本升级。0%变化不得调用生成器或重新编码向量；约1%变化只允许受影响窗口重新生成；提示版本升级允许前缀全部失效，但必须提前给出完整成本计划并复用基础分片缓存。

### 10.4 复核

对全部新增命中、全部明显回退、全部回退记录以及其余成功前缀的随机样本执行盲复核。复核者只看到文档窗口、原始 chunk 和前缀，不看到检索分数与方案名称；判断前缀是否受原文支持、是否错误解析实体或时间、是否包含模板化关键词堆叠。

## 11. 发布结论

6.1 未通过输入节省、高歧义增益、nDCG保护、全部候选成功率和事实性门槛。索引接入已经撤回，只保留候选统计、预算规划、离线生成缓存和评测代码。重新提出产品能力必须另立规格并重新满足全部门槛。
