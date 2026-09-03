# 第 3 课：一次 Turn 如何经过多个 Step

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课是整个课程的运行时主线。核心问题是：

> 为什么“一条用户消息”不等于“一次模型请求”？

DeepSeek Harness 把一次由用户唤醒的工作称为 Turn，把一次模型请求及其工具调用称为 Step。一个 Turn 可以包含零个、一个或多个 Step。

## 本课在课程中的位置

- **前置课程：**L2 已经区分 Session、Registry 和 Loop；本课只展开 Loop 的时间顺序。
- **本课只新增一个判断：**一条用户输入开启一个 Turn，但工具结果可能让同一 Turn 产生多个模型 Step；唯一 Driver 拥有这条主链。
- **第一遍重点：**沿 `turn/start → pre-step → step/start → LLM → tool/result → step/end → turn/end` 阅读。三种 Inbox 输入和工具并发细节可在第二遍补充。
- **不要先记方法名：**先能画出一次包含工具调用的两 Step Turn，再打开 `agent.ts` 验证。
- **本课输出：**你已经看到哪些内容进入模型、哪些事件写入日志。L4 会追问：下一次模型请求怎样准确重建它们？

## 从 Pi / Claude 到 DSH：循环被写成可记录的控制协议

L2 说明 Session 保存事实、AgentLoop 驱动执行。本课继续把一次执行按时间尺度拆开：

```text
Session：可持续、可恢复的完整工作历史
└─ Turn：一次输入唤醒后，系统承担的一轮工作
   ├─ Step：一次模型请求，以及该请求触发的工具执行
   │  ├─ Tool Call
   │  └─ Tool Result
   └─ Step：工具结果可能要求模型再次推理
```

一条用户消息通常唤醒一个 Turn，但它不是 Turn 本身；一个 Step 对应一次模型请求，但它也不是整个 Turn。模型在第一个 Step 调用工具后，工具结果需要送入第二个 Step，两个 Step 仍属于同一个 Turn。

**Driver**是当前拥有这条主运行链的执行者。它负责按顺序开启和闭合 Turn/Step，响应取消，并决定是否还欠下一次 Step。一个 Agent 同时只能有一个 Driver，否则两个异步循环可能同时推进同一份 Session 计数和日志。

| 参照实现 | “继续循环”的表达 | 输入插入方式 | DSH 的变化 |
|---|---|---|---|
| [Pi `runLoop()`](../../pi/packages/agent/src/agent-loop.ts#L157) | 局部循环根据 Assistant/Tool Result 和回调继续 | Steering、Follow-up 回调返回消息 | Inbox 目标和 Driver 占用成为 Agent 状态 |
| [Claude `query()`](../../claude-code/src/query.ts#L274) | 显式 State/Transition 解释重试、压缩、Stop Hook 和下一轮 | QueryEngine 与消息队列协调 | Turn/Step 起止成为 Session Event，而非只存在于控制流 |
| [DSH `ReactLoopAgent`](../packages/core/agent-loop/src/agent.ts#L117) | 唯一 Driver 领取 Inbox，逐个闭合 Turn/Step | `followup`、`steer`、`inject` 分别进入 next-turn/next-step | 控制状态既能运行，也能恢复和审计 |

DSH 具体多做的是给运行循环建立一套宿主协议：Turn 表示工作责任，Step 表示模型请求，Inbox 表示尚未领取的输入，Driver 表示当前所有者。代价是事件数量和状态转换更多；收益是阻塞、取消、工具结果与恢复不再只靠某个长函数的局部变量解释。

## 一、三种输入进入不同 Inbox 目标

入口在 [ReactLoopAgent.send()](../packages/core/agent-loop/src/agent.ts#L117)：

| 方法 | Inbox 目标 | 是否主动唤醒 | 语义 |
|---|---|---:|---|
| `followup()` | next-turn | 是 | 开始后续 Turn 的普通用户输入 |
| `steer()` | next-step | 是 | 在当前活动结束前影响下一 Step |
| `inject()` | next-step | 否 | 注入上下文，等待其他输入唤醒 |

这三个方法不能合并成普通 `pushMessage()`。`inject()` 如果自动唤醒，会让仅用于下次请求的环境上下文单独触发模型；`followup()` 如果进入当前 Step，又会改变已经开始构造的请求。

## 二、Driver 占用保证一个 Agent 只有一条主驱动链

[wakeDriver()](../packages/core/agent-loop/src/agent.ts#L176) 在 Idle 状态取得 Driver 占用，并创建新的 AbortController。

如果 Agent 已经运行：

- 正常的下一 Step 输入留在 Inbox，活动 Driver 会领取；
- Maintenance 或已中止活动无法领取的新唤醒会被 Latch；
- Driver 收敛回 Idle 后再启动下一条驱动链。

这避免两个异步循环同时操作同一 Session 的 Turn/Step 计数。

## 三、Turn 在领取第一批输入前就记录开始

[turn()](../packages/core/agent-loop/src/agent.ts#L249) 首先追加：

```text
turn/start
```

然后才尝试从 Inbox 领取输入。

这样即使输入在领取前被取消，或 `agent/pre-step` 拒绝进入，也会留下一个完整的“这次工作尝试发生过”记录：

```text
turn/start
turn/end(reason = completed 或 blocked)
```

它可能没有任何 `step/start`。Turn 表达一次工作责任，而 Step 表达实际花费的一次模型请求。

## 四、Pre-Step 决定本次模型看什么

[preStep()](../packages/core/agent-loop/src/agent.ts#L229) 分成四步：

```text
从目标 Inbox claim 一批消息
→ 组装 System Prompt 和运行时上下文
→ 把动态上下文投影成可记录的 User Message
→ 经过 agent/pre-step Waterfall
```

Waterfall 最终返回：

```text
enter(messages)  接纳或改写消息
reject            阻止本 Step
```

Compaction、Hook、策略插件都可以在这里影响下一次模型请求，但返回的决定是权威结果。

## 五、Step 才真正调用模型

接纳 Step 后，Driver 追加：

```text
step/start
user/message × N
```

随后 [step()](../packages/core/agent-loop/src/agent.ts#L336) 执行：

```text
从 Session Surface 派生历史
→ 组装 System Prompt 与 Tool Schema
→ 解析 Provider/Model 的精确请求配置
→ 记录 request/header 和 request/context
→ 消费 LLM Stream
→ 记录 assistant/chunk*
→ 组装并记录 assistant/message
```

如果 Assistant Message 没有 Tool Call，Step 返回 `completed`。如果存在 Tool Call，则交给工具调度器。

## 六、工具结果会让同一 Turn 进入下一 Step

工具调度入口在 [executeToolCalls()](../packages/core/agent-loop/src/tool-calls.ts#L59)。每个调用最终记录：

```text
tool/call
tool/result
```

工具结果本身已经进入 Session Surface，因此下一个 Step 不需要把它重新塞进 Inbox。工具额外产生的动态上下文则进入 `next-step` Inbox。

第一个 Step 结束后，只要：

- 模型刚调用了工具；
- 工具返回了额外上下文；
- 用户进行了 Steering；
- 某个插件声明还需要一次模型请求；

当前 Turn 就会继续下一 Step。

真实快照 [tool-call-turn/session.jsonl](../examples/acp-agent/tests/snapshots/tool-call-turn/session.jsonl#L3) 展示了：

```text
Turn 1
  Step 1：模型调用 bash
  Step 2：模型读取工具结果并回答 DONE
```

## 七、工具并发不改变日志中的模型顺序

[runGroup()](../packages/core/agent-loop/src/tool-calls.ts#L121) 将并发安全工具放入有上限的滚动池，不安全工具形成 Barrier。

```text
Read A ─┐
Read B ─┼─ 可以重叠执行
Glob C ─┘
Edit D ─── 等前面完成，独占执行
Read E ─── 不能越过 Edit
```

即使完成顺序是 B、A、C，`tool/result` 仍按模型原始调用顺序提交。执行并发和历史确定性因此被分开。

## 八、结束顺序也是生命周期协议

每个已开始 Step 都在 `finally` 中记录 `step/end`。Turn 停止前，如果没有下一 Step 输入，会触发串行的 `agent/turn-stopping`，让 Goal 等插件获得最后一次继续机会。

最终记录：

```text
turn/end {
  completed | max-tokens | blocked | aborted | error
}
```

## 本课核心结论

```text
Turn 是一次被唤醒的工作责任。
Step 是一次模型请求及其工具调用。
Pre-Step 决定下一次请求能否进入以及模型看到什么。
工具调用通常让同一 Turn 进入下一 Step。
执行可以并发，持久结果仍保持模型顺序。
所有退出路径都要闭合 Step 和 Turn 记录。
```

## 对照练习

`L3-C1`：Pi `runLoop`、Claude `query State` 和 DSH `Turn/Step + Driver` 都能完成“模型调用工具后继续”。如果进程在工具结果后、下一次模型请求前退出，三者分别需要从哪里判断还欠不欠下一步工作？

## 课后问题

1. `L3-Q1`：为什么 `followup`、`steer` 和 `inject` 不能统一成“把消息加入一个数组并立即运行”？
2. `L3-Q2`：一个 Turn 为什么可能没有 Step？这种记录对审计和恢复有什么价值？
3. `L3-Q3`：三个并发安全 Read 后面跟一个 Edit，再跟一个 Read。哪些调用可以重叠，为什么最后一个 Read 不能越过 Edit？
4. `L3-Q4`：工具执行完成顺序和 `tool/result` 日志顺序为什么必须分离？如果按完成顺序记录，会影响哪些行为？
5. `L3-Q5`：模型在 Step 1 调用工具后，为什么通常不结束 Turn，而是进入 Step 2？

回答格式：

```text
L3-Q1: ...
L3-Q2: ...
L3-Q3: ...
L3-Q4: ...
L3-Q5: ...
```
