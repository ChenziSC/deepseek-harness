# DSH RAG 插件第六阶段 6.2 详细技术方案

## 1. 文档职责

本文说明6.2如何在不改变RAG产品行为的前提下重组建库、CLI、缓存和离线评测代码。范围与验收以[概要设计规格](rag-plugin-phase-six-two.md)为准，执行批次以[实施任务](rag-plugin-phase-six-two-implementation-tasks.md)为准。

## 2. 技术总览

### 2.1 变更原则

本阶段采用“先冻结、再移动、后去重”的顺序。先用现有测试、快照和小型索引固定可观察行为；再将代码移动到明确所有权下；最后只在共同语义已经可见时抽取公共实现。禁止先写新的通用抽象，再把现有代码强行适配进去。

### 2.2 所有权关系

```text
Loader entrypoint
  -> provider/config

dsh-knowledge dispatcher
  -> product commands
       -> build pipeline
       -> verification/runtime primitives
  -> offline commands
       -> contextual-prefix research
       -> evaluation

build pipeline
  -> corpus staging
  -> document derivation + SQLite chunks
  -> Dense materializer strategy
       -> encode/cache
       -> copy Exact prefix
  -> payload verification
  -> manifest commit
```

产品入口、产品CLI、构建内核和离线研究各自只能向下依赖。Provider和正式`index`命令不得反向依赖`offline`。离线评测可以复用产品分片、SQLite与检索实现，但产品代码不能为了评测便利导入离线模块。

## 3. 行为基线

### 3.1 冻结内容

重构前保存以下小型、可重复基线：

- BM25-only、Exact、HNSW和Both构建的manifest去除时间字段后的规范JSON；
- SQLite的文档、分片、FTS和Dense输入顺序；
- Exact向量文件摘要与HNSW可加载性；
- 从Exact派生Exact、HNSW和Both的产物与排序；
- 文档派生缓存0%变化、局部变化和配置变化统计；
- CLI命令帮助、机器可读输出、退出码和代表性失败文本；
- `knowledge_search`现有Loader快照。

时间、临时目录和性能波动不做字节比较。格式版本、schema版本、语料摘要、chunk ID、payload摘要、向量字节和排序属于必须保持的行为。

### 3.2 重构期间的变更隔离

如果整理过程中发现真实缺陷，只先增加能够暴露缺陷的测试并记录，除非该缺陷阻止重构，否则不在同一批修改产品行为。必须修复时单独列出行为差异、指标和文档，不能以“清理代码”名义混入。

## 4. 单一建库流水线

### 4.1 当前重复的共同阶段

`buildKnowledgeIndex`和`deriveKnowledgeIndexFromExact`都执行以下过程：

1. 校验公共分片与缓存选项；
2. 准备全新输出目录；
3. 将输入语料流式暂存到`.source.sqlite`并计算摘要；
4. 打开目标`knowledge.sqlite`；
5. 使用文档派生缓存写入文档、分片、FTS和Dense输入；
6. finalize并重新打开SQLite验证；
7. 生成Dense与可选HNSW payload；
8. 关闭资源、删除暂存库、计算payload摘要；
9. 组装格式4 manifest并最后写入。

两者真正不同的是Dense来源、源索引兼容性检查和Dense manifest字段来源。该差异应成为显式策略，而不是复制完整函数。

### 4.2 流水线接口

建议内部接口保持窄小：

```ts
interface DenseMaterializer {
  readonly prepare: (context: DensePreparationContext) => Promise<DensePreparation>
  readonly write: (context: DenseWriteContext) => Promise<DenseWriteResult>
  readonly manifest: (context: DenseManifestContext) => DenseIndexManifest
}

interface BuildPipelineRequest {
  readonly corpus: CorpusBuildRequest
  readonly output: OutputBuildRequest
  readonly dense?: DenseMaterializer
  readonly onBuildStats?: (stats: KnowledgeIndexBuildStats) => void
}
```

接口名称可以调整，但责任必须稳定：流水线拥有生命周期和最终提交，策略只拥有Dense准备、写入与其manifest字段。策略不能删除暂存库、写最终manifest或关闭流水线拥有的SQLite。

### 4.3 资源生命周期

流水线使用明确的分层`try/finally`：加载的源索引由派生入口关闭；暂存数据库与目标writer由流水线关闭；Exact输入输出文件由Dense策略关闭；向量缓存和文档派生缓存由创建者关闭。任何资源只能有一个关闭所有者，幂等`close`用于调用安全，不替代明确所有权。

最终manifest仍是完成标记。payload全部写入、关闭并复验后才能计算摘要和写manifest。失败目录保持不可加载，不增加自动恢复或原子目录替换机制。

### 4.4 统计

公共分片阶段生成`KnowledgeIndexBuildStats`，Dense策略生成`DenseVectorBuildStats`。普通编码策略保留缓存命中、编码批次、导入耗时和HNSW耗时；Exact派生策略不伪造编码统计。公共流水线只合并双方已经定义的时间字段，不引入万能事件总线。

## 5. 包入口收窄

### 5.1 根入口

`src/index.ts`只承担Loader可发现的插件入口：`Config`类型和schema、`LocalKnowledge`类及默认导出。确有生产包外消费者时可以保留其最小类型，但必须在同一修改中列出消费者。

下列类别不从根入口导出：

- 分片器、BM25实现、Dense搜索与HNSW封装；
- 建库器、数据准备和评测矩阵；
- 向量缓存、文档派生缓存和上下文前缀缓存；
- 模型加载器、tokenizer和Reranker测试接口；
- 6.1上下文前缀规划、生成、统计和artifact解析。

测试改为相对导入对应源模块。仓库脚本若确需稳定入口，只为真实脚本消费者增加具体子路径，例如`./offline/contextual-prefix`，不恢复聚合导出桶。

### 5.2 导出验证

增加入口测试，断言根模块只包含允许的运行时导出。TypeScript类型通过编译期使用验证，不把类型列表复制成运行时元数据。`package.json`移除不再需要的宽泛源路径导出时，需同步全部仓库内引用并验证构建产物。

## 6. 上下文前缀离线隔离

### 6.1 模块分组

六个上下文前缀模块按职责放入一个离线目录：

```text
offline/contextual-prefix/
  planning.ts
  artifacts.ts
  generation.ts
  cache.ts
  openai.ts
  statistics.ts
  index.ts             # 只供离线CLI或明确子路径使用
```

移动时优先保持现有文件内部结构，不在同一步重写检测算法或生成协议。目录入口只聚合离线命令真正共同使用的符号；测试仍可直接导入具体文件。

### 6.2 依赖门槛

增加静态检查或架构测试，禁止`provider.ts`、`index.ts`、正式建库目录和正式CLI `index`命令导入`offline/contextual-prefix`。离线命令可以导入正式分片与语料解析模块。正式索引的manifest、SQLite schema和检索输入继续不包含前缀字段。

## 7. CLI 拆分

### 7.1 分派器

顶层`runCli`只解析第一个命令名、选择命令处理器、统一处理`--help`和未知命令，并将异常转换为当前退出码与stderr文本。帮助中的命令顺序保持稳定。

### 7.2 命令模块

`index`模块拥有Dense交互确认、tokenizer/encoder装配和构建统计输出；`derive`模块拥有源索引与目标Dense模式选项；`evaluate`模块拥有评测矩阵和报告目录；`contextual`模块拥有`contextual-plan`、`contextual-generate`与`contextual-statistics`，并明确标记为离线研究命令。

`prepare`和`slice`可以共享语料准备的枚举解析，但不能因为输入都来自argv就合并业务流程。`verify`足够小时可以独立文件或与只读索引命令同组，由行数和依赖决定。

### 7.3 参数解析

公共解析函数仅包括缺失值、安全整数、有限数字、枚举、枚举列表和数字列表。带业务含义的默认值、互斥关系、路径存在性和模型配置由命令模块校验。这样可以消除文本解析重复，同时避免把所有命令压入声明式schema框架。

## 8. 缓存公共零件

### 8.1 可共享内容

`storage/cache-primitives.ts`可以提供以下无业务状态函数：

- 将UTF-8值按长度分隔写入SHA-256；
- 执行同步SQLite事务并在异常时回滚；
- 校验64位小写十六进制摘要；
- 对拥有`close()`的可选句柄执行清晰的幂等关闭，仅在确有重复时引入。

摘要字段顺序仍由每种缓存显式给出，避免公共函数隐藏缓存身份。事务辅助函数不能吞掉原异常，回滚失败处理遵循现有SQLite行为。

### 8.2 不共享内容

向量二进制编码、派生文档规范JSON、前缀batch payload、表结构、schema版本和损坏记录错误分别保留在各自模块。三类缓存不实现统一接口，不新增泛型repository或基类。

## 9. 内存 BM25 去留

### 9.1 对照项

审计至少比较混合中英文分词、词频与文档频率、长度归一化、并列排序、候选截断和诊断贡献值。固定评测样本同时走内存BM25与临时SQLite FTS5，记录结果差异及其原因。

### 9.2 决策规则

如果内存BM25只是在评测中近似正式行为，则评测迁移到临时SQLite并删除`buildBm25Index`、`searchBm25`等重复评分路径。如果它提供正式SQLite无法合理提供且仍被实际报告使用的逐词诊断，则将其移入`offline/evaluation`，名称和文档明确它不是产品BM25基线；不得继续从包根导出。

## 10. 迭代治理

### 10.1 规则落点

在`packages/experimental/knowledge-local/AGENTS.md`记录该包特有的职责地图、根导出限制、产品与离线依赖方向、文件规模检查点和复制处理规则。该文件只补充仓库既有规范，不重复测试、JSDoc或文档通用要求。

### 10.2 文件规模检查

400行是评审触发点：作者必须说明文件是否仍只有一个变更原因、是否混合四类职责、继续增长会拆到哪里。预计超过500行的改动应在增加功能前完成拆分，除非文件是高内聚的数据表、生成代码或单一协议定义，并在评审中记录理由。

不设置仓库级“超过500行即失败”的机械门禁。实现收尾生成RAG生产文件行数降序清单，并把超过500行且有多个顶层职责的文件视为未完成；单一职责的大文件可以带理由通过。

### 10.3 重复代码检查

现有`pnpm run duplication`继续作为硬门禁。不得用缩短变量名、改写等价控制流或扩大`jscpd:ignore`逃避结果。发现第二份相同语义时优先确定唯一所有者；确需平行实现时，忽略区间必须极窄并说明为何共享会造成错误依赖，且6.2默认不新增任何忽略区间。

### 10.4 阶段结束清单

每次RAG阶段结束至少执行：定向逐文件覆盖率、产品Loader快照判断、真实小型模型smoke判断、`typecheck`、`lint`、`duplication`、`doc-sync`、`hygiene`和`git diff --check`。此外检查根导出新增项、产品到offline的反向依赖、最大生产文件和新增相似实现。

## 11. 验证策略

重构复用已有小语料和缓存测试，不构建完整向量库。建库流水线使用确定性stub encoder固定向量字节，并保留一次真实BGE-M3小型smoke验证装配；HNSW只验证小规模保存、加载和搜索。上下文前缀只运行无网络单元测试，不调用生成模型。

模型可见输出若保持不变，不新增产品快照场景，但必须重放现有`knowledge-search`快照。CLI不是模型可见路径，其拆分由命令执行测试覆盖。若任何用户可见帮助或错误文本变化，文档与测试需同步说明，不得把意外变化当成重构结果接受。

## 12. 完成判定

6.2完成时，产品入口、构建流水线、CLI和离线研究具有明确单向依赖；普通与派生构建共享生命周期；重复门禁通过；所有超过500行的RAG生产文件均为单一职责或有具体保留说明；后续规则已经进入包级`AGENTS.md`，而不只存在于阶段性Spec。
