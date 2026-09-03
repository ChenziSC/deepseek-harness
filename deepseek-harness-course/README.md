# DeepSeek Harness source architecture course

English | [中文](README.zh.md)

This course is for readers who already understand the Pi Agent Loop and Claude Code product architecture. Instead of starting with “what is an agent,” it uses those two familiar implementations as reference points to explain why DeepSeek Harness uses a plugin graph, an event log, capability interfaces, and runtime Projections.

## Three reference systems

“Pi” means the minimal Agent Core in [packages/agent](../../pi/packages/agent/src/agent-loop.ts) unless a discussion of Session, authentication, or product entry points explicitly says “Pi coding-agent.” “Claude Code” means the local source copy you have already studied; this course compares architectural concepts without reproducing its non-public implementation.

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

Pi provides the minimal loop, Claude Code shows how a complex product adds sessions, tools, recovery, and context management around that loop, and DSH turns those responsibilities into replaceable plugins, explicit lifecycles, and replayable facts. The three systems address overlapping problems but optimize for different goals.

## The architectural dimensions DSH changes

| Architectural question | Pi agent core | Claude Code | DSH |
|---|---|---|---|
| How are capabilities composed? | The caller supplies Models, Tools, and Callbacks | Product startup composes various Managers and Registries | Profiles, Bundles, and Patches produce a Cordis plugin graph |
| Who drives a task? | `runLoop()` | `QueryEngine → query → queryModel` | `AgentRegistry → AgentLoop`; the Driver exclusively owns the execution chain |
| How is the system extended? | Callbacks, tool arrays, and product extensions | Hooks, Managers, Commands, Tools, and the product state machine | Services, Events, Effects, and Scopes; every contribution is a plugin registration |
| What is authoritative? | The core loop maintains Context Messages | Transcript, logical chains, and execution views jointly support recovery | The typed Session Event Log is the source of truth for model-visible state |
| How is state stored and read? | A product-layer Session Manager | JSONL, Parent chains, Compact Boundaries, and recovery repair | Persistence Providers, Repair, and Projection are explicit layers |
| How are implementations replaced? | Local interfaces such as Model and Tool | Several abstractions and specialized execution layers inside the product | Definition, Provider, and Consumer form a complete Capability Seam |
| What is the main cost? | The host must continue assembling product capabilities | Central state machines and cross-module rules raise cognitive cost | More plugins, events, and event types demand stricter composition and lifecycle discipline |

This table gives only the conclusions. Each lesson follows the current repository code to explain why DSH accepts these costs and which invariants it gains in return.

## The single execution path studied throughout the course

```text
配置选择能力
→ 插件把能力注册到运行时
→ Agent 领取输入并驱动模型与工具
→ Session 记录发生过的事实
→ Persistence 保存事实
→ Projection 为模型、恢复和产品界面计算读取状态
```

The twelve lessons are not twelve independent systems. They examine this one execution path from different perspectives.

## Course structure

### Required core: complete L0–L5 first

1. [L0: From command entry point to plugin tree](00-entry-and-composition.md) — how configuration becomes a runtime
2. [L1: Cordis lifecycle and “everything is a plugin”](01-cordis-lifecycle.md) — how plugins cooperate and unload
3. [L2: Session, AgentRegistry, and AgentLoop](02-session-agent-loop.md) — how the three core roles divide responsibilities
4. [L3: How one Turn passes through multiple Steps](03-turn-step-runtime.md) — how a task actually runs
5. [L4: Why model-visible state must be reconstructable from the log](04-reconstructable-model-context.md) — where model context comes from
6. [L5: Persistence, Projection, and recovery](05-persistence-projection-recovery.md) — how facts are stored and recovered

After completing the core, you should be able to trace user input through the model request, tool results, Session log, and process recovery.

### Product-surface branch: read L6–L8 to understand the Web application

7. [L6: How the Web Host projects the same Agent runtime](06-web-host-runtime.md)
8. [L7: Dynamic Client Modules and Slot-based page composition](07-client-modules-and-slots.md)
9. [L8: Input, attachments, and model-request projection](08-input-attachment-request-projection.md)

This branch explains how the same Agent core becomes a browser product. You can skip it initially when studying only the backend architecture.

### Capability-extension branch: read L9–L11 to understand plugin design

10. [L9: Subagents, background Jobs, and Agent Teams](09-subagents-jobs-teams.md)
11. [L10: Credential References, secret records, and interactive authorization](10-credentials-authorization.md)
12. [L11: Complete capability seams and code execution](11-capability-seams-code-execution.md)

This branch revisits Providers, Consumers, lifecycles, and cross-process validation through complex capability examples. It does not depend on the L6–L8 frontend material.

## How to read each lesson

Every lesson uses the same reading order:

```text
1. 先回忆 Pi 如何处理这个问题
2. 再定位 Claude Code 为产品复杂度增加的层次
3. 看 DSH 把职责放进哪些 Plugin / Service / Event / Log
4. 沿架构图或时序图走一遍
5. 最后打开源码锚点验证差异
```

Read each lesson three times:

```text
第一遍：只读三者对照、DSH 运行图和核心结论
第二遍：回答“DSH 为什么没有沿用 Pi / Claude 的组织方式”
第三遍：每套实现各打开一个源码锚点验证结论
```

If you can say only that “DSH has more packages” but cannot identify how responsibilities, lifecycles, or sources of truth changed, you have not yet completed the lesson.

## Recommended pace

```text
准备阶段：只看课程关系图
第 1 周：L0–L1，理解装配和插件生命周期
第 2 周：L2–L3，理解核心对象和真实运行时序
第 3 周：L4–L5，理解日志、持久化和恢复
第 4 周：只选一条分支
第 5 周：另一条分支与 L11 总复盘
```

Allow 45–60 minutes per lesson:

```text
10 分钟  读三者对照和运行图
15 分钟  不看源码复述 DSH 的取舍
15 分钟  分别打开一个对照源码和 DSH 锚点
15 分钟  回答编号问题
 5 分钟  记录仍然混淆的两个术语
```

## Side answer format

Keep each question number, for example:

```text
L3-C1：……（Pi / Claude / DSH 对照题）
L3-Q1：……
L3-Q2：……
```

Feedback will:

- first assess whether you understand the lesson's architectural problem;
- score each answer out of 10;
- distinguish conceptual confusion from missing implementation detail;
- correct conclusions with source facts without requiring implementation memorization;
- identify the exact concept or runtime step in this or the previous lesson to revisit.

A score around 7/10 is enough to continue. When concepts are mixed together, the feedback will point back to the comparison table, DSH runtime steps, or a conclusion from the previous lesson.

## Fixed analysis questions

For any module, answer these four questions first:

1. Does Pi place it in the loop, a callback, or the host product?
2. Does Claude Code place it in QueryEngine, query, a Provider, the Tool Pipeline, or the Transcript?
3. Does DSH turn it into a Plugin, Service, Event, Session Event, or Projection?
4. Which design owns the lifecycle, resources, and failure containment?

After mastering the core, add three more questions:

5. Which explicit protocol did DSH add to make the capability replaceable or recoverable?
6. What does that protocol cost, and at what scale is the cost justified?
7. Which log entry, snapshot, or UI behavior can verify the conclusion?

## Reading limits

The course follows the current workspace code and excludes `vendor/` and archived Agent Notes. The first pass does not require reading:

- type utilities and Schema details;
- extensive test implementations;
- React styling and local component state;
- Provider HTTP serialization details;
- generated directories and derived Catalogs.

Source line numbers can change with the workspace; file responsibilities matter more than any one line number.

## Completion criteria

After completing the course, you should be able to explain five invariants independently:

```text
插件注册具有可撤销生命周期。
一个 Agent 同时只有一条主驱动链。
所有模型可见输入都能从 Session 日志重建。
耐久事实、读取 Projection 和临时 UI 状态不能混用。
可替换能力由 Definition、Provider、Consumer 共同构成。
```

For each invariant, you should also be able to explain who typically owns it in Pi, how Claude Code enforces it through the product state machine, and why DSH promotes it to a plugin or log protocol.

Start with the [course roadmap](course-roadmap.md), then enter [L0](00-entry-and-composition.md). No other prerequisite reading is required.
