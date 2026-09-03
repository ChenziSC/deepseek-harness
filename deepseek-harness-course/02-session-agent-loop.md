# 第 2 课：Session、AgentRegistry 与 AgentLoop 的职责分离

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课修正一个常见误解：

> Agent 不是“消息数组 + 调模型函数”的单一对象。

DeepSeek Harness 把持久事实、活跃实例管理和具体驱动算法拆成三个角色。

## 本课在课程中的位置

- **前置课程：**L1 已经建立 Service、Event 和生命周期所有权；现在用这些概念拆解 Agent 核心。
- **本课只新增一个判断：**Session 保存事实，AgentRegistry 管理活跃实例，AgentLoop 提供驱动策略，三者不能合成一个“会话对象”。
- **第一遍重点：**只读前三节和“Agent 创建是一笔发布事务”；Handle 与 Initiator 属于生命周期深入内容。
- **自检问题：**进程退出后，Session 事实可以恢复，旧 Agent 对象却不会复活。你是否能解释原因？
- **本课输出：**你已经知道“谁负责什么”。L3 会进入 AgentLoop 内部，看它怎样驱动一次真实任务。

## 从 Pi / Claude 到 DSH：会话对象被拆成三个所有者

同一个任务同时存在三类状态。如果把它们都叫“会话”，后面的恢复、销毁和 UI 展示就会互相冲突。

| 状态类型 | 回答的问题 | 本课例子 | 进程退出后 |
|---|---|---|---|
| 耐久事实 | 已经发生过什么 | 用户消息、模型消息、工具结果 | 可以保存和恢复 |
| 活跃对象 | 现在由谁继续执行 | Agent、Driver、AbortController | 对象消失，只能重新创建 |
| 派生视图 | 某个读取者现在需要看什么 | 模型历史、会话列表、聊天节点 | 可从事实重新计算 |

Session 属于第一类：它拥有追加式事实。AgentRegistry 与具体 Agent 属于第二类：它们管理当前进程中的活跃执行。模型历史等派生视图会在 L4–L5 详细解释。

因此“恢复一个 Session”不是让原来的内存 Agent 对象复活，而是读取事实，再创建一个新的活跃 Agent 接续工作。这一差别正是本课三个核心角色不能合并的原因。

| 参照实现 | 会话与循环的主要承载者 | 历史与活跃执行的关系 | DSH 的变化 |
|---|---|---|---|
| [Pi `Agent`](../../pi/packages/agent/src/agent.ts) | Agent 持有 Context 并调用 Loop | 核心对象偏向当前运行；产品层再补 Session | DSH Session 先成为独立事实对象 |
| [Claude `QueryEngine`](../../claude-code/src/QueryEngine.ts) | 一个会话级 Engine 持有消息和产品状态，调用 `query()` | Engine 同时协调持久化、输入和多轮运行 | DSH 把服务门面、具体算法与事实存储拆开 |
| DSH | Session、AgentRegistry、AgentLoop | Session 可耐久；Registry 只管理活跃 Agent；Loop 是可替换 Factory/Driver | 销毁 Handle 不删除历史，Resume 创建新活跃对象 |

DSH 具体多做的是把“事实身份”和“进程内执行身份”设成不同生命周期，再用 AgentRegistry 作为发布边界。这样可以替换 Driver、恢复 Session 和创建 Agent Scope，而不让某个巨型会话对象同时承担存储、算法和资源清理；代价是调用链中出现更多 Handle、Factory 和发布事务。

## 一、Session 保存事实

[Session](../packages/core/session/src/index.ts#L425) 拥有追加式事件日志。它负责：

- Session 身份和 Header；
- 事件序号连续性；
- JSON 可持久化验证；
- Turn、Step、Message、Tool Result 等事实；
- 从事件 Surface 派生模型消息历史。

Session 不负责决定何时调用模型，也不负责选择哪个工具并发执行。它是运行事实的所有者。

## 二、AgentRegistry 管理活跃 Agent

[AgentRegistry](../packages/core/agent/src/index.ts#L256) 负责：

- 注册具体 Agent Factory；
- 创建和恢复 Agent；
- 按 SessionId 查找活跃实例；
- 发布 Agent 创建和销毁事件；
- 在异步调用链中携带 initiating Agent；
- 把 Agent 生命周期绑定到拥有它的 Context。

Registry 定义的是产品层 Agent 服务，但不把默认驱动实现写死在里面。具体 Factory 由 AgentLoop 注册。

## 三、AgentLoop 提供具体驱动实现

[AgentLoop](../packages/core/agent-loop/src/index.ts#L296) 实现 Agent Factory，创建的具体对象是 `ReactLoopAgent`。

`ReactLoopAgent` 拥有：

- Inbox；
- 当前 Phase；
- Turn 和 Step 计数；
- AbortController；
- 驱动占用状态；
- 如何组装请求、消费流和执行工具的时序。

“React”在这里指 ReAct 式推理与行动循环，不是浏览器 React。

拆分后的依赖方向是：

```text
上层入口、UI、ACP
       ↓ 只依赖 Agent 接口
AgentRegistry
       ↓ 委托 Factory
AgentLoop / ReactLoopAgent
       ↓ 使用
Session、LLM、Tools、SystemPrompt
```

因此 UI 不需要导入 `ReactLoopAgent`，自定义 Driver 也不需要改 AgentRegistry 的公共接口。

## 四、Agent 创建是一笔发布事务

创建入口在 [AgentRegistry.create()](../packages/core/agent/src/index.ts#L405)。调用方可以提供 `setup(agentCtx)`，在 Agent 对外可见前安装：

- Agent 专属工具；
- Prompt Section；
- Tool Restriction；
- 模型选择；
- 子插件；
- 事件监听器。

发布顺序的核心思想是：

```text
创建未发布 Session
→ 创建未发布 Agent Context
→ 完成并等待 setup
→ 在发布点重新验证可变前提
→ 同时把 Session 和 Agent 发布给观察者
→ 调用方才拿到 Handle
```

如果 setup 失败，Agent Scope 会被回滚，外部观察者看不到半配置 Agent。

这比“先放进 Map，再异步安装工具”更重要，因为 `session/created` 或 UI 观察者一旦看到 Agent，就可能立刻发送第一条消息。

## 五、Handle 表达的是拥有和释放能力

创建返回的不是一个永远存在的裸 Agent，而是带有生命周期能力的 Handle。释放 Handle 意味着：

- 停止 Agent 的活动；
- 等待拥有的异步工作收敛；
- 卸载 Agent Scope 中的注册；
- 从活跃 Registry 移除；
- 关闭与 Session 活跃实例的关系。

Session 的持久日志可以继续存在，但活跃 Agent 已经消失。这说明：

```text
Session identity 是持久概念
Live Agent identity 是进程内生命周期概念
```

## 六、Initiator 不是权限凭证

AgentRegistry 使用异步上下文携带“谁发起了这条同进程调用链”。工具调度可以据此知道调用属于哪个 Agent。

但 Initiator 只表达因果归属，不自动证明：

- Agent 仍活跃；
- 调用已获授权；
- 远程请求身份可信；
- 持久化记录属于该 Agent。

跨 Worker、进程、Wire 和存储边界时，身份仍必须显式验证。

## 本课核心结论

```text
Session 保存可重放事实。
AgentRegistry 管理活跃实例和 Factory。
AgentLoop 实现具体 Turn/Step 驱动。
Agent 创建在完成 Scope 配置后才原子发布。
Handle 表达活跃资源的释放能力。
Initiator 只表示同进程因果关系，不是授权证明。
```

## 对照练习

`L2-C1`：把 DSH 的 Session、AgentRegistry、ReactLoopAgent 分别映射到 Pi `Agent` 和 Claude `QueryEngine/query`。哪些职责可以一一对应，哪些是 DSH 新引入且无法塞回单个会话对象的？

## 课后问题

1. `L2-Q1`：为什么 Session 不应该直接拥有“调用模型直到完成”的循环？这种拆分给自定义 Driver 和持久化分别带来什么好处？
2. `L2-Q2`：如果 Agent 先加入 Registry，随后才异步安装工具和 Prompt，会产生哪些可观察的半配置状态？
3. `L2-Q3`：为什么销毁 Live Agent 不等于删除 Session？这两个对象分别属于什么生命周期？
4. `L2-Q4`：父 Agent 创建子 Agent 时，Initiator 和 `agentCtx.agent` 可能分别指向谁？为什么 Initiator 不能直接作为权限凭证？

回答格式：

```text
L2-Q1: ...
L2-Q2: ...
L2-Q3: ...
L2-Q4: ...
```
