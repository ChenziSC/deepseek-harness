# 第 3 课参考答案：一次 Turn 如何经过多个 Step

[返回第 3 课](../03-turn-step-runtime.md)

## L3-C1

Pi 需要从 `currentContext.messages`、Tool Result 和宿主队列重新判断是否继续，除非产品层另行持久化循环状态。Claude Code 可以从 Transcript、Query State、未配对 Tool Use 和恢复逻辑判断是否需要修复或继续。DSH 会在日志中看到已闭合的当前 Step、Tool Result 以及尚未闭合或已修复的 Turn，再由新 Driver 和 Inbox 决定是否继续；Repair 会先补齐中断终态，而不是直接恢复旧局部变量。DSH 的区别是“欠不欠下一步”更多由可重放事实和显式协议解释。

## L3-Q1

> 为什么 `followup`、`steer` 和 `inject` 不能统一成“把消息加入一个数组并立即运行”？

### 参考答案

三者的目标阶段和唤醒语义不同：`followup` 进入 `next-turn` 并主动开始后续 Turn；`steer` 进入 `next-step` 并主动影响当前 Turn 的下一次模型请求；`inject` 也进入 `next-step`，但只提供上下文，不单独唤醒模型。统一为立即运行会让环境注入意外产生新请求，也可能把本应属于下一 Turn 的用户输入塞进已经开始的请求，破坏时序和审计含义。

## L3-Q2

> 一个 Turn 为什么可能没有 Step？这种记录对审计和恢复有什么价值？

### 参考答案

Harness 在领取输入和执行 `agent/pre-step` 前先记录 `turn/start`。如果输入被取消、Pre-Step 拒绝，或首批消息被改写为空，就不会产生 `step/start`，但仍会以 `turn/end` 闭合。这说明系统接受过一次工作责任，却没有花费模型请求。审计可以区分“从未发生”和“发生但被策略阻止”，恢复也不会把开放 Turn 误认为仍需继续执行。

## L3-Q3

> 三个并发安全 Read 后面跟一个 Edit，再跟一个 Read。哪些调用可以重叠，为什么最后一个 Read 不能越过 Edit？

### 参考答案

前三个 Read 可以进入有上限的并发池并重叠执行。Edit 是非并发安全调用，会形成 Barrier：它必须等待前面的 Read 收敛后独占执行。最后一个 Read 虽然自身并发安全，也必须等 Edit 完成，因为越过 Edit 会观察到旧状态，并使模型声明的调用顺序失去语义。并发优化只能发生在不改变副作用顺序的连续安全组内。

## L3-Q4

> 工具执行完成顺序和 `tool/result` 日志顺序为什么必须分离？如果按完成顺序记录，会影响哪些行为？

### 参考答案

并发工具的完成时间由 I/O 波动决定，而模型给出的 Tool Call 顺序是对话协议的一部分。Harness 可以按完成顺序展示进度，但最终 `tool/result` 必须按模型调用顺序写入，使相同输入得到稳定历史，并保持调用与结果的对应关系。若按完成顺序持久化，模型下一步看到的结果排列、Transcript、重放、快照和 Projection 都会随调度变化，产生非确定行为。

## L3-Q5

> 模型在 Step 1 调用工具后，为什么通常不结束 Turn，而是进入 Step 2？

### 参考答案

Tool Call 表示模型还缺少外部观察结果，尚未完成用户交付。工具执行后的 `tool/result` 已进入 Session Surface，AgentLoop 因而欠模型一次继续请求，让模型读取结果、决定是否再调用工具并生成最终回答。这个继续请求属于同一工作责任，所以产生 Step 2 而不是新 Turn；只有没有待偿还请求和 next-step 输入时，Turn 才进入停止流程。
