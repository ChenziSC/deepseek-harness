# DSH RAG 插件第六阶段验收报告

## 1. 总结

第六阶段完成版本与有效期过滤、格式 4 索引、文档派生缓存和上下文感知检索 Pilot。正式运行时能力通过正确性与性能门槛；上下文前缀 Pilot 显示受控样本上的质量潜力，但因索引 token、单次生成成功率和样本模板偏差不进入生产实现。当前默认检索输入、分片策略、Reranker 默认值和每轮六次搜索预算均不因本阶段 Pilot 改变。

## 2. 交付结果

| 范围 | 结果 | 结论 |
| --- | --- | --- |
| T1–T5 版本与有效期 | 公共 `asOf`、来源版本、有效区间和替代关系进入格式 4；BM25、Exact、HNSW、Hybrid 在候选阶段统一过滤 | 通过，属于正确性和来源可追踪性能力，不宣称排序收益 |
| T6–T8 文档派生缓存 | 内容寻址复用分片、Dense 输入和 BM25 预处理，最终索引仍完整组装 | 通过，0%/约 1%/约 10% 变化的平均总时间分别降低 99.8%/93.3%/60.7% |
| T9–T10 上下文前缀 Pilot | LLM 平均完整证据覆盖率 96.67%，但索引 token 增加 29.49%，最低单次成功率 98.61%，54/60 样本存在模板化偏差 | Pilot 完成，停止正式实现并保持当前默认 |
| T11 文档与回归 | 公共文档、工具目录、快照、Agent Note、机器摘要和阶段报告同步 | 完成，验证命令以本报告第 5 节的实际结果为准 |

## 3. 版本与有效期

Generic JSONL 支持 `sourceVersion`、`validFrom`、`validUntil` 和 `supersedes`，`knowledge_search` 支持明确的带时区 `asOf`。有效区间采用 `validFrom <= asOf < validUntil`；缺失边界表示该方向无界，两个边界都缺失时文档仍可检索并显示未知有效期。`supersedes` 只作为来源关系返回，不会自动隐藏旧文档。

固定边界样本确认 BM25、Exact Dense、HNSW 和 Hybrid 返回相同的有效文档集合；无有效 Dense 候选时不加载查询模型。只修改版本或有效期元数据不会改变 BM25、Dense 输入或 Exact 向量字节。详细证据见[版本与有效期验收报告](rag-plugin-phase-six-version-validity-report.md)和[机器摘要](data/version-validity-evaluation-summary.json)。

## 4. 构建与 Pilot

文档派生缓存与向量缓存相互独立。缓存键覆盖会影响分片和检索文本的输入，来源、版本、有效期和替代关系从当前语料重新投影；命中时跳过 tokenizer、分片和 BM25 analyzer，构建器仍重新分配 ordinal 并生成完整发布索引。100% 变化时平均总时间只增加 1.14%，平均峰值 RSS 降低 3.8%，均满足回退限制。详细证据见[增量建库报告](rag-plugin-phase-six-incremental-build-report.md)和[机器摘要](data/incremental-build-evaluation-summary.json)。

上下文前缀 Pilot 的 deterministic 元数据前缀相对 baseline 提高平均完整证据覆盖率 7.78 个百分点；LLM 前缀三次均值相对 baseline 提高 43.89 个百分点。该实验未通过平均索引 token 增幅不超过 25%和每次生成成功率不低于 99%的门槛，盲复核还确认构造样本可能显著放大收益，因此不实现生产前缀生成。详细证据见[上下文感知检索 Pilot 报告](rag-plugin-phase-six-contextual-retrieval-report.md)和[机器摘要](data/contextual-retrieval-pilot-evaluation-summary.json)。

## 5. 验证

最终验收执行以下检查：

- `pnpm vitest run packages/experimental/knowledge/tests packages/experimental/knowledge-local/tests packages/experimental/tool-knowledge/tests --coverage --coverage.include='packages/experimental/knowledge-local/src/**/*.ts' --coverage.include='packages/experimental/tool-knowledge/src/**/*.ts'`：27 个文件通过、1 个文件按环境跳过，439 个测试通过、2 个测试跳过，纳入范围的 statement、branch、function 和 line 覆盖率均为 100%。
- `pnpm exec vitest run --config vitest.snapshot.config.ts examples/headless-agent/tests/headless.snapshot.ts -t 'retrieves cited evidence through the assembled knowledge tool'`：真实 Loader 组合快照通过。
- `DSH_BGE_MODEL_CACHE_DIR=<local-cache> pnpm vitest run packages/experimental/knowledge-local/tests/model-cache-smoke.spec.ts -t 'Dense local model smoke'`：真实 BGE-M3 本地缓存烟测通过；缓存路径未写入产物。
- `pnpm run typecheck`、`pnpm run lint`、`pnpm run doc-sync`、`pnpm run hygiene` 和 `git diff --check`：通过。

原始前缀、复核明细、模型、向量、SQLite 缓存、实验索引和包含本机绝对路径的日志保留在忽略目录，不属于提交范围。

## 6. 后续边界

本阶段不提供在线索引增量更新、HNSW 原地修改、多段索引、远程缓存、权限系统或生产 LLM 前缀服务。后续 6.1 真实评测也未通过发布门槛，产品索引接入已撤回；结果见[第六阶段 6.1 验收报告](rag-plugin-phase-six-one-acceptance-report.md)。
