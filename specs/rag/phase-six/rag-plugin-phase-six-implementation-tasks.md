# DSH RAG 插件第六阶段实施任务

## 1. 交付原则

本阶段按“语义先稳定、重复计算再减少、高成本质量方案最后判断”的顺序实施。版本元数据、公共请求和索引格式先一次确定；所有召回路径随后共享同一有效期过滤；文档级缓存建立在已稳定的语料字段和检索输入上；上下文感知检索只在前两项完成并通过回归后运行抽样 Pilot。

任务不得为了缩短等待而把有效期过滤推迟到最终 top-k，也不得为了复用旧目录保留格式 3 运行时兼容分支。性能优化只允许跳过可证明相同的分片、BM25 预处理和 Dense 编码，最终索引仍完整构建和发布。

## 2. 优先级、成本与依赖

| 顺序 | 优先级 | 任务 | 主要依赖 | 编码成本 | 运行等待成本 | 主要产物 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | P0 | T0 基线、样本和格式冻结 | 无 | 0.5人日 | 低 | 固定输入、基线摘要、字段决策 |
| 2 | P0 | T1 公共类型与语料解析 | T0 | 1人日 | 低 | `asOf`、版本元数据、严格解析 |
| 3 | P0 | T2 格式 4 与 SQLite schema 3 | T1 | 1–1.5人日 | 低 | manifest、documents/chunks、构建读取 |
| 4 | P0 | T3 三路候选过滤 | T2 | 1.5–2人日 | 低 | BM25、Exact、HNSW、Hybrid 一致过滤 |
| 5 | P0 | T4 工具输出、提示与快照 | T1、T3 | 1人日 | 低 | 历史时点工具参数、版本证据渲染 |
| 6 | P0 | T5 版本过滤验收 | T3、T4 | 0.5–1人日 | 低 | 固定回归与机器摘要 |
| 7 | P0 | T6 文档派生缓存核心 | T2 | 1.5–2人日 | 低 | 内容寻址 SQLite 缓存 |
| 8 | P0 | T7 构建器、统计与 CLI 接入 | T6 | 1.5–2人日 | 低 | 命中/重算路径、阶段计时、参数 |
| 9 | P0 | T8 增量正确性与性能验证 | T5、T7 | 1–1.5人日 | 半天左右 | 0/1/10/100%报告、回归结论 |
| 10 | P1 | T9 上下文 Pilot 数据与生成器 | T5、T7 | 1人日 | 1–2小时 | 固定样本、三种输入、前缀记录 |
| 11 | P1 | T10 Pilot 检索矩阵与复核 | T9 | 1–1.5人日 | 1–4小时 | 三次运行、质量与成本摘要 |
| 12 | P1 | T11 阶段验收与仓库检查 | T8、T10 | 0.5–1人日 | 低 | 验收报告、文档、完整检查 |

总编码成本预计12–16人日。真实等待主要来自三组增量性能重复运行和三次 LLM 前缀 Pilot，可与报告、测试和代码审查交错，不等同于额外人日。

## 3. 依赖图

```text
T0 基线、样本和格式冻结
  -> T1 公共类型与语料解析
       -> T2 格式 4 与 SQLite schema 3
            -> T3 三路候选过滤
                 -> T4 工具输出、提示与快照
                      -> T5 版本过滤验收
            -> T6 文档派生缓存核心
                 -> T7 构建器、统计与 CLI 接入

T5 + T7
  -> T8 增量正确性与性能验证
  -> T9 上下文 Pilot 数据与生成器
       -> T10 Pilot 检索矩阵与复核

T8 + T10
  -> T11 阶段验收与仓库检查
```

T3和T6在T2完成后可以并行，但默认顺序先做T3：版本过滤是用户可见正确性，缓存是构建性能。T9可在T8性能运行期间准备，但不能在版本元数据和派生身份尚未稳定时生成正式 Pilot 产物。

## 4. 版本、有效期与替代关系

### T0：基线、样本和格式冻结

依赖：无。

- 记录分支起点、第五阶段默认搜索预算、当前索引格式3、SQLite schema 2和向量缓存 schema 1。
- 固定第四阶段1,096分片性能输入、运行命令、模型 revision、硬件记录和65.7/68.0/83.4/273.2秒对照值。
- 新增不含秘密的小型 generic JSONL 样本，覆盖当前有效、尚未生效、结束边界、未知有效期、单边范围、显式历史查询、替代链和同时有效冲突。
- 固定公共字段名：`sourceVersion`、`validFrom`、`validUntil`、`supersedes`和请求`asOf`；禁止后续实现阶段边写边改数据格式。
- 列出当前可复用产物：独立向量缓存可继续使用，格式3索引目录只作基线和输入来源，不作为格式4运行时载荷。

完成条件：样本和预期结果完成代码复核；性能基线能够在当前机器定位；详细设计中的格式和边界语义没有未决命名。

### T1：公共类型与语料解析

依赖：T0。

主要文件：

- `packages/experimental/knowledge/src/types.ts`
- `packages/experimental/knowledge/README.md`
- `packages/experimental/knowledge/README.zh.md`
- `packages/experimental/knowledge-local/src/corpus.ts`
- 对应单元测试和所属 subsystem 文档。

任务：

- 增加 provider-neutral 文档元数据、`KnowledgeSearchRequest.asOf`和`KnowledgeHit`投影字段。
- 实现单一 RFC 3339 解析与 UTC 规范化函数，返回字符串和 Unix 毫秒；语料与请求共用它，避免两套边界语义。
- 扩展 generic JSONL 精确字段集合；保持 SciFact、MLDR和T2Ranking转换结果不变。
- 校验非空版本、自替代、真实日期、显式时区和左闭右开范围。
- 更新公共 JSDoc、README和类型测试，说明缺失元数据与显式历史查询行为。

完成条件：所有有效输入规范化为唯一 UTC 字符串；无效输入带来源文件和行号；公共服务可接受`asOf`而不依赖本地提供方类型。

### T2：格式 4 与 SQLite schema 3

依赖：T1。

主要文件：

- `packages/experimental/knowledge-local/src/index-format.ts`
- `packages/experimental/knowledge-local/src/sqlite-index.ts`
- `packages/experimental/knowledge-local/src/index-builder.ts`
- `packages/experimental/knowledge-local/src/invariant.ts`
- 对应格式、构建器、CLI和不变量测试。

任务：

- 把 manifest 升级为格式4，并在`corpus.documentMetadata`记录固定 schema 标识。
- 把 SQLite 升级为 schema 3，新建`documents`表，把标题、来源、版本、有效期和替代关系作为文档级记录；`chunks`保留分片字段并引用文档。
- 扩展临时`.source.sqlite`，在流式解析阶段只做一次时间规范化。
- 改造 writer、`chunkFromRow()`、Dense 输入、相邻分片和文档 ID查询，使连接后的外部行为保持一致。
- 发布前验证文档、分片、FTS、ordinal和外键完整性。
- 明确拒绝格式3和SQLite schema 2，不提供兼容读取或迁移命令。

完成条件：BM25-only、Exact、HNSW和both模式均可构建、验证和加载格式4；仅版本元数据不同但正文相同的索引具有相同Dense输入序列。

### T3：三路候选过滤

依赖：T2。

主要文件：

- `packages/experimental/knowledge-local/src/sqlite-index.ts`
- `packages/experimental/knowledge-local/src/dense.ts`
- `packages/experimental/knowledge-local/src/hnsw.ts`
- `packages/experimental/knowledge-local/src/provider.ts`
- `packages/experimental/knowledge-local/src/hybrid.ts`
- 对应召回和提供方测试。

任务：

- 在一次请求开始时解析或捕获唯一`asOfMs`，生成可服务 ordinal 数组和数量。
- 把 BM25 有效期谓词放入 SQL 的`LIMIT`之前。
- 让 Exact 扫描跳过无效 ordinal并从有效集合产生完整候选数。
- 为 HNSW实现从`candidateCount`开始、按两倍增长、最大到`chunkCount`的过取循环；记录轮数、最大过取和过滤数。
- 让 Hybrid只接收已过滤列表，Reranker和最终top-k执行资格断言。
- 处理全部无效、有效记录少于结果上限、未知有效期、边界毫秒、取消和HNSW多轮过取。

完成条件：四种召回方式在同一时点不返回无效记录；HNSW不会因首批候选被过滤而无理由少于Exact可提供的结果数；过滤前后的保留分数一致。

### T4：工具输出、提示与快照

依赖：T1、T3。

主要文件：

- `packages/experimental/tool-knowledge/src/index.ts`
- `packages/experimental/tool-knowledge/src/search.ts`
- `packages/experimental/tool-knowledge/README.md`
- `packages/experimental/tool-knowledge/README.zh.md`
- 真实 Loader示例、快照和工具测试。

任务：

- 在工具 schema 增加可选`asOf`，不增加自由形式版本筛选。
- 更新提示：只有用户明确给出可无歧义规范化的历史或未来时点时才使用`asOf`，当前查询省略，模糊时间先确认。
- 投影并渲染版本、有效期和替代关系；有效期缺失时显式显示未知。
- 保持不可信证据标记、引用编号、单条输出、单次输出和单轮累计输出限制。
- 更新最小输出长度计算、JSON输出schema、单元测试和模型可见快照。

完成条件：工具历史查询把准确时点传至提供方；普通查询不生成动态参数；新增元数据不能突破字符预算或伪造引用边界。

### T5：版本过滤验收

依赖：T3、T4。

- 对固定小型索引运行 BM25、Exact、HNSW和Hybrid矩阵。
- 检查`validFrom`相等时命中、`validUntil`相等时不命中、无边界时命中。
- 检查当前查询、两个历史时点、替代链和同时有效冲突的命中与工具渲染。
- 只修改版本与有效期字段后重建，断言Dense输入序列、向量缓存键和Exact载荷逐字节一致。
- 生成机器可读摘要和中文结论，引用可解析率必须为100%。

完成条件：概要设计第3.4节全部通过；任一路径若只在最终top-k后过滤则本任务失败。

## 5. 第二批增量建库优化

### T6：文档派生缓存核心

依赖：T2。

建议新增文件：

- `packages/experimental/knowledge-local/src/document-derivation-cache.ts`
- `packages/experimental/knowledge-local/tests/document-derivation-cache.spec.ts`

任务：

- 定义派生配置摘要、条目键和规范JSON payload；复用向量缓存的长度编码SHA-256方式，但不共用表或schema。
- 建立`derivedCacheDir/documents.sqlite` schema 1，使用WAL、完整事务和严格字段约束。
- 缓存文档分片、章节路径、token范围、Dense输入和BM25分析文本，不保存全局ordinal及只投影元数据。
- 实现批量查询和完整条目事务提交；同一文档的半成品不可见。
- 校验payload摘要、身份、分片顺序、chunk ID、token范围和Dense输入模板；损坏条目返回带key错误。
- 覆盖配置、正文、标题、ID、analyzer、tokenizer和分片参数变化必须失效，source及版本元数据变化必须命中。

完成条件：缓存身份与详细设计完全一致；缓存值不依赖目标索引ordinal；中断后只有完整已提交文档可复用。

### T7：构建器、统计与 CLI 接入

依赖：T6。

主要文件：

- `packages/experimental/knowledge-local/src/index-builder.ts`
- `packages/experimental/knowledge-local/src/sqlite-index.ts`
- `packages/experimental/knowledge-local/src/bin.ts`
- `packages/experimental/knowledge-local/src/prepare.ts`
- 包README、CLI测试和构建器测试。

任务：

- 为构建API和CLI增加可选`derivedCacheDir`；不与`vectorCacheDir`隐式合并。
- 把现有`writeChunks()`拆成按文档查询或生成派生记录、重新分配ordinal、写目标SQLite三个步骤。
- 让 writer接受预分析BM25文本，缓存命中路径不得再次调用tokenizer或analyzer。
- 在最终组装时从当前源文档覆盖source、版本、有效期和替代关系。
- 保持向量缓存查询、Exact写入和HNSW完整重建的顺序与失败语义。
- 增加文档命中、重算文档、复用分片、新分片和独立阶段耗时；更新CLI机器输出。

完成条件：关闭派生缓存时行为与格式4普通构建一致；开启时插入、删除和重排不会复用错误ordinal；只改投影元数据时不运行分片器和BM25 analyzer。

### T8：增量正确性与性能验证

依赖：T5、T7。

- 单元和集成覆盖0%、1%、10%、100%、插入、删除、重排、缓存损坏和中断恢复。
- 对每组比较冷构建、缓存构建和恢复构建的文档行、分片行、FTS输入、BM25排名、Dense输入、Exact字节和固定检索指标。
- 沿用1,096分片真实配置，对0%、约1%、约10%和100%变化各运行至少三次；变化文档集合与第四阶段保持一致。
- 记录语料暂存、缓存查询、分片、BM25预处理、缓存写、SQLite写与finalize、Dense缓存、embedding、Exact、HNSW、总耗时和峰值RSS。
- 0%和约1%组确认未变化文档的tokenizer与analyzer调用数为零。
- 对照概要门槛给出“性能正收益”或“只完成正确性基础”的明确结论，不因局部阶段加速而忽略总时间。

完成条件：0%和约1%平均总时间至少降低30%；100%总时间回退不超过5%，RSS增加不超过10%；全部正确性对照一致。若性能门槛失败，保留实现前必须说明其维护价值，否则撤回默认接入。

## 6. 上下文感知检索 Pilot

### T9：Pilot 数据与生成器

依赖：T5、T7。

- 准备至少60条固定查询，五种歧义类型各不少于12条；在前缀生成前完成人工证据范围复核。
- 实现三种索引输入适配器，不修改生产默认`retrievalText()`。
- 固定确定性前缀模板、LLM JSON提示、80 token上限、超长文档章节窗口和失败回退。
- 记录模型ID、完整revision、提示版本、参数、输入输出token、延迟和失败类型。
- 为baseline、deterministic和每次LLM运行分配隔离缓存命名空间；确认后两者不能命中普通分片向量。
- 样本与机器摘要可提交，原始模型长文本、向量、索引和本机路径只保留在`.cache/`。

完成条件：相同输入能够追踪到唯一前缀记录；三种方案只改变索引文本，不改变分片和qrels；生成失败不会从统计中消失。

### T10：Pilot 检索矩阵与复核

依赖：T9。

- 固定Exact Dense、Reranker关闭、相邻扩展关闭，运行三种输入乘BM25、Dense和Hybrid矩阵。
- LLM前缀独立生成并评测三次；基线与确定性方案验证重复摘要一致。
- 输出逐查询完整证据覆盖、Recall@10、nDCG@10和MRR@10，并按歧义类型及召回方式分组。
- 输出索引token增幅、生成token、生成延迟、失败率、构建时间和RSS。
- 对所有看似提升或明显回退的样本进行盲复核，确认qrels、前缀事实性和正文截断状态。
- 严格应用概要与详细设计门槛，不在正式集合追加提示、长度或模型扫描。

完成条件：报告能分别回答基线到确定性前缀、确定性前缀到LLM前缀的增量收益；给出继续或停止结论；Pilot结果不改变第六阶段默认索引。

## 7. 收尾

### T11：阶段验收与仓库检查

依赖：T8、T10。

- 编写版本过滤、增量构建、上下文Pilot和第六阶段总验收报告，链接机器可读摘要。
- 为非平凡实现增加或更新Agent Note；同步受影响公共JSDoc、包README、subsystem文档和双语配对。
- 模型可见schema、提示或结果变化更新真实Loader快照；公共服务类型变化同步相关SDK投影检查。
- 运行相关包逐文件100%覆盖率、真实小型模型烟测、`typecheck`、`lint`、`doc-sync`、`hygiene`和`git diff --check`。
- 检查提交范围不包含模型、向量、索引、完整语料、原始真实会话、缓存数据库和本机绝对路径。
- 未得到用户明确指令时不commit、不push。

完成条件：每个概要验收条件都有代码、测试或报告证据；默认行为与实验结论一致；未通过的Pilot不被描述为产品收益。

## 8. 建议提交拆分

以下拆分用于降低评审范围，不代表允许自动提交：

1. 公共类型、语料解析、格式4和SQLite schema 3。
2. BM25、Exact、HNSW、Hybrid有效期过滤及工具投影。
3. 文档派生缓存、构建器接入、CLI和增量测试。
4. 性能脚本、固定样本、机器摘要和报告。
5. 上下文Pilot生成器、评测、样本和结论。

第一项是第二项和第三项共同基础，不拆成相互不兼容的临时格式。性能数据与实现可分开提交，但数据提交必须指向已固定的代码revision。Pilot代码不进入生产默认路径；如果只服务一次评测，应放在现有知识评测工具附近而不是增加新的运行时包。

## 9. 明确暂缓

- 不实现版本字符串自动比较、自动选择替代链末端或权威来源评分。
- 不实现在线HNSW增删、多段索引、后台合并、远程向量数据库或持续监听文档变更。
- 不实现RAPTOR、GraphRAG、OpenViking式层次摘要、知识写入审核或多租户权限。
- 不把上下文前缀设为默认，不运行完整语料重建，不提前设计生产前缀服务。
- 不为一次Pilot建设通用实验平台；复用现有评测、缓存和机器摘要能力即可。

## 10. 实施结果

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| T0–T5 | 完成 | [版本与有效期验收报告](rag-plugin-phase-six-version-validity-report.md) |
| T6–T8 | 完成 | [增量建库报告](rag-plugin-phase-six-incremental-build-report.md) |
| T9–T10 | Pilot 完成，停止生产实现 | [上下文感知检索 Pilot 报告](rag-plugin-phase-six-contextual-retrieval-report.md) |
| T11 | 完成 | [第六阶段验收报告](rag-plugin-phase-six-acceptance-report.md) |

上下文前缀没有进入生产配置或默认检索文本。停止结论来自预设 token 与成功率门槛失败，并得到盲复核发现的样本模板偏差支持；它不否定该机制在更真实独立样本上重新评估的价值。
