# 第 11 课：完整能力接口与代码执行

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

最后一课不再学习新的产品页面，而是检验你能否用统一方法理解或设计任意 Harness 能力。

仓库把一个完整可替换能力拆成三个角色：

```text
Service Definition：调用者可以依赖什么
Service Provider：怎样实现这个能力
Consumer：怎样把能力交给模型、UI 或其他子系统
```

## 本课在课程中的位置

- **所属分支：**这是能力扩展分支和整套课程的总复盘，不要求先掌握 Web 前端细节。
- **前置课程：**L1 的插件注册、L2–L5 的生命周期与事实主干，以及 L9 或 L10 至少一个完整能力案例。
- **本课只新增一个判断：**完整 Capability Seam 必须同时回答 Definition、Provider、Consumer、资源所有者、失败语义和跨边界验证，不能只写一个接口或一个模型 Tool。
- **第一遍重点：**先读“三个角色”、CodeRuntime 这一组完整案例、五个分析问题和课程总复盘；Worker Thread、Python Wire、Shell/FS/Sandbox 的细节用于第二遍验证。
- **本课输出：**你不再依赖课程列出的包名，而是能用同一组问题分析仓库中新出现的任意能力。

## 从 Pi / Claude 到 DSH：Tool 不再等于能力实现

L1 首次介绍 Provider 和 Consumer，L9–L10 展示了委派与秘密管理。本课使用更严格的三角色结构统一它们：

```text
模型或产品入口
→ Consumer：把产品意图翻译成稳定请求
→ Service Definition：规定请求、结果、失败和取消义务
→ Provider：执行副作用并拥有 Worker、进程、连接或文件
```

Service Definition 不是一个孤立的 TypeScript Interface，而是调用者和实现者共同依赖的义务。Provider 不只是“返回结果的类”，还要负责资源释放、取消收敛和失败分类。Consumer 也不只是按钮或 Tool Schema，它负责把模型或 UI 的输入安全地带到能力接口，并把结果投影回产品。

当数据离开同进程静态类型范围，验证责任也随之出现。文件、Worker、子进程和网络收到的内容必须运行时验证；同进程且已经受 TypeScript 约束的普通调用不需要重复把所有值当成敌对输入。

| 参照实现 | Tool 与执行实现的关系 | 共享能力怎样复用 | DSH 的变化 |
|---|---|---|---|
| [Pi tool wrapper](../../pi/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts) | Tool Definition/Execute 与 Loop 回调形成清晰的小接口 | 宿主通过工具集合和包装器复用 | DSH 把 Tool 进一步限定为 Consumer，而非底层资源所有者 |
| [Claude `Tool`](../../claude-code/src/Tool.ts) / [toolExecution](../../claude-code/src/services/tools/toolExecution.ts) | Tool 对象、中央执行 Pipeline、Permission/Hook 共同完成调用 | 产品 Pipeline 统一策略，具体 Tool 拥有实现 | DSH 在 Tool 下方再建立 Shell、FS、Subprocess、CodeRuntime 等 Service Definition |
| DSH | Consumer → Definition → Provider，可多层组合 | CLI、模型 Tool、Workflow 或其他插件都能复用同一能力 | Provider 拥有资源、取消和失败；Consumer 只负责产品呈现 |

DSH 具体多做的是把“模型能调用的 Tool”和“系统具备的 Capability”分开。一个 Bash Tool 不直接拥有 `spawn()`，而是消费 Shell；Shell Provider 再消费 Subprocess/Sandbox。收益是本地、Worker、Python、E2B 等实现可替换，非模型 Consumer 也能复用；代价是包和配置数量增加，必须为每层明确 Request、Spec、Failure 与资源所有权。

## 一、为什么只有接口还不算完整能力

只写一个 TypeScript Interface，没有 Provider，就没有可运行实现。

只写 Provider，没有稳定 Definition，上层会直接依赖具体实现。

只写模型 Tool，没有独立 Provider，Tool 会同时承担 Schema、策略、进程和 I/O，无法替换或复用。

所以新增能力时必须回答：

```text
谁声明调用义务？
谁拥有资源和副作用？
谁把它暴露给模型或产品？
```

## 二、CodeRuntime 是 Service Definition

[CodeRuntime](../packages/code-runtime/code-runtime/src/index.ts#L102) 定义：

- Runtime Language；
- Code Request；
- 可注入 Binding；
- Result 与 Failure 分类；
- Cancellation；
- 输出和资源预算。

它不选择 Worker Thread、Python Process 或远程 Sandbox。Consumer 因此只需要表达“运行这段代码并提供这些 Binding”。

## 三、Worker Thread 是一个 Provider

[WorkerThreadCodeRuntime](../packages/code-runtime/code-runtime-worker-thread/src/index.ts#L238) 负责：

- 创建 Worker；
- 建立宿主与 Worker 的调用通道；
- 注入允许的 Binding；
- 控制输出预算；
- 响应 Abort；
- 等待 Worker 退出并分类失败；
- 释放线程和监听器。

这些资源所有权不应该泄漏进 `ToolRuntime`。如果未来切换 Provider，Code Mode 的 Tool Schema 不需要改变。

## 四、跨进程协议必须运行时验证

Python Provider 通过 fd3 JSONL 交换消息。即使 TypeScript 编译通过，另一进程仍可能发送：

- 缺字段；
- 非法 Tag；
- 超出预算的数据；
- 重复或未知 CallId；
- 顺序错误的终态。

因此 [protocol.ts](../packages/code-runtime/code-runtime-python/src/protocol.ts#L1) 必须验证 Wire Message。

这与同进程边界不同：同进程、静态类型已经约束的普通调用不需要重复敌对验证；文件、队列、Worker、进程和网络边界必须验证。

## 五、Code Mode 是 Consumer

[packages/core/tools/src/code-mode.ts](../packages/core/tools/src/code-mode.ts#L1) 把 CodeRuntime 转换成模型可调用的 `run_code`：

```text
收集当前 Scope 可见 Tool Schema
→ 生成供代码使用的 SDK
→ 模型调用 run_code(program)
→ CodeRuntime 执行程序
→ 程序通过 Binding 调用原生 Tool
→ 子调用继续经过 Tool Permission Pipeline
→ 返回结构化结果
```

Code Mode 改变的是模型“如何到达工具”，不是绕过 Tool Runtime。嵌套工具仍保留原来的身份、Policy、Cancellation 和日志语义。

## 六、显式 Resolve 分离 Request 与 Spec

Shell 能力展示了另一个重要模式：

```text
ShellExecRequest
→ ShellExecutor.resolve(request)
→ ShellExecSpec
→ run(spec)
```

[ShellExecutor](../packages/shell/shell/src/index.ts#L65) 让 Provider 在一个明确步骤中补全：

- 默认 Shell；
- Working Directory；
- Environment；
- Timeout；
- Output Policy。

`run()` 不再偷偷写 `request.timeout ?? default`。这样默认值、验证点和本次执行采用的完整事实可以被测试、记录和替换。

## 七、FS、Shell、Subprocess 与 Sandbox 是多层能力

Bash Tool 的调用链不是一个 Tool 直接 `spawn()`：

```text
tool-bash              模型 Consumer
→ ctx.shell            Shell Definition
→ bash-local/sandbox   Shell Provider
→ ctx.sandbox          解析 Process Confinement
→ ctx.subprocess       创建和管理进程树
→ OS Process
```

文件工具类似：

```text
tool-fs
→ ctx.fs
→ fs-local / fs-sandbox / fs-e2b
```

每一层拥有不同职责：命令语义、文件 I/O、进程生命周期和安全限制不能塞进同一 Tool。

## 八、配置何时失败取决于最早可解析点

合理失败策略不是“一律插件加载时报错”，也不是“一律运行时兜底”。

```text
静态自洽错误
→ 插件加载时失败

缺少只在某个模式需要的 Provider
→ 该模式首次组装或执行时失败

Wire 数据错误
→ 接收该消息时失败

请求参数错误
→ Request → Spec Resolve 时失败
```

例如 Tools 默认是 Native Mode 时，没有 CodeRuntime 可以正常启动；某个 Agent 真正选择 Code Mode 时才要求 Provider 存在，并给出明确配置错误。

## 九、Cancellation 是 Provider 义务，不是装饰字段

Service Definition 声明 AbortSignal 后，Provider 必须：

- 把 Signal 传到拥有的 I/O；
- 停止启动新工作；
- 等待已经开始的工作收敛；
- 释放 Worker、Process、Listener；
- 返回明确 Aborted Failure。

仅在入口检查一次 `signal.aborted` 不满足生命周期义务。取消表示停止意图，不表示资源已经自动消失。

## 十、用五个问题分析任意新能力

遇到 Web Search、LSP、Terminal、Workflow 或新的 Provider，可以固定回答：

1. Definition 声明哪些稳定请求、结果和失败？
2. Provider 拥有哪些资源、副作用和取消义务？
3. Consumer 怎样把能力暴露给模型或 UI？
4. 哪些数据跨越文件、Worker、进程或网络，需要运行时验证？
5. 哪些结果进入 Session，怎样支持回放、恢复和 Scope？

## 十一、课程总复盘

现在可以把整个 Harness 压缩成一条设计链：

```text
Profile 选择插件
→ Context 发布可替换服务
→ AgentRegistry 创建完整 Scope
→ AgentLoop 驱动 Turn / Step
→ Prompt、LLM、Tools 通过事件和服务协作
→ 模型可见事实进入 Session
→ Persistence 保存日志
→ Projection 为 Host、Client 和 SDK 构造读取状态
→ Capability Provider 可以替换，Consumer 不感知具体实现
```

## 本课核心结论

```text
完整能力必须同时设计 Definition、Provider 和 Consumer。
Definition 声明稳定义务，不选择具体实现。
Provider 拥有资源、副作用、取消和失败分类。
Consumer 负责模型或产品入口，不复制 Provider 实现。
跨文件、Worker、进程和 Wire 的数据必须运行时验证。
Request → Spec 的显式 Resolve 是默认值和验证的唯一入口。
Code Mode 改变工具呈现方式，但不绕过 Tool Runtime。
复杂能力可以由多层独立接口组合，而不是巨型 Tool。
```

## 对照练习

`L11-C1`：选择 Pi 或 Claude Code 中一个你熟悉的 Bash/Read Tool，把它映射成 DSH 的 Consumer、Service Definition、Provider 和底层资源。哪些原本位于 Tool 对象或中央 Pipeline 的职责必须迁出，哪些仍应留在模型 Tool？

## 课后问题

1. `L11-Q1`：为什么只有 `CodeRuntime` 接口或只有 `WorkerThreadCodeRuntime` 实现都不能构成完整能力？
2. `L11-Q2`：Code Mode 中程序调用原生 Tool 时，为什么仍必须经过 Tool Runtime，而不能直接调用 Tool 的函数？
3. `L11-Q3`：TypeScript 已经定义了 Python Worker Message 类型，为什么 fd3 JSONL 接收端仍必须运行时验证？
4. `L11-Q4`：`resolve(request) → spec → run(spec)` 相比在 `run()` 内部到处补默认值，有哪些架构优势？
5. `L11-Q5`：请为一个新的“数据库查询能力”画出 Definition、Provider、Consumer，并说明连接池、凭据、查询结果日志和取消分别由谁拥有。
6. `L11-Q6`：请用不超过 300 字解释 DeepSeek Harness 为什么不是一个巨型 Agent Loop，而是一棵围绕事件日志组合的插件树。

回答格式：

```text
L11-Q1: ...
L11-Q2: ...
L11-Q3: ...
L11-Q4: ...
L11-Q5: ...
L11-Q6: ...
```
