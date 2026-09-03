# 第 2 课参考答案：Session、AgentRegistry 与 AgentLoop

[返回第 2 课](../02-session-agent-loop.md)

## L2-C1

Pi `Agent` 最接近 DSH 的活跃 Agent 接口与 ReactLoopAgent 组合：它持有当前 Context 并驱动 Loop，但核心层没有等价的独立耐久 Session Service 和活跃实例 Registry。Claude `QueryEngine` 同时覆盖会话级消息、输入提交和对 `query()` 的协调；`query()` 更接近 DSH AgentLoop 的驱动算法。DSH 新增的关键职责是 Session 作为独立事实身份、AgentRegistry 作为 Factory/活跃实例/原子发布门面，以及 Handle 作为释放能力。这些职责若塞回单个会话对象，会重新绑定持久化、算法和进程资源生命周期。

## L2-Q1

> 为什么 Session 不应该直接拥有“调用模型直到完成”的循环？这种拆分给自定义 Driver 和持久化分别带来什么好处？

### 参考答案

Session 的职责是接受、验证并保存有序事实；何时调用模型、如何领取 Inbox、如何调度工具属于驱动策略。拆开后，AgentRegistry 可以挂载不同 Driver，而 UI、ACP 和 SDK 仍依赖同一 Agent 接口；持久化也只需保存 Session Event，不必理解某个 Loop 的内存状态。这样日志能够独立重放和修复，替换 Driver 时也不会改变 Session 格式的基本职责。

## L2-Q2

> 如果 Agent 先加入 Registry，随后才异步安装工具和 Prompt，会产生哪些可观察的半配置状态？

### 参考答案

Registry、UI 或 `session/created` 观察者可能在 setup 完成前发现 Agent 并立即发送输入。第一步请求可能缺少 Agent 专属工具、Prompt Section、模型选择或限制策略；稍后的请求又看到另一套能力，导致同一 Session 前后配置不一致。若 setup 最终失败，还会留下曾经可见但无法正确使用的 Agent。先在未发布 Scope 中完成 setup，再原子发布 Session 与 Agent，可以消除这些中间状态。

## L2-Q3

> 为什么销毁 Live Agent 不等于删除 Session？这两个对象分别属于什么生命周期？

### 参考答案

Live Agent 是进程内活动资源，拥有 Inbox、AbortController、Driver、事件监听器和 Agent Scope；释放 Handle 会停止活动、撤销注册并从 Registry 移除。Session 是持久身份和追加式事实日志，即使没有活跃 Agent，仍可用于审计、投影、Fork 或之后 Resume。销毁 Agent 结束的是当前执行生命周期，删除 Session 才会处理耐久数据，两者不能绑定为同一操作。

## L2-Q4

> 父 Agent 创建子 Agent 时，Initiator 和 `agentCtx.agent` 可能分别指向谁？为什么 Initiator 不能直接作为权限凭证？

### 参考答案

创建链路中的 Initiator 可以表示发起调用的父 Agent，而子 Agent 的 `agentCtx.agent` 表示当前新建的 Child。Initiator 只记录同进程异步调用的因果来源，不能证明父 Agent 仍活跃、请求已经授权或跨进程传来的身份可信。权限必须依据当前 Agent Scope、显式策略和边界处验证决定；跨 Worker、网络、存储或 Wire 后尤其不能把 Initiator 当作认证结果。
