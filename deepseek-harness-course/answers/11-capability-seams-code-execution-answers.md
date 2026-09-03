# 第 11 课参考答案：完整能力接缝与代码执行

[返回第 11 课](../11-capability-seams-code-execution.md)

## L11-C1

以 Bash 为例，模型 Tool 仍应保留名称、描述、输入 Schema、模型结果表达和何时建议使用的 Prompt；Shell Service Definition 声明命令请求、解析后的 Spec、输出、失败与取消义务；Local/Sandbox Provider 拥有 Shell 选择、环境、进程资源和 I/O；Subprocess/Sandbox 下层再拥有进程树与安全限制。原本位于 Tool 对象中的 `spawn`、超时默认值和清理必须迁到 Provider，中央 Pipeline 的权限、日志和 Hook 仍由统一 Tool Runtime 持有。这样非模型 Consumer 也能使用 Shell，而 Tool 不绕过策略。

## L11-Q1

> 为什么只有 `CodeRuntime` 接口或只有 `WorkerThreadCodeRuntime` 实现都不能构成完整能力？

### 参考答案

只有 `CodeRuntime` Definition 只声明请求、结果、失败和取消义务，没有可运行实现；只有 Worker Provider 则迫使调用者直接依赖线程、消息通道和资源细节。完整能力还需要 Consumer，例如 Code Mode 的 `run_code`，把稳定能力暴露给模型。Definition 让 Consumer 可复用，Provider 拥有线程和副作用，Consumer 只负责产品入口，三者齐备后才能替换实现而不改变模型协议。

## L11-Q2

> Code Mode 中程序调用原生 Tool 时，为什么仍必须经过 Tool Runtime，而不能直接调用 Tool 的函数？

### 参考答案

Tool Runtime 才拥有当前 Agent Scope、Schema、身份、权限策略、`tools/pre-execute`/`post-execute`、取消、日志和结果规范化。程序直接调用函数会绕过这些机制，使嵌套调用不受审批和限制，也不会产生正确的 `tool/call`、`tool/result` 事实。Code Mode 只改变模型访问工具的表达方式；Binding 必须把子调用送回统一 Tool Runtime，才能保持与原生模型 Tool Call 相同的安全和恢复语义。

## L11-Q3

> TypeScript 已经定义了 Python Worker Message 类型，为什么 fd3 JSONL 接收端仍必须运行时验证？

### 参考答案

TypeScript 类型只约束本进程编译过的代码，不能约束 Python 进程实际写入 fd3 的字节。对端可能发送非法 JSON、缺字段、未知 Tag、重复 CallId、超预算内容或顺序错误的终态，版本也可能不一致。因此接收端必须解析并验证每条 Wire Message，在进入内部状态机前拒绝无效数据。同进程可信类型调用无需重复验证，但文件、Worker、进程和网络边界必须验证。

## L11-Q4

> `resolve(request) → spec → run(spec)` 相比在 `run()` 内部到处补默认值，有哪些架构优势？

### 参考答案

`resolve()` 在一个明确位置补全默认 Shell、工作目录、环境、超时和输出策略，并完成相互依赖字段的验证，生成不可变、可执行的 Spec。`run()` 因而只执行完整事实，不会在不同分支采用不同默认值。Spec 可以被记录、测试、比较和交给不同 Provider，配置错误也在副作用开始前失败；默认策略属于 Provider 的解析职责，而不是散落在执行路径中的隐式 `?? default`。

## L11-Q5

> 请为一个新的“数据库查询能力”画出 Definition、Provider、Consumer，并说明连接池、凭据、查询结果日志和取消分别由谁拥有。

### 参考答案

```text
模型 / UI
   ↓
Database Query Consumer
  Schema、参数展示、结果呈现
   ↓
ctx.database：Service Definition
  resolve(request) → QuerySpec
  execute(spec, signal) → QueryResult
   ↓
Postgres / SQLite / Remote Provider
  连接池、事务、协议 I/O、超时、错误分类
```

连接池由具体 Provider 创建、复用并在卸载时关闭。配置只保存 CredentialRef，明文由 CredentialProvider 在建立连接的操作边界解析。Consumer 通过 Tool Runtime 调用 Definition；`tool/call` 与经过大小限制、脱敏策略处理的 `tool/result` 进入 Session，秘密和原始连接对象不进入日志。取消由 Definition 声明 AbortSignal，Provider 把它传给驱动、停止新查询、取消或中断当前请求并等待连接回到可复用或关闭状态。

## L11-Q6

> 请用不超过 300 字解释 DeepSeek Harness 为什么不是一个巨型 Agent Loop，而是一棵围绕事件日志组合的插件树。

### 参考答案

DeepSeek Harness 由 Profile、Bundle 和 Patch 选择插件，Cordis Context 按服务依赖激活它们，并用 effect/disposer 管理注册生命周期。AgentLoop 只负责 Turn、Step、模型流和工具调度；Session 保存可重放事实，Prompt、LLM、Tools、Persistence、Projection、Subagent 等由独立插件通过服务和事件协作。所有模型可见输入都写入日志，Host、Web、SDK 和恢复流程再从同一事件流投影状态。因此能力可以替换或按 Agent Scope 组合，而不必修改一个中央循环。
