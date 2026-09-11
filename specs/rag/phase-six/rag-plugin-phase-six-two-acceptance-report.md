# DSH RAG 插件第六阶段 6.2 验收报告

## 1. 验收结论

6.2 的行为保持型整理通过验收。正式检索策略、默认值、索引格式、SQLite schema、缓存身份和第六阶段既有实验结论均未改变；本阶段只收窄导出、明确产品与离线代码的依赖方向、合并同语义重复、拆分多职责文件，并写入后续迭代规则。

清理前 `pnpm run duplication` 报告 17 组克隆、214 行重复；清理后为 0 组、0 行。`index-builder.ts` 从 1,365 行降至 418 行，普通建库与 Exact 派生建库经过同一个生命周期函数。`cli.ts` 从 930 行降至 62 行，索引与派生命令分别由 254 行和 98 行的模块负责。原 709 行 `evaluation.ts` 由最大 269 行的六个离线评测模块替代，包根不再保留转发文件。原 602 行 `sqlite-index.ts` 拆为 390 行运行时读取器、190 行构建写入器和 46 行共享行投影。包根 `index.ts` 从 308 行降至 86 行，仅保留三个运行时导出。

## 2. 范围

本次验收覆盖 [`6.2 概要规格`](rag-plugin-phase-six-two.md)、[`详细设计`](rag-plugin-phase-six-two-detailed-design.md)和[`实施任务`](rag-plugin-phase-six-two-implementation-tasks.md)中的代码所有权、重复清理、大文件拆分、根导出、离线隔离、BM25 实现定位、迭代规则和验证要求。本阶段不重新运行完整数据集建库，不调用上下文前缀 LLM，也不调整任何质量阈值或产品策略。

## 3. 结构结果

| 项目 | 清理前 | 清理后 | 结论 |
| --- | ---: | ---: | --- |
| jscpd 克隆组 | 17 | 0 | 通过 |
| jscpd 重复行 | 214 | 0 | 通过 |
| `index-builder.ts` | 1,365 行 | 418 行，共享一套建库生命周期 | 通过 |
| `cli.ts` | 930 行 | 62 行分派器 + 254 行索引命令 + 98 行派生命令 | 通过 |
| `evaluation.ts` | 709 行 | 删除转发文件；由 38–269 行的 6 个模块直接负责 | 通过 |
| `sqlite-index.ts` | 602 行 | 390 行读取器 + 190 行写入器 + 46 行行投影 | 通过 |
| 包根 `index.ts` | 308 行、大量算法与评测导出 | 86 行、3 个运行时导出 | 通过 |

`src/build` 分别拥有语料暂存、分片与派生缓存、Dense 载荷、输出发布和共享类型。普通建库与 Exact 派生建库只保留各自的 Dense 差异，并经过同一个 `runBuildPipeline` 完成语料暂存、分片/SQLite 写入、资源关闭、载荷复验、manifest 生成与发布。

CLI 分派器只保留帮助文本、命令分派和统一错误处理；索引与派生命令各自拥有参数、依赖装配和输出。旧的评测转发层、测试专用 `buildBm25KnowledgeIndex` 别名，以及 `index-builder.ts` 对内部构建类型和 Dense 辅助函数的转发均已删除。调用方直接依赖实际所有者，避免新一轮便利导出。

`src/storage/cache-primitives.ts` 只共享长度分隔 SHA-256、SHA-256 格式校验和 SQLite immediate 事务。向量缓存、文档派生缓存与上下文前缀缓存继续拥有各自 schema、键、载荷和错误，不存在缓存基类。

`src/offline/contextual-prefix` 拥有上下文前缀规划、artifact、缓存、生成、OpenAI 适配和统计。`src/offline/evaluation` 拥有数据集评测、指标、矩阵、报告和旧内存 Okapi 评分器。正式 provider 与索引构建导入图不依赖 `src/offline`。

## 4. 根入口与 BM25 结论

包根只公开 `Config`、`LocalKnowledge` 与默认插件类，`package.json` 不再发布 `./src/*`。包内测试直接导入行为所有者，新增入口测试固定运行时导出集合，避免未来为了测试便利重新扩大公共 API。

内存 BM25 不再作为产品基线。它只在离线评测中提供词项级诊断和历史对照；正式运行时及数据集质量评测均使用 SQLite FTS5。这保留了诊断能力，也消除了两套 BM25 实现都像正式方案的歧义。

## 5. 后续迭代规则

[`packages/experimental/knowledge-local/AGENTS.md`](../../../packages/experimental/knowledge-local/AGENTS.md)规定：先确定 Loader/provider、索引构建、CLI 适配、存储或离线评测所有者；生产文件达到 400 行时审查职责；预计超过 500 行时先拆分；第二份复制出现时检查共享，第三份出现前必须统一或说明；产品代码不得依赖离线实验；不得为少量重复创建通用 CLI 框架、缓存基类或 repository 层。

当前超过 500 行的文件只剩离线 `contextual-prefix.ts`，它集中定义同一上下文前缀规划协议及其确定性选择、分组和预算逻辑，不位于产品依赖图。本阶段不为降低行数机械拆散该协议；后续若加入新的检测器或规划策略，应先按检测、分组和预算职责拆分。

## 6. 验证结果

| 验证 | 结果 |
| --- | --- |
| knowledge-local 全部单测 | 31 个文件通过、1 个模型缓存文件在无环境变量时跳过；551 个测试通过、2 个跳过 |
| 真实本地模型 smoke | BGE-M3 Dense 与 BGE Reranker 共 2 个测试通过 |
| 受影响源码覆盖率 | 新增 SQLite 行投影测试后按每文件 100% 门槛通过 |
| `knowledge-search` Loader 快照 | 1 个目标快照通过 |
| 小型 Exact/HNSW 建库 | `index-builder` 与 `index-format` 固定小语料测试通过 |
| 包 TypeScript 检查 | 通过 |
| `pnpm run lint` | 通过 |
| `pnpm run duplication` | 0 组重复，通过 |
| `pnpm run typecheck` | 通过 |
| `pnpm run doc-sync` | 通过 |
| `pnpm run hygiene` | 通过 |
| `git diff --check` | 通过 |

## 7. 限制

本阶段没有声称检索质量或建库性能提升，因为代码目标是保持行为并降低维护成本。完整数据集、完整向量与上下文前缀 LLM 评测均未重跑；第六阶段既有质量和性能结论继续由对应报告负责。

工作区仍包含第六阶段 6.1 与前序任务的未提交改动及本地覆盖率目录。本次实现没有清理这些目录，也没有执行 commit 或 push。
