# 第 9 课参考答案：子 Agent、后台 Job 与 Agent Teams

[返回第 9 课](../09-subagents-jobs-teams.md)

## L9-C1

`tool-subagent` 只拥有模型入口、Schema、Provider 选择和模型可见结果；Subagent Provider 拥有 Child Agent、外部进程或远程连接；Continuation Manager 拥有父子多轮消息的串行化与失效收敛；Job Registry 拥有后台查询、等待和停止。Pi Extension 可以在一个扩展内同时承担这些职责，Claude Agent Task 也能在产品任务系统中协调它们。DSH 的拆分让执行 Provider 可替换、后台机制可承载非 Agent 工作，并避免“可继续通信”被误认为“后台运行”。

## L9-Q1

> 为什么新增 Codex Subagent Provider 不应该修改 `tool-subagent` 的 Tool 执行分支？Provider 和 Consumer 各自负责什么？

### 参考答案

`tool-subagent` 是 Consumer，负责模型可见 Schema、选择 Provider、校验委派深度和前后台模式，并把统一结果返回模型。Codex Provider 则实现外部进程或 Wire 协议、资源释放、取消和失败转换，再注册到 `SubagentRuntime`。若 Tool 为每个 Provider增加分支，模型接口会与进程实现耦合，其他 Consumer 也无法复用 Provider。Registry 让新增实现只需注册，不改变统一 Tool 语义。

## L9-Q2

> Spawn 和 Fork 在历史继承上有什么根本差异？为什么 Fork Boundary 必须位于闭合 Turn？

### 参考答案

Spawn 创建新的 Session 和 Agent 环境，只继承调用方显式传入的任务、工作目录、模型与允许的 Scoped Composition；Fork 则复制父 Session 到某个边界的完整事件前缀，并记录父子血缘和 Seed 长度。边界必须结束于闭合 Turn，否则 Child 会从开放 Step、缺少结果的 Tool Call 或未确定终态中继续，得到违反协议且无法可靠恢复的半段历史。

## L9-Q3

> 一个 Subagent 可以是前台或后台，为什么“Subagent”和“Job”仍然不能视为同一个概念？

### 参考答案

Subagent 描述“工作由另一个 Agent Runtime 执行”，包含 Provider、Child Session、Agent 身份和结果语义；Job 描述“某项已启动工作由后台 Registry 持有，可查询、等待或停止”。Subagent 可以前台同步等待，也可以把 Child Run 注册为后台 Job；Job 还可以承载非 Agent 工作。因此执行者类型和调度/所有权模式是正交维度，不能用一个概念替代另一个。

## L9-Q4

> Continuable Child 为什么需要专门的 Continuation Manager，而不能让父子直接共享一个消息数组？

### 参考答案

Continuable Child 有自己的 Session、Driver 和生命周期，同一时刻只能接受一个有序操作。Continuation Manager 负责序列化消息、处理并发发送、确认 Child 是否仍活跃，并在完成、取消或 Provider 失效时收敛等待者。共享数组既没有操作身份和确认，也无法阻止两次继续同时驱动 Child；父子还会争用可变状态，使取消、错误归属和持久化顺序无法确定。

## L9-Q5

> Prompt 中写“最多委派一层”为什么不够？结构化 `delegationDepth` 解决了什么问题？

### 参考答案

Prompt 只是给模型的行为建议，模型可能忽略、误解，外部 Provider 也可能根本不消费同一 Prompt，因此不能作为资源或权限限制。`delegationDepth` 写入 Session Header，并由 Tool 配置和 Child Composition 在宿主执行时检查，使每次委派都有可验证的当前深度。它能跨恢复和 Provider 保持一致，阻止无限递归扩张成本、进程和权限范围。
