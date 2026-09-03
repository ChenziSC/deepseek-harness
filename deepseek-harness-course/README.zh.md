# DeepSeek Harness 源码架构课程

[English](README.md) | 中文

这套课程面向已经理解 Pi Agent Loop 和 Claude Code 产品架构的读者。它不再从“什么是 Agent”讲起，而是用两套熟悉实现作为坐标，解释 DeepSeek Harness 为什么选择插件图、事件日志、能力接口和运行时 Projection。

## 课程使用的三个参照系

“Pi”默认指 [packages/agent](../../pi/packages/agent/src/agent-loop.ts) 中的最小 Agent Core；讨论 Session、认证和产品入口时会明确写成“Pi coding-agent”。“Claude Code”指你已经学习过的本地源码副本，本课程只比较架构概念，不复刻其非公开实现。

```text
Pi agent core
调用者组装 model / tools / callbacks
        ↓
     runLoop
        ↓
context.messages 持续推进

Claude Code
QueryEngine（会话）
        ↓
query（任务状态机）
        ↓
queryModel / toolExecution（请求与副作用）

DeepSeek Harness
Profile / Bundle / Patch（组合）
        ↓
Cordis Plugin Graph（运行时能力图）
        ↓
AgentRegistry + AgentLoop（活跃执行）
        ↓
Session Event Log（事实）
        ↓
Persistence / Projection（耐久与读取）
```

Pi 给出最小循环，Claude Code 展示复杂产品如何围绕循环增加会话、工具、恢复和上下文管理，DSH 则进一步把这些职责变成可替换插件、显式生命周期和可重放事实。三者解决的问题重叠，但优化目标不同。

## 先看 DSH 改变了哪些架构轴

| 架构问题 | Pi agent core | Claude Code | DSH |
|---|---|---|---|
| 如何组合能力 | 调用者传入 Model、Tools、Callbacks | 产品启动与各类 Manager/Registry 组合 | Profile、Bundle、Patch 生成 Cordis 插件图 |
| 谁驱动任务 | `runLoop()` | `QueryEngine → query → queryModel` | `AgentRegistry → AgentLoop`，Driver 独占运行链 |
| 如何扩展 | 回调、工具数组、产品 Extension | Hook、Manager、Command、Tool 与产品状态机 | Service、Event、Effect、Scope；所有贡献都是插件注册 |
| 什么是事实 | 核心循环维护 Context Messages | Transcript、逻辑链和执行视图共同恢复 | Typed Session Event Log 是模型可见状态的事实来源 |
| 如何保存和读取 | 产品层 Session Manager | JSONL、Parent 链、Compact Boundary、恢复修复 | Persistence Provider、Repair、Projection 明确分层 |
| 如何替换实现 | Model/Tool 等局部接口 | 产品内多个抽象和专用执行层 | Definition、Provider、Consumer 组成完整 Capability Seam |
| 主要代价 | 产品能力需要宿主继续装配 | 中央状态机与跨模块规则认知成本高 | 插件、事件和事件类型更多，装配与生命周期纪律更严格 |

这张表只给结论。每一课会沿当前仓库代码解释 DSH 为什么付出这些代价，以及它因此获得了什么不变量。

## 整套课程只研究一条主链

```text
配置选择能力
→ 插件把能力注册到运行时
→ Agent 领取输入并驱动模型与工具
→ Session 记录发生过的事实
→ Persistence 保存事实
→ Projection 为模型、恢复和产品界面计算读取状态
```

十二课不是十二套独立系统。它们从不同角度观察这条主链。

## 课程结构

### 必修主干：先完成 L0–L5

1. [L0：从命令入口到插件树](00-entry-and-composition.md) — 配置怎样变成运行时
2. [L1：Cordis 生命周期与“一切皆插件”](01-cordis-lifecycle.md) — 插件怎样协作和卸载
3. [L2：Session、AgentRegistry 与 AgentLoop](02-session-agent-loop.md) — 三个核心角色怎样分工
4. [L3：一次 Turn 如何经过多个 Step](03-turn-step-runtime.md) — 一次任务怎样真正运行
5. [L4：为什么模型可见必须能够从日志重建](04-reconstructable-model-context.md) — 模型上下文从哪里来
6. [L5：持久化、Projection 与恢复](05-persistence-projection-recovery.md) — 事实怎样保存和恢复

完成主干后，应能从用户输入讲到模型请求、工具结果、Session 日志和进程恢复。

### 产品表面分支：想理解 Web 时读 L6–L8

7. [L6：Web Host 如何投影同一个 Agent 运行时](06-web-host-runtime.md)
8. [L7：动态 Client Module 与 Slot 页面组合](07-client-modules-and-slots.md)
9. [L8：输入、附件与模型请求投影](08-input-attachment-request-projection.md)

这条分支解释同一个 Agent 内核怎样成为浏览器产品。只学习后端架构时可以暂时跳过。

### 能力扩展分支：想理解插件设计时读 L9–L11

10. [L9：子 Agent、后台 Job 与 Agent Teams](09-subagents-jobs-teams.md)
11. [L10：Credential Reference、秘密记录与交互授权](10-credentials-authorization.md)
12. [L11：完整能力接口与代码执行](11-capability-seams-code-execution.md)

这条分支用复杂能力案例复习 Provider、Consumer、生命周期和跨进程验证。它不依赖 L6–L8 的前端细节。

## 每课现在怎样阅读

每课使用同一套阅读顺序：

```text
1. 先回忆 Pi 如何处理这个问题
2. 再定位 Claude Code 为产品复杂度增加的层次
3. 看 DSH 把职责放进哪些 Plugin / Service / Event / Log
4. 沿架构图或时序图走一遍
5. 最后打开源码锚点验证差异
```

建议分三遍：

```text
第一遍：只读三者对照、DSH 运行图和核心结论
第二遍：回答“DSH 为什么没有沿用 Pi / Claude 的组织方式”
第三遍：每套实现各打开一个源码锚点验证结论
```

如果只能说“DSH 包更多”，却不能指出职责、生命周期或事实来源发生了什么变化，说明还没有完成本课。

## 推荐节奏

```text
准备阶段：只看课程关系图
第 1 周：L0–L1，理解装配和插件生命周期
第 2 周：L2–L3，理解核心对象和真实运行时序
第 3 周：L4–L5，理解日志、持久化和恢复
第 4 周：只选一条分支
第 5 周：另一条分支与 L11 总复盘
```

每课建议 45–60 分钟：

```text
10 分钟  读三者对照和运行图
15 分钟  不看源码复述 DSH 的取舍
15 分钟  分别打开一个对照源码和 DSH 锚点
15 分钟  回答编号问题
 5 分钟  记录仍然混淆的两个术语
```

## Side 回答方式

保留问题编号，例如：

```text
L3-C1：……（Pi / Claude / DSH 对照题）
L3-Q1：……
L3-Q2：……
```

反馈会：

- 先判断是否理解了本课的架构问题；
- 每题按 10 分评估；
- 区分概念混用和实现细节遗漏；
- 用源码事实纠偏，不要求背诵实现；
- 明确指出应该回到本课或上一课的哪个概念区和运行步骤。

约 7/10 可以进入下一课；如果概念混淆，会明确指出应回到本课三者对照表、DSH 运行步骤或上一课的哪个结论。

## 固定分析问题

遇到任何模块，先回答四个问题：

1. Pi 把它放在循环、回调还是宿主产品中？
2. Claude Code 把它放在 QueryEngine、query、Provider、Tool Pipeline 还是 Transcript 中？
3. DSH 把它变成了 Plugin、Service、Event、Session Event 还是 Projection？
4. 三种设计中谁拥有生命周期、资源和失败收敛？

掌握主干后，再增加三个问题：

5. DSH 为可替换或可恢复新增了哪条显式协议？
6. 这条协议带来了什么成本，什么规模下值得？
7. 哪段日志、快照或 UI 现象可以验证结论？

## 阅读边界

课程以当前工作区代码为准，排除 `vendor/` 和归档 Agent Notes。第一遍学习时不需要阅读：

- 类型工具和 Schema 细节；
- 大量测试实现；
- React 样式和组件局部状态；
- Provider 的 HTTP 序列化细节；
- 生成目录和派生 Catalog。

源码行号可能随工作区变化；文件职责比单一行号更重要。

## 结业标准

完成课程后，应能独立解释五个不变量：

```text
插件注册具有可撤销生命周期。
一个 Agent 同时只有一条主驱动链。
所有模型可见输入都能从 Session 日志重建。
耐久事实、读取 Projection 和临时 UI 状态不能混用。
可替换能力由 Definition、Provider、Consumer 共同构成。
```

还应能对每条不变量回答：Pi 通常把它交给谁，Claude Code 怎样在产品状态机中保证它，DSH 为什么把它提升为插件或日志协议。

现在从[课程关系图](course-roadmap.md)了解主干，再进入 [L0](00-entry-and-composition.md)。不需要另读前置材料。
