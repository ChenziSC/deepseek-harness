# 第四阶段评测数据

[English](README.md) | 中文

## 自动路由

本目录包含 T2Ranking 10k 格式 3 索引的两个固定查询组。索引清单 SHA-256 为 `55b23dd3d7ab47f6f89b81ef900634f9979a3b59bb05222f196932ab57938e6c`；语料 SHA-256 为 `1d800b8a4d78f0252f35b0ae66f351d089ca6d380a35f73f81969e024caab960`。

`automatic-routing-cross-script-queries.tsv` 是 20 条 T2Ranking 中文查询的人工核验英文改写，保留原查询 ID 和 qrels。全部查询由 `latin` 脚本规则识别，在 CJK 语料上预期路由到 Dense。

`automatic-routing-identifiers-queries.tsv` 从索引正文中逐字抽取 18 个唯一电话号码和两个唯一代码标识符。对应 qrels 只标注包含该完整标识符的文档；全部查询预期路由到 BM25。

这些文件只评估路由和检索，不提供通用问答样本。普通同脚本查询继续使用同一 10k 切片原有的 `queries.tsv` 与 `qrels.tsv`。

## 自适应 Reranker

`reranker-threshold-evaluation-summary.json` 汇总 T2Ranking 100 条查询与 SciFact 30 条查询的 BM25、Dense、Hybrid `off`/`on` 明细，并按未重排 top-2 分差模拟固定候选阈值。文件保留每个阈值的触发集合摘要、触发率、MRR@10 与 nDCG@10 增益保留比例、整体及触发和未触发查询延迟。

原始 `report.json`、`queries.jsonl` 和索引位于 `.cache`，不进入提交。汇总记录查询、qrels、语料和索引摘要，可以检测本地输入是否一致。阈值模拟对触发查询采用同一查询的 `on` 排名和延迟，对未触发查询采用 `off` 排名和延迟；报告中选出的阈值另以真实 `auto` 运行验证。

## 两轮证据收集

`multi-hop-samples.jsonl` 包含原始 100 条合取问题。每条问题组合两个不同的 T2Ranking 开发集查询，并携带两部分各自的官方正例文档 ID。`multi-hop-deterministic-queries.tsv` 和 `multi-hop-deterministic-qrels.tsv` 将首轮与补充检索展开给普通评测器；`multi-hop-data-summary.json` 记录构造参数和摘要。

`multi-hop-semantic-review.jsonl` 记录使用受限提示对每条原始样本执行的独立 Agent 复核。复核者检查文档正文，不把官方 qrels 当作支持性证明。只有 51 条样本的两个子问题和两组证据均通过；49 条至少有一组证据不能直接支持子问题，或子问题本身不完整。`multi-hop-semantic-review-summary.json` 记录复核约束、数量、ID 和摘要。因此原数据集不能用于产品效果结论，只保留为诊断输入。

`multi-hop-validated-samples.jsonl` 是重建后的 100 条样本。`multi-hop-validated-semantic-review.jsonl` 记录最终内容的独立复核，100 条全部通过。`multi-hop-validated-queries.tsv` 和 `multi-hop-validated-qrels.tsv` 展开两条预定义查询，文件名含 `combined` 的对应文件把完整合取问题作为一条查询。`multi-hop-validated-data-summary.json` 记录构造方法、复核限制、数量和文件摘要。

`multi-hop-baseline-summary.json` 记录有效样本上的完整问题单次检索、成本对齐单次检索和两条预定义查询 Oracle。`multi-hop-agent-baseline-summary.json` 记录工具强制单查询 Agent 和自主决策 Agent，包括生成查询、证据覆盖、调用分布、被拒绝调用、引用检查、延迟和 token 用量。较早的 `multi-hop-deterministic-summary.json` 与 `multi-hop-agent-summary.json` 只保留为无效原始样本的诊断结果。模型原始结果和会话日志保留在 `.cache` 与 `.sessions`，不进入提交。

## 两轮触发判断

`retrieval-decision-samples.jsonl` 包含 100 条混合请求：25 条单主题、25 条双主题、20 条需要首轮桥接标识符的中间事实问题、15 条首轮已充分的复合问题和 15 条首轮证据冲突问题。前两类复用已核验 T2Ranking 样本；后三类使用 `retrieval-decision-controlled-corpus.jsonl` 的固定受控语料。

`retrieval-decision-data-summary.json` 记录样本、受控语料的数量和 SHA-256。`retrieval-decision-evaluation-summary.json` 记录真实 Loader 的继续与停止判断、最终证据覆盖、桥接标识符、冲突处理、调用限制、引用、延迟和 token 指标。受控语料为每条样本派生独立的小型 BM25 索引，不生成 Dense 向量；索引、原始模型输出和会话日志不进入提交。

## Markdown 分片消融

`markdown-ablation-files.json` 固定 revision `955a9acb56acfbc9b0c7ff3760550d6819fb2f75` 下的 20 个仓库 Markdown 文件，并记录逐文件 SHA-256 和字节数。`markdown-ablation-samples.jsonl` 包含 25 条人工核验查询，标题、章节正文、围栏代码、跨块证据和重复标题各 5 条。全部必需短语都已在固定 revision 的相关文档中核验。

`markdown-ablation-evaluation-summary.json` 比较固定 token 窗口、关闭相邻扩展的 Markdown 结构边界，以及在同一 Markdown 索引上前后各扩展一个相邻分片。文件记录构建数量和耗时，以及 BM25、Dense、Hybrid 的 MRR@10、nDCG@10、Recall@5/10/20、证据完整率、返回 token、完全重复片段、章节路径和延迟。排名指标使用 20 条命中，证据和 token 指标使用模型工具默认的 5 条预算。索引、向量缓存、展开语料和逐查询输出保留在 `.cache`，不进入提交。
