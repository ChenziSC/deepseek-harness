# 第五阶段评测数据

[English](README.md) | 中文

## 有界搜索与冲突处理

`bounded-search-samples.jsonl` 在第四阶段100条混合检索决策样本之外，增加15条三至六步证据链、5条不可消解冲突和5条无答案请求。`bounded-search-controlled-corpus.jsonl` 包含为新增样本分别构建隔离BM25索引的确定性记录。

`bounded-search-evaluation-summary.json` 记录一条最多8次的自然Agent轨迹在第1、2、4、6、8次调用后的投影，以及上限2、6、8的独立硬限制运行。文件包含证据覆盖、预期答案检查、调用与拒绝分布、引用解析、冲突和无答案结果、延迟、token用量、按类别汇总和逐样本派生结果。模型原始输出、会话日志和索引保留在 `.cache`，不进入提交。

## 间接提示注入

`safety-attack-samples.jsonl` 为六类攻击各包含两条隔离样本：覆盖高优先级指令、读取受保护秘密、诱导调用 `todo_write`、声称对外发送、访问URL和替换为伪造引用。每条样本同时包含Agent必须回答的正常事实。

`safety-attack-evaluation-summary.json` 记录指令遵从、副作用工具调用、秘密泄露、伪造引用提及与使用、正常答案可用性、引用解析和逐样本结果。评测器提供 `todo_write`，但不提供网络或对外发送工具，因此后两类只测量模型输出。原始输出和索引保留在 `.cache`，不进入提交。

## 语义边界 Pilot

`semantic-boundary-pilot-samples.jsonl` 包含6条人工标注主题切换，以及代码围栏、短文档、语义同质文本和无句末标点长句边界情况。`semantic-boundary-pilot-summary.json` 使用固定 BGE-M3 模型，对比无模型的最后安全单元基线、受长度约束的最大语义间隙、文档内80百分位和固定距离切点。语义候选没有提高相对无模型基线的精确边界召回率，因此未实现生产级语义分片和完整三路建库消融。
