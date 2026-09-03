# 第 9 课：子 Agent、后台 Job 与实验性 Agent Teams

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课先拆开三个看起来都像“并行工作”的概念：

```text
Subagent：把一项工作交给另一个 Agent Runtime
Job：让一项已启动的工作在后台继续并可查询
Agent Team：多个可通信成员共享任务板和邮箱
```

它们的所有权、持久化和通信语义并不相同。

## 本课在课程中的位置

- **所属分支：**这是能力扩展分支的第一个案例，可以在完成 L5 后直接阅读，不依赖 L6–L8。
- **前置课程：**L1 的 Provider 与生命周期、L2 的 Agent 所有权、L3 的 Driver、L5 的耐久事实。
- **本课只新增一个判断：**Subagent 是委派能力，Job 是后台运行所有权，Team 是协作协议；“都能并行”不代表它们能合并。
- **第一遍重点：**阅读 Provider/Tool 分工、Spawn/Fork、Lifecycle 和 Job；递归深度与实验性 Agent Teams 是第二遍内容。
- **本课输出：**你将看到一个复杂能力怎样需要稳定接口、多个 Provider 和明确资源结算。L10 从安全角度展示另一个能力案例。

## 从 Pi / Claude 到 DSH：Subagent 从产品功能变成可替换能力

这三个问题经常同时出现，但它们属于不同维度：

| 概念 | 回答的问题 | 不自动包含什么 |
|---|---|---|
| Subagent | 工作是否交给另一个 Agent Runtime | 不保证在后台，也不等于团队 |
| Job | 已启动工作由谁在后台持有、查询和停止 | 不要求执行者是 Agent |
| Communication | Parent 和 Child 怎样继续交换消息 | 不等于共享可变状态 |
| Agent Team | 多个成员怎样共享任务、身份和邮箱协议 | 不只是同时启动多个 Child |

**Spawn**创建新的 Child 上下文，只传入明确允许继承的任务和配置；**Fork**复制父 Session 的一个合法历史前缀，让 Child 从该事实基线继续。二者都创建新的活跃执行所有权，但只有 Fork 继承 Session 历史。

每次委派还需要一个 Run Identity 和明确终态。Provider 可以拥有进程、远程连接或 Child Agent Context，但上层最终都必须看见 `completed`、`failed` 或 `cancelled`，否则 Parent、Job 和 Session 无法判断资源是否已经结算。

| 参照实现 | Subagent 位于哪里 | 后台与通信怎样表达 | DSH 的变化 |
|---|---|---|---|
| [Pi subagent extension example](../../pi/packages/coding-agent/examples/extensions/subagent/index.ts) | 宿主 Extension 可以基于现有 Agent 能力构造委派 | 扩展自己拥有 Child 与结果协议 | DSH 把委派 Provider Registry 放进正式能力层 |
| [Claude `LocalAgentTask`](../../claude-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx) | Agent Tool、Task 类型和 Query 产品状态共同支持 Child | Background Task、Teammate、Mailbox 等由产品任务系统组织 | DSH 将执行 Provider、Job 所有权、Continuation 和 Team 协议分开 |
| DSH | `SubagentRuntime` 是 Definition/Registry，`tool-subagent` 是 Consumer | Foreground/Background、One-shot/Continuable 是正交选择 | In-process、SDK、ACP、Codex 等 Provider 共享统一结算事实 |

DSH 具体多做的是让“由谁执行子任务”可替换，同时拒绝把 Subagent、后台 Job 和 Team 当成同一抽象。收益是新增 Provider 不修改模型 Tool，后台机制也能承载非 Agent 工作；代价是必须维护 Parent/Child/Run/Job 等多种身份和明确结算协议。

## 一、SubagentRuntime 是 Provider Registry

能力入口在 [SubagentRuntime](../packages/subagent/subagent/src/index.ts#L171)。它管理按名称注册的 Provider，而不是在一个 `switch` 中判断：

```text
spawn-in-process
fork-in-process
dsh-sdk
ACP
Codex
Claude Code
```

Provider 共享同一 `SubagentRequest` 和结果语义，但拥有不同资源：

- 进程内 Provider 拥有 Child Agent Context 和 Session；
- SDK Provider 拥有远程连接；
- Codex/Claude Code Provider 拥有外部进程或 Wire 协议；
- Fork Provider 还需要选择合法 Session Seed Boundary。

因此新增 Provider 时，`tool-subagent` 不需要增加分支。

## 二、Provider 和模型 Tool 是两个角色

[tool-subagent apply()](../packages/subagent/tool-subagent/src/index.ts#L278) 把 Subagent 能力注册成模型可调用 Tool。它负责：

- Tool Schema；
- Provider 名选择；
- 最大递归深度；
- 前台或后台模式；
- 结果如何返回模型；
- 模型可见 Prompt 指引。

它不负责实现 Codex Wire 或创建进程内 Child Agent。Tool 是 Consumer，Provider 才拥有具体执行方式。

## 三、Spawn 和 Fork 不是同一种继承

进程内 Spawn 通常创建一个新 Session 和新的 Agent 运行环境，只继承显式提供的任务、工作目录、模型选择和允许继承的 Scoped Composition。

Fork 则复制父 Session 的一个完整、闭合、可重放前缀：

```text
父 Session 事件 0..N
→ 验证 N 结束于完整 Turn
→ Child Header 记录 parentSession 与 seedLength
→ Child 从该历史继续
```

如果 Seed 停在开放 Step 或悬空 Tool Call 中间，Fork 必须拒绝。复制一半协议比不给历史更危险。

## 四、运行所有权和通信是两回事

Parent 启动 Child，并不意味着 Parent 永远同步等待 Child。子任务可以：

```text
foreground one-shot   当前 Tool 等 Child 完成
background one-shot   Child 后台完成，Parent 稍后收集
continuable           Child 可多轮接收消息并主动 report
```

Continuable Child 有明确的 Continuation Manager，参考 [continuation.ts](../packages/subagent/subagent/src/continuation.ts#L355)。它控制：

- 同一个 Child 同时只运行一个操作；
- Message 如何排队；
- Child 完成、取消或失效后谁负责收敛；
- Parent 何时可以重新发送消息。

Parent/Child 通信不是直接共享可变数组，而是具有身份和生命周期的操作。

## 五、Subagent Lifecycle 统一结算事实

[lifecycle.ts](../packages/subagent/subagent/src/lifecycle.ts#L137) 将不同 Provider 的运行包装成统一生命周期：

```text
创建 Run Identity
→ 记录开始事实
→ Provider 执行
→ 收集 Assistant Output
→ 结算 completed / failed / cancelled
→ 发布持久结果和后台通知
```

即使 Provider 进程异常退出，上层仍需要得到一个结构化终态，而不是一个永远 Pending 的 Tool Call。

## 六、Job 是通用后台所有权机制

[JobRegistry](../packages/jobs/jobs/src/index.ts#L62) 不等同于 Subagent。它可以承载任何有生命周期的后台任务。

模型侧 `job_*` 工具负责：

- 列出后台 Job；
- 读取输出；
- 等待结算；
- 停止不再需要的 Job。

Subagent Tool 可以选择把一个 Child Run 交给 Job Runtime 管理，但“这个工作由另一个 Agent 完成”和“这个工作在后台运行”仍是两个正交属性。

## 七、递归深度属于安全和资源边界

子 Agent 可以继续调用 Subagent Tool。如果没有委派深度：

```text
Parent
→ Child
  → Grandchild
    → ...
```

可能无限扩张成本、进程和权限范围。Harness 把 `delegationDepth` 写入 Session Header，并由 Child Composition 和 Tool 配置共同限制。

这不是只在 Prompt 中提醒模型，而是宿主执行时可检查的结构化限制。

## 八、Agent Teams 为什么放在 Experimental

Agent Teams 在 `packages/experimental` 中增加：

- Durable Roster；
- 共享任务 DAG；
- Mailbox；
- 成员间消息；
- Team 生命周期。

它建立在真实 Subagent 和 Session Runtime 之上，但没有进入官方 Bundle。原因是“多个 Child 同时运行”并不自动等于一个可靠团队；还需要任务所有权、重复领取、成员失效、消息顺序和团队结算等新协议。

## 九、完整委派流程

```text
模型调用 subagent Tool
→ Tool 校验 Provider、Depth、Background Mode
→ SubagentRuntime 解析 Provider
→ Provider 创建进程内或进程外 Run
→ Lifecycle 记录身份与开始事实
→ Foreground 等待，或注册为 Job
→ Child 产生结果 / report / failure
→ Lifecycle 结算
→ Parent 收到 Tool Result 或后台通知
```

## 本课核心结论

```text
SubagentRuntime 通过 Provider Registry 解耦委派接口和具体运行方式。
tool-subagent 是模型 Consumer，不拥有 Provider 实现。
Spawn 创建新上下文，Fork 复制合法的事件前缀。
Child 的执行所有权、后台运行和 Parent 通信是不同维度。
所有 Provider 都必须进入统一结算生命周期。
Job 是通用后台机制，不等于 Subagent。
递归深度必须由宿主结构化限制。
Agent Teams 还需要任务板和邮箱协议，因此保持 Experimental。
```

## 对照练习

`L9-C1`：Pi Extension 和 Claude Code Agent Task 都可以实现子任务。DSH 为什么仍把 `tool-subagent`、Subagent Provider、Continuation Manager 与 Job Registry 拆开？请用“模型入口、执行资源、通信、后台所有权”四个维度回答。

## 课后问题

1. `L9-Q1`：为什么新增 Codex Subagent Provider 不应该修改 `tool-subagent` 的 Tool 执行分支？Provider 和 Consumer 各自负责什么？
2. `L9-Q2`：Spawn 和 Fork 在历史继承上有什么根本差异？为什么 Fork Boundary 必须位于闭合 Turn？
3. `L9-Q3`：一个 Subagent 可以是前台或后台，为什么“Subagent”和“Job”仍然不能视为同一个概念？
4. `L9-Q4`：Continuable Child 为什么需要专门的 Continuation Manager，而不能让父子直接共享一个消息数组？
5. `L9-Q5`：Prompt 中写“最多委派一层”为什么不够？结构化 `delegationDepth` 解决了什么问题？

回答格式：

```text
L9-Q1: ...
L9-Q2: ...
L9-Q3: ...
L9-Q4: ...
L9-Q5: ...
```
