# 第 1 课：Cordis 生命周期与“一切皆插件”

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课的核心不是学习某个框架 API，而是理解 Harness 如何回答三个工程问题：

```text
一个能力由谁提供？
依赖未就绪时为什么不会提前运行？
插件卸载时，谁负责撤销它留下的注册和资源？
```

## 本课在课程中的位置

- **前置课程：**L0 已经解释配置怎样生成插件树；本课从“树已经存在”开始。
- **本课只新增一个判断：**插件通过 Context 中的 Service 和 Event 协作，所有注册都必须归属于某个可卸载的生命周期。
- **第一遍重点：**先读 Context、注册所有权、Service 与 Event；`Scope` 和运行时 Invariant 是第二遍内容。
- **容易混淆：**本课的 Cordis `inject` 表示服务依赖和激活条件，不是 L3 中 Agent 的 `inject()` 输入方法。
- **本课输出：**你将知道插件怎样提供能力，但还不知道 Session、活跃 Agent 和驱动算法为什么要分开。L2 专门解决这个问题。

## 从 Pi / Claude 到 DSH：扩展点变成生命周期关系

L0 得到了一棵插件树，但“树中有插件”还不等于“调用者应该直接依赖某个插件实现”。Harness 把一项能力拆成稳定接口、Provider 和 Consumer：

```text
Consumer → 稳定服务接口 ← Provider
   使用能力                 实现能力并拥有资源
```

例如文件读取工具是 Consumer，本地文件系统或 E2B 文件系统是 Provider，`ctx.fs` 是双方约定的服务接口。Consumer 只表达“读取这个路径”，Provider 决定数据来自本机还是远程 Sandbox。

插件则是把这些角色装进运行时的生命周期单位。插件激活时可以提供 Service、注册工具或监听 Event；插件卸载时必须撤销这些贡献。于是“能调用什么”和“谁负责清理”会在同一个 Context 关系里得到答案。

接下来出现的两个协作方式先这样理解：明确请求一个返回值时调用 Service 方法；允许多个插件观察或改写运行阶段时发送 Event。第四节会结合 Harness 事件继续展开。

| 参照实现 | 主要扩展方式 | 生命周期通常由谁掌握 | DSH 对应变化 |
|---|---|---|---|
| [Pi agent core](../../pi/packages/agent/src/agent-loop.ts) | `transformContext`、`beforeToolCall`、`afterToolCall` 等回调 | 创建循环的调用者 | 回调贡献改为插件注册的 Service/Event Listener |
| [Claude Code](../../claude-code/src/services/tools/toolExecution.ts) | Hook、Tool Pipeline、Manager、Command Registry | QueryEngine、应用 Store 或具体 Manager | 跨功能协作从产品对象转为 Context 中的显式依赖 |
| DSH | `inject`、Service、Event、`ctx.effect()`、Scope | 注册它的插件 Context | Provider 卸载会使依赖 Consumer 失活并执行 disposer |

DSH 不是简单增加更多 Hook。它要求每个贡献都有所有者，并让依赖可用性决定插件是否激活。这样 HMR、Agent Scope 和 Provider 替换共享同一套生命周期语义；代价是开发者必须理解 Event 模式、Scope 和 disposer，不能把注册留在全局数组里。

## 一、Context 是服务目录

Cordis 的 Context 可以理解为一个具有层级和生命周期的服务目录。插件不应该导入某个具体 Provider 的单例，而是通过稳定键读取能力：

```text
ctx.sessions
ctx.agents
ctx.llm
ctx.tools
ctx.fs
```

例如工具插件依赖的是 `ctx.fs` 代表的文件系统能力，而不是直接绑定 `LocalFileSystem`。这样把本地 Provider 换成 E2B 或 Sandbox Provider 时，工具 Consumer 不必出现 Provider 分支。

基础概念可先看 [docs/cordis-primer.md](../docs/cordis-primer.md)。

## 二、`inject` 表达激活条件

插件通过 `inject` 声明必须存在的服务。Cordis Loader 根据服务是否可用决定何时激活，而不是要求开发者手写初始化顺序。

```text
Provider 尚未出现
→ Consumer 等待

Provider 激活并提供服务
→ Consumer 获得激活条件

Provider 卸载
→ 依赖它的插件随生命周期失活
```

这让依赖关系成为运行时结构，而不是散落在启动函数中的隐式约定。

## 三、注册本身必须有所有者

工具、Prompt Section、LLM Adapter、事件监听器都不是写入全局数组后永久存在。注册操作返回 disposer，并由调用插件的 effect 拥有。

系统提示词注册表是一个很适合观察的例子：[packages/core/system-prompt/src/index.ts](../packages/core/system-prompt/src/index.ts#L346)。插件可以注册一个 Section；Section 对当前范围可见；插件卸载时 disposer 将它移除。

完整生命周期是：

```text
插件激活
→ effect 注册贡献
→ 贡献对其他插件可见
→ 插件卸载
→ disposer 逆序执行
→ 贡献不再可见
```

如果直接修改模块级数组，就会绕过这个所有权模型。HMR 后旧工具、旧监听器和新版本可能同时存在。

## 四、Service 方法和 Event 的职责不同

Service 方法适合“我明确要调用某个能力”：

```text
ctx.fs.read(...)
ctx.sessions.create(...)
ctx.tools.execute(...)
```

Event 适合“其他插件需要观察或拦截某个生命周期点”：

```text
session/event
agent/pre-step
agent/request
tools/pre-execute
tools/post-execute
```

Harness 使用四种事件分发方式：

| 模式 | 适用含义 |
|---|---|
| emit | 同步观察，不返回决策 |
| parallel | 异步并行观察 |
| serial | 按顺序完成多个观察者 |
| waterfall | 围绕式拦截或改写结果 |

Waterfall Listener 必须调用 `next()` 才会把控制交给下一个 Listener；直接返回意味着有意截断后续处理。这一点在 Prompt、Agent Request 和 Tool Pipeline 中都会反复出现。

## 五、Scope 让同一进程中的 Agent 拥有不同能力

Context 不只是全局容器。Agent 可以拥有自己的派生 Context。注册在 Agent Scope 中的工具、Prompt Section、限制规则只影响该 Agent。

因此同一进程可以同时存在：

```text
Agent A：Native Tools + 完整文件写权限
Agent B：Code Mode + 只读工具集合
Agent C：子 Agent 专属 report 工具
```

这不是在每个调用处手写 `if agentId`，而是让注册进入不同的 Context Scope。

## 六、Invariant 检查的是关系，不只是对象存在

运行时不变量不能只检查：

```text
ctx.tools 存在
ctx.llm 存在
```

这些只能证明服务对象存在，不能证明插件拥有的关系仍成立。更有价值的不变量会检查：

- Adapter 是否仍注册在预期 Route；
- Agent 与 Session 是否共享正确身份；
- Tool Registration 是否属于当前 Scope；
- 日志事件能否构成合法 Turn/Step；
- 模型请求是否能从 Session 重建。

这也是为什么仓库把 Registration 视为 effect：所有权关系必须能够验证和撤销。

## 本课核心结论

```text
Context 通过稳定服务键解耦 Consumer 与 Provider。
inject 把依赖变成插件激活条件。
effect/disposer 让每个注册拥有明确生命周期。
Service 方法负责直接能力调用，Event 负责观察和拦截。
Agent Scope 允许同一进程中的能力集合不同。
不变量应检查插件拥有的关系，而不是只检查对象是否存在。
```

## 对照练习

`L1-C1`：Pi 的 `beforeToolCall`、Claude Code 的 PreToolUse Hook 和 DSH 的 `tools/pre-execute` 都能影响工具执行。请比较三者的注册所有者、卸载方式和依赖缺失时的行为；为什么“都叫 Hook”不足以说明它们是同一种架构？

## 课后问题

1. `L1-Q1`：为什么工具插件应该依赖 `ctx.fs`，而不是直接导入 `LocalFileSystem`？Provider 替换时两种设计分别会发生什么？
2. `L1-Q2`：一个插件向普通全局数组加入工具，但卸载时没有移除。为什么这不仅是内存泄漏，还会破坏 HMR 和权限语义？
3. `L1-Q3`：什么场景适合 Service 方法，什么场景适合 Waterfall Event？请分别举一个 Harness 中的例子。
4. `L1-Q4`：为什么“`ctx.llm` 存在”不足以证明某个模型 Route 可用？一个更合理的不变量应该检查什么关系？

回答格式：

```text
L1-Q1: ...
L1-Q2: ...
L1-Q3: ...
L1-Q4: ...
```
