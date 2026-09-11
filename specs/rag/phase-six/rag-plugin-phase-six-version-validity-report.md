# DSH RAG 插件第六阶段版本与有效期验收报告

机器摘要见 [`data/version-validity-evaluation-summary.json`](data/version-validity-evaluation-summary.json)，固定语料见 [`data/version-validity-corpus.jsonl`](data/version-validity-corpus.jsonl)。本报告验证版本元数据和按时点过滤的正确性，不把该能力描述为排序质量提升。

## 1. 结论

T1–T5 通过。Generic JSONL 可以记录来源版本、左闭右开的有效期和替代关系；`knowledge_search` 可以传入带时区的明确 `asOf`，BM25、Exact Dense、HNSW 和 Hybrid 在候选阶段使用同一查询时点排除尚未生效或已经失效的文档。

固定语料覆盖当前有效、尚未生效、结束边界、未知有效期、单边范围、替代链和两个版本同时有效。2026-06-01T00:00:00.000Z 边界上，四种召回路径均保留当时开始生效的 `c-starting`，排除恰好结束的 `b-ending`，并同时保留仍在有效期内的 `h-overlap-v1` 与替代它的 `i-overlap-v2`。这确认 `supersedes` 只提供证据关系，不会隐式删除旧版本。

## 2. 时点结果

| 查询时点 | 可检索文档数 | 关键行为 |
| --- | ---: | --- |
| 2025-06-01T00:00:00.000Z | 6 | 旧版本有效；新版本与未来文档尚未生效 |
| 2026-06-01T00:00:00.000Z | 6 | 开始边界包含、结束边界排除；两个旅行政策版本同时有效 |
| 2028-01-01T00:00:00.000Z | 6 | 未来文档已生效；有结束时间的旧旅行政策已失效 |

有效期未知的文档在三个时点均可检索，工具输出明确显示 `Validity: unknown`。单边有效期分别按无上界或无下界处理。无有效 Dense 候选时不会加载查询编码模型。

## 3. 构建复用

只改变 `source`、`sourceVersion`、`validFrom`、`validUntil` 或 `supersedes` 不改变分片、BM25 输入或 Dense 输入。自动化回归确认这种修改命中文档派生缓存和向量缓存，Exact 载荷逐字节一致，而最终 `documents` 行使用新元数据。

## 4. 工具证据

工具测试确认版本、有效期和替代关系位于不可信证据边界内，缺失字段使用明确的 `unknown`，引用编号连续且能够解析。模糊日期不会静默退回当前时间；无效 `asOf` 返回 `KNOWLEDGE_INVALID_REQUEST`。

## 5. 验证

定向验证命令及结果记录在机器摘要中。固定语料由提供方测试直接读取，防止报告样本与实际候选过滤回归分离。版本过滤属于时间正确性与来源可追踪性能力；本实验没有测量 Recall 或 nDCG 改善，也不据此宣称质量正收益。
