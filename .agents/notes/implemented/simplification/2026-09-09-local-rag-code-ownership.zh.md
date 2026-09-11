# Agent Note: 让本地 RAG 代码各归其主

Status: implemented

[English](2026-09-09-local-rag-code-ownership.md) | 中文

## 问题

实验性本地 RAG 包把多个独立职责积累在宽泛的包根入口和少数大文件中。[`index-builder.ts`](../../../../packages/experimental/knowledge-local/src/index-builder.ts) 同时包含语料暂存、分片派生、Dense 载荷构建、manifest 发布和 Exact 索引派生。[`cli.ts`](../../../../packages/experimental/knowledge-local/src/cli.ts) 同时负责命令分派与各命令的参数处理。[`sqlite-index.ts`](../../../../packages/experimental/knowledge-local/src/sqlite-index.ts) 同时负责构建期写入和运行时读取。离线上下文前缀与评测算法和 Loader 插件一起从包根导出，测试因此把包根当成便利 API，掩盖了各行为的实际所有者。

清理前，重复检查报告 17 组克隆、214 行重复。主要重复来自普通建库与 Exact 派生建库的收尾流程、三个独立 SQLite 缓存、上下文前缀脚本和离线输出校验。若继续在该结构中加入检索实验，同一批文件还会继续增长，后续删除也会更困难。

## 决策

实现前先把代码归入 Loader/provider、索引构建、CLI 适配、存储或离线评测。长期规则写入 [`packages/experimental/knowledge-local/AGENTS.md`](../../../../packages/experimental/knowledge-local/AGENTS.md)：生产文件达到 400 行时审查职责；预计一次修改会使其超过 500 行时先拆分；出现第二份复制时检查所有权；出现第三份前必须共享实现或就地说明；少量重复不能成为通用框架或基类的理由。

包根仅导出 Loader `Config`、`LocalKnowledge` 和默认插件类。包内测试直接导入拥有该行为的源码模块。包不再发布仅供开发使用的 `./src/*` 子路径。测试固定运行时导出集合，并遍历 provider 与 index-builder 的导入图，拒绝它们依赖 `src/offline`。

索引构建使用 [`src/build`](../../../../packages/experimental/knowledge-local/src/build) 下的专责模块。普通 Dense 编码与 Exact 向量派生保留各自的 Dense 操作，但都经过 `index-builder.ts` 中同一个建库生命周期：语料暂存、文档派生、SQLite 写入与关闭、载荷校验、manifest 组装和发布。SQLite 构建写入位于 [`sqlite-writer.ts`](../../../../packages/experimental/knowledge-local/src/sqlite-writer.ts)；运行时校验与查询保留在 [`sqlite-index.ts`](../../../../packages/experimental/knowledge-local/src/sqlite-index.ts)。

向量缓存、文档派生缓存和上下文前缀缓存只共享 [`cache-primitives.ts`](../../../../packages/experimental/knowledge-local/src/storage/cache-primitives.ts) 中的长度分隔 SHA-256、摘要校验和 immediate 事务。各缓存的 schema、键、载荷校验和诊断仍保持独立。62 行的 CLI 入口只负责帮助、分派和统一错误处理；`cli/index.ts` 与 `cli/derive.ts` 各自拥有命令默认值、依赖装配和执行。命令模块共享标量参数解析，但不引入通用 CLI 框架。

上下文前缀生成与检索评测位于 `src/offline`。包根原有的评测转发模块已删除，调用方直接导入评测所有者。旧的内存 Okapi 评分器只保留于此，用于词项级诊断和历史对照；运行时 BM25 与数据集质量基线使用 SQLite FTS5。这样不会再让两套评分实现看起来像同等的产品选项。测试直接调用产品入口 `buildKnowledgeIndex`，不再保留测试专用 BM25 别名；内部构建类型和 Dense 辅助函数也直接从所有者模块导入，不再经 `index-builder.ts` 转发。

## 备选方案

**为测试便利保留宽泛包根。** 这会让内部算法看起来受到支持，也会让测试固定偶然形成的 API。直接导入源码模块可以明确所有权，同时保持 Loader 入口小而可测。

**引入通用缓存、CLI、repository 或建库框架。** 当前共享行为比这些抽象更窄。框架会把可见重复替换为所有调用方都必须理解的配置与继承，但没有现实的第三个使用场景。

**删除所有失败实验代码。** 上下文前缀产物与内存评分器仍可复现既有评测并提供定向诊断。将它们保留在 `src/offline`，既保留这些价值，也不会把它们耦合到 provider 配置、索引格式或包根导出。

**执行全仓统一的文件行数上限。** 行数只能提示审查，不能证明职责混杂。本决策采用本包 400/500 行触发规则；职责清晰的表格、协议定义和离线算法可以保留。

## 后果

包内文件数量增加，测试使用更深的导入路径，但每个文件的变更原因更单一。`index-builder.ts` 从 1,365 行降到 418 行，并只拥有一个共享建库生命周期。`cli.ts` 从 930 行降到 62 行，索引与派生命令所有者分别为 254 行和 98 行。SQLite 读取器为 390 行，并配套独立的 190 行写入器。原 709 行评测模块由六个最大 269 行的所有者模块替代，包根不再保留转发文件。包根为 86 行，只包含三个运行时导出。最后一轮冗余清理后，包源码共 10,787 行，比清理前约少 20 行；`pnpm run duplication` 报告零组克隆。

此次重构不改变检索默认值、索引格式 4、SQLite schema 3、缓存身份、CLI 输出或评测结论。离线上下文前缀规划仍可使用，但 provider 和索引构建的依赖都不会到达它。结构测试、包测试、Loader 快照、小型索引构建和仓库检查共同固定这些结论。
