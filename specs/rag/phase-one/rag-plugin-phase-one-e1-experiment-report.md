# DSH RAG 插件 E1 实验结论报告

本文记录第一阶段 E1 实现完成后的一次固定 SciFact 本地实验。实验范围、算法选择和验收标准见[概要设计](rag-plugin-phase-one.md)，接口与数据格式见[详细设计](rag-plugin-phase-one-detailed-design.md)，任务边界见[实施任务](rag-plugin-phase-one-implementation-tasks.md)。本报告只解释本次实验结果，不将单一英文数据集和单台机器的结果推广为通用结论。

## 1. 实验目标

本次实验在相同语料、分片、查询、候选数量和评测器下比较六条检索路径：BM25、Dense、Hybrid，以及三者分别开启跨编码器 Reranker 后的结果。实验回答三个问题：Dense 是否优于词项匹配基线，Hybrid 是否能扩大召回覆盖，以及 Reranker 提升排序质量时需要付出多少本地延迟。

评测只覆盖检索阶段，不调用生成模型，也不评价最终回答的事实正确性、引用完整性或语言质量。

## 2. 数据、模型与运行环境

| 项目 | 本次实验值 |
| --- | --- |
| 数据集 | BEIR SciFact test split，英文科学事实核验数据 |
| 评测查询 | 300 条 |
| 语料文档 | 5,183 篇 |
| 索引分片 | 6,673 个 |
| 运行平台 | macOS 25.6.0，arm64，Node.js 22.22.0 |
| Dense 模型 | `onnx-community/bge-small-en-v1.5-ONNX`，固定 revision `4a9a46c7b88fa408e650a571a1800243f26309bd`，q8 |
| Reranker 模型 | `onnx-community/bge-reranker-v2-m3-ONNX`，固定 revision `6f5ff65298512715a1e669753bc754d2bc8f367b`，q8 |
| 模型缓存 | 约 593 MiB |
| 索引体积 | 27,660,653 bytes，约 26.4 MiB |
| 索引构建耗时 | 214,963 ms，约 3 分 35 秒 |
| 六组评测总耗时 | 约 2 小时 49 分钟 |

语料 SHA-256 为 `dec31c8182f3d744c7d2c09423756fd1d17cbef75808db13ba01cc0aab4d1ac6`，索引清单指纹为 `49eda0c8066c9fd33f91af17570046ad20b6b13fa86fa51e5c4db9732ff5d0f4`。模型、数据集、完整索引和原始报告保存在仓库外的 `$HOME/.cache/deepseek-harness-rag-e1/`。

## 3. 固定实验配置

| 配置 | 值 |
| --- | ---: |
| 分片最大长度 | 384 token |
| 分片重叠 | 64 token |
| BM25 `k1` | 1.2 |
| BM25 `b` | 0.75 |
| Dense 向量维度 | 384 |
| Dense 输入上限 | 512 token |
| 单路候选数 | 50 |
| RRF `k` | 60 |
| Reranker 批大小 | 8 |
| Reranker 输入上限 | 512 token |
| 文档结果深度 | 20 |
| 延迟预热查询 | 10 |

BM25 使用 `english-v1` 分析器；Dense 使用 CLS pooling、L2 归一化和 float32 精确点积扫描；Hybrid 顺序执行 BM25 与 Dense 后使用 RRF 融合；Reranker 对召回阶段的前 50 个候选按原始 logit 重排。评测先把分片结果折叠为唯一文档，再计算文档级指标。

## 4. 质量结果

| 召回方式 | Reranker | Recall@1 | Recall@5 | Recall@10 | Recall@20 | MRR@10 | nDCG@10 | Success@20 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BM25 | 否 | 53.33% | 72.04% | 78.98% | 83.26% | 63.11% | 66.58% | 85.00% |
| BM25 | 是 | 62.15% | 77.22% | 82.67% | 85.37% | 70.91% | 73.20% | 86.67% |
| Dense | 否 | 57.93% | 76.23% | 82.29% | 87.80% | 68.34% | 71.07% | 88.33% |
| Dense | 是 | 62.55% | 79.52% | 85.52% | **91.10%** | 72.10% | 74.82% | **91.67%** |
| Hybrid | 否 | 55.51% | 76.28% | 84.04% | 89.61% | 67.09% | 70.74% | 90.67% |
| Hybrid | 是 | **62.98%** | **81.03%** | **86.22%** | 91.03% | **72.72%** | **75.50%** | **91.67%** |

Recall 衡量全部相关文档中被找回的比例；Success 只判断前 `k` 个结果中是否至少存在一个相关文档，因此两者不能互换。MRR 更关注第一个相关文档的位置，nDCG 同时考虑排序位置与相关性等级。

## 5. 延迟结果

| 召回方式 | Reranker | p50 | p95 |
| --- | --- | ---: | ---: |
| BM25 | 否 | 5.51 ms | 6.97 ms |
| BM25 | 是 | 12,009.99 ms | 13,165.71 ms |
| Dense | 否 | 9.15 ms | 10.16 ms |
| Dense | 是 | 10,539.60 ms | 11,444.38 ms |
| Hybrid | 否 | 14.18 ms | 15.87 ms |
| Hybrid | 是 | 10,478.63 ms | 11,361.73 ms |

未开启 Reranker 时，三种方式的中位延迟均低于 15 ms。开启 Reranker 后，中位延迟上升到约 10.5 至 12 秒，说明本机 CPU 可以运行 `bge-reranker-v2-m3` q8，但不适合作为高频交互请求的默认阶段。延迟只包含预热后的单查询检索时间，不包含模型首次加载、数据准备、索引构建和最终答案生成。

## 6. 实验结论

### 6.1 Dense 是比 BM25 更强的单路基线

Dense 相比 BM25 将 Recall@20 从 83.26% 提高到 87.80%，MRR@10 从 63.11% 提高到 68.34%，nDCG@10 从 66.58% 提高到 71.07%，中位延迟只增加约 3.64 ms。在本次英文科学语料上，语义向量能够补充仅靠词项重合难以召回的相关文档。

### 6.2 Hybrid 主要改善召回覆盖，不保证最前位置更优

未重排序的 Hybrid 取得 89.61% 的 Recall@20，高于 Dense 的 87.80%，但 MRR@10 和 nDCG@10 略低于 Dense。RRF 扩大了候选覆盖，却没有自动得到最优的头部排序。这个结果说明 Hybrid 的主要价值是形成更完整的候选集，后续仍需要排序阶段决定最前面的证据。

### 6.3 Reranker 稳定改善排序质量，但成本远高于召回

Reranker 在三种召回方式上都提高了 Recall@1、MRR@10 和 nDCG@10。Hybrid 加 Reranker 获得最高的 Recall@1、Recall@5、Recall@10、MRR@10 和 nDCG@10；Dense 加 Reranker 以 0.07 个百分点的优势取得最高 Recall@20。两者的 Success@20 都是 91.67%。

质量提升伴随约三个数量级的延迟增长：毫秒级召回变为十秒级交叉编码。对于本地学习和离线质量实验，这个代价可以接受；对于交互式 agent，默认启用该 Reranker 会明显影响体验。

### 6.4 第一阶段推荐的实验使用方式

- 使用 BM25 观察倒排索引、词项贡献和可解释的稀疏检索基线。
- 使用 Dense 作为质量与速度均衡的单路语义检索方案。
- 使用不带 Reranker 的 Hybrid 观察多路召回和 RRF，对本机交互实验保持毫秒级延迟。
- 只在离线对比、低频查询或重点验证排序质量时启用 Reranker。

本次实验不支持把 Hybrid 加 Reranker 宣布为所有数据集的默认最优方案。它只是在当前 SciFact 配置上取得最好的综合头部排序指标。

## 7. E1 验收结论

E1 的学习与实验目标已满足：同一实现能够离线运行 BM25、Dense、Hybrid 和三条 Reranker 路径，并在完整 SciFact test split 上生成六组成功结果。索引记录语料、分片、模型 revision、配置和载荷哈希；Dense 与 Reranker 只从显式本地缓存加载；模型加载复用、失败后重试、基本取消和释放行为有自动化测试。

验证结果包括：三包测试 56 项通过、2 项按无真实缓存环境跳过；使用本地真实模型缓存的 Dense 与 Reranker 烟测 9 项通过；类型检查、构建、lint、文档检查和 `git diff --check` 通过。完整 SciFact 评测的六个组合均为 `success`，每组包含 300 个查询。

这些结果不代表 E2 已完成。正式提交所需的 Agent Note、真实 Loader 组合快照、许可证记录和当时变更范围要求的完整仓库集成检查仍由实施任务中的 RAG-100 管理。

## 8. 适用限制

- SciFact 只有英文科学主张与摘要，不能证明中文、代码、企业文档或通用问答场景的检索质量。
- 本次只有一台 arm64 macOS 机器和一次完整运行，没有统计跨机器差异、重复运行方差或置信区间。
- Dense 使用精确扫描，当前规模只有 6,673 个分片；结果不能推断大规模向量索引的吞吐和延迟。
- Reranker 每批处理 8 个文本对并顺序执行，本次结果不评价 GPU、Core ML、并发批处理或其他运行时优化。
- 评测只衡量检索结果，不衡量生成模型是否正确使用证据，也不衡量引用是否覆盖回答中的全部主张。
- 本次候选数固定为 50，未搜索 BM25、RRF、分片长度、候选数和模型的最优参数。

## 9. 复现命令

以下命令从仓库根目录运行。目标目录必须为空或不存在；完整六组评测在本次机器上约需 2 小时 49 分钟。

```sh
export RAG_E1_ROOT="$HOME/.cache/deepseek-harness-rag-e1-reproduce"

pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts prepare scifact \
  --data-dir "$RAG_E1_ROOT/data" \
  --model-cache-dir "$RAG_E1_ROOT/models"

pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts index \
  --corpus "$RAG_E1_ROOT/data/scifact/corpus.jsonl" \
  --corpus-format scifact \
  --output "$RAG_E1_ROOT/index" \
  --model-cache-dir "$RAG_E1_ROOT/models" \
  --components bm25,dense \
  --embedding-batch-size 32

pnpm exec tsx packages/experimental/knowledge-local/src/bin.ts evaluate \
  --index "$RAG_E1_ROOT/index" \
  --queries "$RAG_E1_ROOT/data/scifact/queries.jsonl" \
  --qrels "$RAG_E1_ROOT/data/scifact/qrels/test.tsv" \
  --model-cache-dir "$RAG_E1_ROOT/models" \
  --max-results 20 \
  --warmup-queries 10 \
  --output "$RAG_E1_ROOT/report"
```

评测完成后，`report.json` 是机器可读的指标与配置记录，`report.md` 是由同一 JSON 投影出的表格报告。
