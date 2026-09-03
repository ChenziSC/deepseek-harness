# DeepSeek Harness 课程参考答案

[English](README.md) | 中文

每课使用一个独立答案文件，全部结论都以当前 DeepSeek Harness 仓库为依据。答案侧重设计理念、职责划分、运行时序和状态所有权，不做逐行实现讲解。

开始答题前先阅读对应课程；每课的 `C1` 是 Pi/Claude/DSH 对照题，`Q1...` 是 DSH 架构题，参考答案均在对应文件中。[课程关系图](../course-roadmap.md)用于选择顺序。L0–L5 是必修主干；L6–L8 与 L9–L11 是两条不同分支，不需要交替答题。

## 必修主干答案

1. [第 0 课答案：从命令入口到插件树](00-entry-and-composition-answers.md)
2. [第 1 课答案：Cordis 生命周期与“一切皆插件”](01-cordis-lifecycle-answers.md)
3. [第 2 课答案：Session、AgentRegistry 与 AgentLoop](02-session-agent-loop-answers.md)
4. [第 3 课答案：一次 Turn 如何经过多个 Step](03-turn-step-runtime-answers.md)
5. [第 4 课答案：模型可见为什么必须能够重建](04-reconstructable-model-context-answers.md)
6. [第 5 课答案：持久化、Projection 与恢复](05-persistence-projection-recovery-answers.md)

## 产品表面分支答案

7. [第 6 课答案：Web Host 如何投影同一个 Agent 运行时](06-web-host-runtime-answers.md)
8. [第 7 课答案：动态 Client Module 与 Slot 页面组合](07-client-modules-and-slots-answers.md)
9. [第 8 课答案：输入、附件与模型请求投影](08-input-attachment-request-projection-answers.md)

## 能力扩展分支答案

10. [第 9 课答案：子 Agent、后台 Job 与 Agent Teams](09-subagents-jobs-teams-answers.md)
11. [第 10 课答案：Credential Reference 与交互授权](10-credentials-authorization-answers.md)
12. [第 11 课答案：完整能力接缝与代码执行](11-capability-seams-code-execution-answers.md)

## 使用方式

1. 先阅读课程并独立回答课后题。
2. 再打开对应答案文件，逐题核对职责、时序和状态归属。
3. 对不一致的结论，沿答案给出的源码锚点回看，不需要追逐实现细节。
4. 最后用自己的语言重新回答；能解释“为什么这样分层”比复述答案更重要。
