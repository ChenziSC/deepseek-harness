# DSH RAG 插件第三阶段详细设计

## 1. 文档职责

本文把[第三阶段概要设计](rag-plugin-phase-three.md)落实为接口、索引格式、执行顺序和评测约定。[实施任务](rag-plugin-phase-three-implementation-tasks.md)负责依赖和交付顺序，不在本文记录临时开发状态。

## 2. 总体执行顺序

一次搜索按以下顺序执行：

```text
请求高层偏好
  -> 根据查询和索引画像解析实际召回方式
  -> BM25 / Dense / Hybrid 召回候选
  -> 根据 rerank 偏好和候选分差决定是否重排
  -> 截取 maxResults 个排名命中
  -> 为每个命中读取同文档相邻块
  -> 在工具字符预算内输出命中与上下文
```

自动路由在召回前完成，自适应重排在召回后完成，相邻扩展在最终排序后完成。这个顺序保证邻居不参与评分，结果中的实际策略可以准确反映本次执行。

## 3. Service Definition

请求态召回偏好增加 `auto`，结果态继续只包含具体算法：

```ts
type KnowledgeRetrieval = 'auto' | 'bm25' | 'dense' | 'hybrid'
type ResolvedKnowledgeRetrieval = Exclude<KnowledgeRetrieval, 'auto'>

interface ResolvedKnowledgeSearchStrategy {
  readonly retrieval: ResolvedKnowledgeRetrieval
  readonly denseIndex?: 'exact' | 'hnsw'
  readonly rerank: boolean
}
```

`KnowledgeHit`保留排名命中的 `text` 和 `chunkId`，增加可选 `sectionPath`、`previousText` 和 `nextText`。上下文字段不带独立分数，不计入 `maxResults`，调用方仍可按排名命中文档计算指标。

`KnowledgeSearchStrategy.rerank` 的语义为：`off` 禁止重排，`on` 强制重排，`auto` 允许提供方按候选歧义决定。省略字段时使用部署默认值。

## 4. 索引格式

本阶段将本地索引格式升级到版本 3，将 SQLite schema 升级到版本 2。旧索引由加载器明确拒绝，开发者需要重建；项目仍处于预发布阶段，不增加兼容读取路径。

清单的 `corpus` 增加：

```json
{
  "scriptProfile": "latin | cjk | mixed | neutral"
}
```

清单的 `chunking` 增加：

```json
{
  "strategy": "markdown-structure-v1"
}
```

SQLite `chunks` 增加可空 `section_path`。FTS5 与 Dense 编码输入按文档标题、章节路径、原始分片文本去重后连接；返回给调用方的 `text` 仍是原始分片文本。

## 5. Markdown 结构分片

构建器逐行识别以下结构：

- ATX 标题：行首最多三个空格，随后为一至六个 `#` 和标题文本。
- fenced code block：行首最多三个空格，围栏为至少三个反引号或波浪线，结束围栏使用相同字符且长度不短于开始围栏。
- 段落：空行分隔。
- 句子：沿用英文和中文句末符号规则。

标题栈按级别更新，跳级标题允许存在；路径只包含当前已知标题。未闭合代码围栏延伸到文档末尾。完整结构超过 token 上限时使用现有 tokenizer 限制切分，保证内存和模型输入上限不变。

## 6. 相邻块扩展

SQLite 按排名命中的 ordinal 查找 `ordinal - 1` 和 `ordinal + 1`，并验证 `document_id` 相同。默认只扩展一层，不递归读取更多邻居。

如果邻居已经出现在排名命中集合中，则不再附加。前块尾部与命中开头、命中尾部与后块开头存在完全相同 overlap 时，删除邻居中的重复部分；无法证明重复时保留原文。

工具渲染优先保留固定元数据和命中块，再依次使用剩余字符预算放入前块和后块。任何上下文被裁剪或省略时设置 `truncated: true`。

## 7. 自动路由

策略解析拆为请求计划与最终结果两个阶段。请求计划包含具体 `retrieval`、具体 Dense 索引和 `rerank` 偏好；最终结果在召回与可选重排完成后生成。

精确词项信号包括 URL、明显文件路径、全大写错误码、snake_case、camelCase、至少六位数字和至少八位十六进制值。命中任一信号时首选 BM25。

语料与查询分别按 Latin 和 CJK 字符计数。没有相关字母时为 `neutral`；少数脚本占比达到 20% 时为 `mixed`；否则以占比较高者为主脚本。纯 Latin 查询面对 CJK 语料或纯 CJK 查询面对 Latin 语料时首选 Dense，其余首选 Hybrid。

自动首选值需要经过 `allowedRetrieval` 约束。BM25 首选顺序为 BM25、Hybrid、Dense；Dense 首选顺序为 Dense、Hybrid、BM25；Hybrid 首选顺序为 Hybrid、Dense、BM25。显式请求不使用该顺序，超出允许集合时直接返回 `KNOWLEDGE_STRATEGY_NOT_ALLOWED`。

## 8. 自适应重排

召回候选按当前策略完成稳定排序后计算：

```text
gapRatio = (top1Score - top2Score) / max(abs(top1Score), abs(top2Score), epsilon)
```

`auto` 在候选少于两条时跳过；`gapRatio >= adaptiveRerankMinScoreGapRatio` 时跳过；否则调用现有 Reranker。默认阈值为 `0.15`，合法范围为 0 至 1。

阈值属于本地提供方配置，不进入工具 schema。`on` 不读取阈值并强制调用，`off` 不加载 Reranker。取消信号和模型加载失败保持第二阶段语义。

## 9. 两轮检索限制

工具插件从 `exec.agent.session.events` 反向读取当前未闭合的 `turn/start`，以 agent 对象和 turn 编号记录已派发次数。一次工具调用在参数校验通过、进入提供方搜索前原子占用次数，因此并发调用不会共同通过剩余的最后一个名额。

工具配置增加 `maxSearchesPerTurn`，默认值和最大值均为 2，允许部署设为 1。第三次调用返回明确错误，不调用提供方。直接调用工具但没有 `exec.agent` 时不应用 turn 限制，便于程序化使用和离线测试。

系统提示明确一次优先、证据不足才二次、二次改写、两次后停止。限制不依赖 Skill，也不修改 agent loop。

## 10. 测试与评测

单元测试覆盖结构边界、标题路径、超长围栏、相邻文档隔离、overlap 去重、自动路由、允许集合、自适应重排和 turn 计数。真实 Loader 快照覆盖模型看到的工具 schema、提示词、实际策略、上下文和第三次拒绝。

离线评测分别提供 `baseline`、单项开启和四项组合结果。结构与相邻扩展增加证据完整率；召回指标只使用排名命中。自动路由报告路由选择分布和相对固定策略指标。自适应重排报告触发率。两轮检索使用确定性双证据 fixture，不用单跳 qrels 代替多证据验收。
