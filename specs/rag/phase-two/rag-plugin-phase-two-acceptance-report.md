# DSH RAG 插件第二阶段验收报告

## 1. 验收结论

第二阶段的功能实现通过验收：插件已经具备中英文混合 BM25、BGE-M3 Dense、Exact、HNSW、Hybrid、可选 Reranker、受部署策略约束的工具调用、索引版本 2、离线准备命令和统一评测器。默认性能模式为 `hybrid + auto + rerank off`，质量模式开启 Reranker；召回默认保留 50 条候选，Reranker 默认只处理前 20 条。模型只能选择高层策略，不能设置底层检索参数。

数据集验收按轻量插件范围通过。SciFact 和 MLQA Retrieval `eng-zho` 完成全量评测；T2Ranking 和 MLDR 完成固定切片评测。T2Ranking 全量建库不属于本阶段必须项，默认 `50,000,000` 扫描元素阈值定位为可覆盖的保守甜点值，不再宣称为跨机器实测临界点。HNSW 与 Exact 的 Top-K 重合度保留为观察指标，数据集质量以标准 qrels Recall、MRR 和 nDCG 为准。

综合结论为：该实现适合作为学习、实验和开发者本地接入中小型知识库的轻量 RAG 插件。构建器会在 embedding 前按准确分片规模推荐 Exact-only 或 HNSW-only，交互式命令允许接入者确认或覆盖；只有明确的对照实验才保留 Both。当前证据仍不足以承诺百万级分片的单机建库时间或默认阈值的普适性。

## 2. 验收范围与环境

本报告验收第二阶段概要设计中的检索策略、多语言检索、索引格式、工具接入和数据集评测，不验收远程向量数据库、在线增量索引、分布式检索、多租户权限、向量量化或第二种 ANN 算法。

| 项目 | 值 |
| --- | --- |
| 机器 | MacBook Pro，Apple M4 Pro，48 GB 内存 |
| 操作系统 | macOS 25.6.0，arm64 |
| Node.js | 22.22.0 |
| Dense 模型 | `onnx-community/bge-m3-ONNX` |
| Dense revision | `25b9af8e87a38eb120cfe87125383677b9cd309e` |
| Dense 权重 | q8，`onnx/model_quantized.onnx` |
| Dense 输出 | 1024 维、CLS pooling、L2 归一化 |
| Reranker | `onnx-community/bge-reranker-v2-m3-ONNX@6f5ff65298512715a1e669753bc754d2bc8f367b` 的 q8 权重 |
| HNSW | USearch 2.26.2，cosine、f32、connectivity 16、expansionAdd 128、expansionSearch 1024 |
| 分片 | 最大 384 token，重叠 64 token |
| 评测候选数 | 100 |

所有质量指标使用数据集提供的 qrels。评测器先把分片命中折叠为唯一文档，再计算 Recall、MRR、nDCG 和 Success。Exact 与 HNSW 使用同一份 BGE-M3 向量、查询集和候选数；HNSW 的相对 Recall 衡量其结果与 Exact 前 k 项的重合度，不是对 qrels 的标准 Recall。

## 3. 数据集覆盖

| 数据集 | 实际范围 | 文档 | 分片 | 有效查询 | 验证目的 | 状态 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| BEIR SciFact | 全量测试集 | 5,183 | 7,231 | 300 | 英文回归、Hybrid、HNSW | 通过 |
| MLQA Retrieval `eng-zho` | 全量测试集 | 4,468 | 5,874 | 5,136 | 中文查询检索英文证据 | 通过 |
| T2Ranking | 首 100 个开发查询；首 5,000 篇 passage 加全部相关判断 passage | 5,405 | 12,258 | 91 | 中文检索、较大切片、资源成本 | 切片通过；全量未执行（非必需） |
| MLDR English | 前 20 个开发查询及其正负 passage | 160 | 7,678 | 20 | 英文长文档分片和检索路径 | 路径通过 |
| MLDR Chinese | 前 20 个开发查询及其正负 passage | 160 | 6,381 | 20 | 中文长文档分片和检索路径 | 路径通过 |

T2Ranking 的 9 个查询在所选文档切片中没有正例判断，因此标准质量指标只统计其余 91 个查询。MLDR 切片由查询携带的正负 passage 组成，候选集合比真实开放语料容易；其 100% 指标只能证明路径和分片可工作，不能代表完整 MLDR 或通用长文档检索质量。

## 4. 全量数据集结果

### 4.1 SciFact

| 路径 | Recall@20 | Recall@100 | MRR@10 | nDCG@10 | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dense Exact | 83.01% | 90.80% | 62.68% | 65.77% | 28.86 ms | 35.65 ms |
| Dense HNSW | 83.01% | 90.80% | 62.68% | 65.77% | 16.19 ms | 22.53 ms |
| Hybrid Exact | 87.46% | 94.60% | 66.62% | 69.85% | 63.94 ms | 85.02 ms |
| Hybrid HNSW | 87.46% | 94.60% | 66.65% | 69.87% | 52.86 ms | 74.55 ms |

SciFact 上 Hybrid 相比 Dense 提高了 Recall@20、Recall@100、MRR@10 和 nDCG@10，验证默认 Hybrid 对同语言一般检索是合理起点。HNSW 的 Dense p95 比 Exact 快 1.58 倍；该规模仍低于自动切换阈值，因此只记录为观察结果。

### 4.2 MLQA Retrieval `eng-zho`

| 路径 | Recall@20 | Recall@100 | MRR@10 | nDCG@10 | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BM25 | 11.64% | 13.73% | 7.37% | 8.14% | 0.09 ms | 1.48 ms |
| Dense Exact | 82.66% | 91.82% | 59.63% | 63.95% | 22.36 ms | 25.56 ms |
| Dense HNSW | 82.29% | 91.45% | 59.41% | 63.72% | 11.87 ms | 14.99 ms |
| Hybrid Exact | 82.62% | 91.82% | 48.76% | 55.57% | 22.83 ms | 26.70 ms |
| Hybrid HNSW | 82.29% | 91.51% | 48.56% | 55.35% | 12.02 ms | 15.79 ms |

MLQA 证明 BGE-M3 能以中文查询召回英文证据。BM25 缺少跨语言共同词项，召回率明显较低；将其融合进 Dense 还降低了 MRR@10 和 nDCG@10。默认 Hybrid 仍适合作为普通同语言知识库的通用默认值，但已知以跨语言检索为主的部署应把 `defaultRetrieval` 配置为 `dense`，用户也可以通过高层策略明确请求 Dense。

## 5. 固定切片结果

### 5.1 T2Ranking 中文切片

| 路径 | Recall@20 | Recall@100 | MRR@10 | nDCG@10 | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dense Exact | 95.91% | 97.31% | 86.26% | 86.25% | 39.62 ms | 42.35 ms |
| Dense HNSW | 95.78% | 97.26% | 86.26% | 86.07% | 13.08 ms | 14.65 ms |
| Hybrid Exact | 96.78% | 98.37% | 85.57% | 84.31% | 209.69 ms | 285.48 ms |
| Hybrid HNSW | 96.78% | 98.37% | 85.57% | 84.30% | 181.89 ms | 260.79 ms |

Dense HNSW 的 p95 比 Exact 快 2.89 倍。Hybrid 提高深层召回，但中文字符 unigram/bigram 的 SQLite FTS5 查询使 Hybrid 延迟达到百毫秒，说明 Reranker 不是唯一性能成本。

### 5.2 MLDR 长文档切片

| 语言与路径 | Recall@20 | Recall@100 | MRR@10 | nDCG@10 | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| English Dense Exact | 100% | 100% | 100% | 100% | 29.06 ms | 31.46 ms |
| English Dense HNSW | 100% | 100% | 100% | 100% | 14.59 ms | 16.85 ms |
| English Hybrid HNSW | 100% | 100% | 100% | 100% | 56.96 ms | 70.16 ms |
| Chinese Dense Exact | 95% | 100% | 90.83% | 91.78% | 25.41 ms | 30.55 ms |
| Chinese Dense HNSW | 95% | 100% | 91.00% | 91.93% | 12.03 ms | 17.42 ms |
| Chinese Hybrid HNSW | 100% | 100% | 93.50% | 95.09% | 173.47 ms | 286.74 ms |

长文档实验暴露并修复了分片器的性能缺陷。原实现对每个分片重复 token 化剩余全文和全文前缀；修复后使用局部指数扩展与二分定位分片末端，并只累计局部 token 位置。147,588 字节英文文档的分片时间从超过 5 分钟无结果降为 34.34 秒，生成 151 个分片。

## 6. HNSW 验收

| 数据集 | Dense Exact p95 | Dense HNSW p95 | 加速比 | 相对 Exact Recall@10 | 相对 Exact Recall@100 | 结果 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| SciFact 全量 | 35.65 ms | 22.53 ms | 1.58× | 99.93% | 99.71% | 召回通过；加速不足 2× |
| MLQA 全量 | 25.56 ms | 14.99 ms | 1.71× | 99.29% | 99.38% | 召回通过；加速不足 2× |
| T2Ranking 切片 | 42.35 ms | 14.65 ms | 2.89× | 99.45% | 99.17% | 通过 |
| MLDR English 切片 | 31.46 ms | 16.85 ms | 1.87× | 97.50% | 96.75% | 标准 qrels 指标不下降；重合度较低 |
| MLDR Chinese 切片 | 30.55 ms | 17.42 ms | 1.75× | 99.50% | 98.80% | 标准 qrels 指标不下降；Recall@100 重合度较低 |

`expansionSearch` 从 512 提高到 1024 后，SciFact、MLQA 和 T2Ranking 切片的 Recall@100 提升，同时 HNSW 仍快于 Exact，因此运行默认值确定为 1024。MLDR 从 1024 提高到 2048 没有形成有意义的改进，继续扩大搜索宽度不能解决该长文档切片的全部近似误差。

相同 SQLite 和 Exact 向量重新建图后，USearch HNSW 文件的字节数、摘要和 MLDR 相对 Exact Recall 发生变化。当前批量 `add` 使用原生库的自动线程数，不能把 HNSW 图声明为跨次构建字节确定；评测报告中的索引指纹用于绑定具体图产物。标准 qrels 指标在两次构建中保持 100%，但近似召回的变化说明后续阈值实验应至少重复建图并报告波动范围。

所有已完成索引只有 5,874 至 12,258 个向量，对应 601 万至 1,255 万扫描元素，均低于默认阈值 `50,000,000`。这些实验为了对照而显式保留 Exact 和 HNSW；相同规模使用 `auto` 时会生成 Exact-only。`50,000,000` 作为保守甜点值保留，接入者可在构建阶段覆盖，报告不把它解释为已测出的临界点。

## 7. Reranker 验收

| 数据集与样本 | 路径 | MRR@10 | nDCG@10 | Recall@1 | p50 |
| --- | --- | ---: | ---: | ---: | ---: |
| SciFact，30 查询 | Hybrid HNSW，无重排 | 72.34% | 75.65% | 56.11% | 51.56 ms |
| SciFact，30 查询 | Hybrid HNSW，重排 | 73.92% | 78.25% | 61.11% | 4,662.28 ms |
| MLQA，30 查询 | Dense HNSW，无重排 | 63.61% | 66.83% | 56.67% | 9.11 ms |
| MLQA，30 查询 | Dense HNSW，重排 | 72.14% | 74.09% | 66.67% | 3,116.99 ms |
| T2Ranking，20 查询 | Hybrid HNSW，无重排 | 80.17% | 81.65% | 18.39% | 175.00 ms |
| T2Ranking，20 查询 | Hybrid HNSW，重排 | 91.25% | 88.13% | 28.39% | 4,294.31 ms |
| MLDR Chinese，20 查询 | Hybrid HNSW，无重排 | 95.00% | 96.31% | 90.00% | 163.76 ms |
| MLDR Chinese，20 查询 | Hybrid HNSW，重排 | 100% | 100% | 100% | 4,333.24 ms |

Reranker 在 SciFact、MLQA、T2Ranking 和中文 MLDR 样本上提高了前排质量，但把本机 p50 增加到约 3.1 至 4.7 秒。英文 MLDR 样本在召回阶段已经饱和，重排没有质量收益；一次独立运行的 p50 为 4,381.85 ms，紧接长时间建库后的防休眠复跑为 16,745.89 ms，说明 CPU 温度与系统负载会显著影响本地延迟。默认关闭 Reranker、仅在质量优先请求中开启的设计通过验收。

为确认候选数默认值，在同一 SciFact 前 10 个查询上固定 Hybrid HNSW、召回 50 条、最终返回 20 条，仅改变重排候选数：

| 重排候选数 | Recall@20 | MRR@10 | nDCG@10 | p50 | p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 90.00% | 65.83% | 69.76% | 2,568.71 ms | 2,742.19 ms |
| 20 | 90.00% | 65.83% | 72.03% | 5,082.24 ms | 5,553.88 ms |
| 50 | 90.00% | 65.00% | 71.34% | 12,763.86 ms | 13,970.69 ms |

该小样本中，20 条相比 10 条提高 nDCG@10，相比 50 条质量没有下降且 p50 约快 2.5 倍，因此采用 20 作为不激进的默认甜点值。它仍是开发者可覆盖项，不作为跨数据集最优结论。

## 8. 构建、内存与磁盘

| 数据集 | 构建耗时 | 峰值 RSS | SQLite | Exact 向量 | HNSW |
| --- | ---: | ---: | ---: | ---: | ---: |
| SciFact 全量 | 34.87 分钟 | 未单独记录 | 25.15 MiB | 28.25 MiB | 29.27 MiB |
| MLQA 全量 | 24.53 分钟 | 未单独记录 | 18.26 MiB | 22.95 MiB | 23.77 MiB |
| T2Ranking 切片 | 48.15 分钟 | 7.75 GiB | 108.18 MiB | 47.88 MiB | 49.62 MiB |
| MLDR English 切片 | 54.99 分钟 | 7.71 GiB | 32.91 MiB | 29.99 MiB | 31.08 MiB |
| MLDR Chinese 切片 | 18.57 分钟 | 6.55 GiB | 69.80 MiB | 24.93 MiB | 25.83 MiB |

表中索引均为评测所需的 Both 产物，因此同时保留 Exact 和 HNSW。运行默认产物改为 Exact-only 或 HNSW-only：HNSW-only 仍编码全部向量并把向量和图保存在 `dense.usearch`，但不再额外保留大小相近的 `dense.f32le`。BGE-M3 的批量编码使当前实现峰值内存达到约 6.5 至 7.8 GiB；48 GB 机器可以运行这些切片，但不能据此承诺低内存机器或百万级分片的建库能力。

T2Ranking 全量原始 passage 共 2,303,643 条，下载文件约 3.4 GiB。全量建库尝试在 15 分钟后停止；根据固定切片的分片倍率、三个载荷体积和 CPU 编码速度粗略外推，完整索引可能占约 60 至 70 GiB，构建可能持续数天。该数字是容量估算，不是实测结果。受本机存储和实验时间约束，T2Ranking 全量规模验收不通过。

## 9. 默认策略结论

默认性能模式保留 `hybrid + auto + rerank off`。它避免了查询阶段最大的神经重排成本，并在 SciFact、T2Ranking 切片和中文 MLDR 切片中获得较好的深层召回。`auto` 仍按 `vectorCount × vectorDimension` 在构建时确定 Exact 或 HNSW，并把结果写入清单；模型不参与规模判断。

性能成本不只来自 Reranker。中文 BM25/Hybrid、BGE-M3 首次加载和查询编码、Exact 扫描以及离线建库都可能成为瓶颈。Reranker 是当前查询阶段最大的单项成本，因此“质量模式”必须由用户明确请求或由开发者配置为默认。

跨语言场景是默认 Hybrid 的已知例外。MLQA 中 BM25 几乎没有有效跨语言信号，并降低了前排排序质量；以跨语言为主的知识库应配置 Dense 为默认召回方式，而不是依赖每次提示词纠正。

## 10. 验收项结果

| 验收项 | 结果 | 证据或限制 |
| --- | --- | --- |
| 默认性能模式解析为 Hybrid、auto、关闭 Reranker | 通过 | 策略单元测试、工具集成测试和无密钥快照 |
| 明确质量优先开启 Reranker，普通查询不隐式开启 | 通过 | 工具 schema、系统提示词和快照 |
| 部署允许集合限制用户策略 | 通过 | Provider 策略测试覆盖禁止组合 |
| 索引格式 2、SQLite 只读、Exact 与 HNSW 延迟加载 | 通过 | 索引构建、格式校验和 Provider 生命周期测试 |
| 中文、英文和混排 BM25 | 通过 | 分析器手算测试与中文数据集运行结果 |
| BGE-M3 中文、英文和跨语言 Dense | 通过 | 真实模型烟测、SciFact、MLQA 和 MLDR |
| SciFact 全量报告 | 通过 | 300 个查询 |
| MLQA `eng-zho` 全量报告 | 通过 | 5,136 个查询 |
| MLDR 中英文报告 | 部分通过 | 固定 query-conditioned 切片，不是完整语料 |
| T2Ranking 中文规模报告 | 通过 | 固定切片完成；全量建库为可选压力测试 |
| HNSW 相对 Exact Top-K 重合度 | 观察项 | 各数据集均记录，不作为标准 qrels 质量门槛 |
| HNSW 相比 Exact 查询延迟 | 通过 | 所有样本均有收益，T2Ranking 切片达到 2.89 倍 |
| `50,000,000` 扫描元素默认值 | 通过 | 定位为可覆盖的保守甜点值，不声明跨机器临界点 |
| Exact-only、HNSW-only 和 Both 产物 | 通过 | 构建、清单校验、加载和缺失能力失败路径均有测试 |
| Reranker 默认只处理前 20 条 | 通过 | 10/20/50 小样本对照和候选截断单元测试 |
| 性能模式和质量模式分别报告收益与成本 | 通过 | 四组重排样本均记录质量和延迟 |
| 不引入远程数据库、第二种 ANN 或后台服务 | 通过 | 实现保持单机、离线构建、只读加载 |

## 11. 已知限制与后续建议

以下内容是后续可选实验，不阻塞第二阶段验收：

1. 在存储和时间充足的机器上把 T2Ranking 全量建库作为压力测试，记录 HNSW-only 的构建时间、峰值 RSS 和载荷体积。
2. 在更多领域数据上复核 20 条重排候选的质量与延迟；接入者可按自己的查询分布覆盖。
3. 如果中文 Hybrid 延迟成为实际瓶颈，再优化 SQLite FTS5 查询路径；当前不引入外部分词服务。
4. 若目标机器内存明显低于本机，增加批量大小实验后再给出容量建议。

这些事项保持为有数据支撑的后续实验，不扩展为远程服务、分布式索引、自动调参或生产监控平台。

## 12. 仓库验证

| 检查 | 结果 |
| --- | --- |
| RAG 三个包的定向覆盖率 | 21 个测试文件通过、1 个跳过；290 个测试通过、2 个跳过；语句、分支、函数和行覆盖率均为 100% |
| 真实 BGE-M3 与 BGE Reranker 本地缓存烟测 | 1 个测试文件、2 个测试通过；全程 `localFilesOnly: true` |
| Knowledge headless snapshot replay | 1 个场景通过；验证系统提示词、`knowledge_search` 调用、结果和会话记录 |
| `pnpm run typecheck` | 通过 |
| `pnpm run lint` | 通过 |
| `pnpm run doc-sync` | 28 项通过，0 项失败 |
| `pnpm run hygiene` | 13 项通过，0 项失败 |
| `git diff --check` | 通过 |

`hygiene` 的 vendor rescope 检查通过临时 Git index 验证完整待提交文件集合，因为正式 Git index 尚未暂存已删除的旧 `bm25.json` 和 `chunks.jsonl`；临时 index 不改变工作区或正式暂存区。真实模型烟测使用仓库内已准备模型缓存的绝对路径，避免 Transformers.js 将相对缓存路径按包目录再次解析。

全仓 `test:coverage` 还不能记为通过。默认并发的两次运行分别在既有的 subprocess 进程组终止测试和 bash 超时测试上出现一次时序失败，两项单独复跑均通过；限制为 8 个 worker 后，884 个测试文件通过、10 个跳过，14,867 个测试通过、116 个跳过，但仓库既有的 `packages/client/ui-permission-presets/src/client/presentation.ts` 第 28 行未达到逐文件 100% 覆盖率要求。该文件不在本次 RAG 改动范围内；全仓测试通过和全仓覆盖率门禁通过是两个不同结论。

## 13. 机器可读证据

本机机器可读报告保存在 `.cache/rag-phase-two/`，索引可按存储轮换策略删除，报告应保留用于复核。主要结果文件为：

- `scifact-report-hnsw-1024/report.json`
- `scifact-report-quality-default1024/report.json`
- `mlqa-eng-zho-report-hnsw-1024/report.json`
- `mlqa-eng-zho-report-quality-sample/report.json`
- `t2ranking-q100-d5000-report-hnsw-1024/report.json`
- `t2ranking-q100-d5000-report-quality-default1024/report.json`
- `mldr-en-q20-report-hnsw-1024/report.json`
- `mldr-en-q20-report-quality-default1024/report.json`
- `mldr-en-q20-report-hnsw-1024-pre-rebuild/report.json`
- `mldr-en-q20-report-quality-default1024-pre-rebuild/report.json`
- `mldr-zh-q20-report-hnsw-1024/report.json`
- `mldr-zh-q20-report-quality-default1024/report.json`

报告记录语料 SHA-256、索引指纹、模型 revision、HNSW 参数、查询数量、完整指标、延迟和载荷体积。T2Ranking 与 MLDR 切片的选择规则和输出摘要分别记录在 `.cache/rag-phase-two/slices/*/source.json`。
