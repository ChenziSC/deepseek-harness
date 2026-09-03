# 第 1 课参考答案：Cordis 生命周期与“一切皆插件”

[返回第 1 课](../01-cordis-lifecycle.md)

## L1-C1

Pi Callback 通常由创建 Loop 的调用者持有，Loop 结束后整体生命周期自然结束；依赖是否存在主要由调用者保证。Claude Code PreToolUse Hook 由产品 Hook/Query/Tool Pipeline 注册和调度，卸载及设置变化服从对应 Manager。DSH Listener 由插件 Context 的 Effect 持有，依赖 Service 不可用时 Consumer 不能激活，插件或 Agent Scope 卸载时 disposer 撤销 Listener。三者都能拦截工具，但只有 DSH 把依赖可用性、作用域和撤销统一为通用运行时关系。

## L1-Q1

> 为什么工具插件应该依赖 `ctx.fs`，而不是直接导入 `LocalFileSystem`？Provider 替换时两种设计分别会发生什么？

### 参考答案

`ctx.fs` 是稳定的文件系统能力接口，工具只依赖读写语义，不依赖文件位于本机、E2B 还是受 Sandbox 约束的环境。替换 Provider 时，依赖 `ctx.fs` 的 Consumer 无需修改；直接导入 `LocalFileSystem` 会把部署位置、路径策略和安全策略固定到工具中，远程或受限 Provider 无法接管，并可能绕过统一的权限与事件拦截。

## L1-Q2

> 一个插件向普通全局数组加入工具，但卸载时没有移除。为什么这不仅是内存泄漏，还会破坏 HMR 和权限语义？

### 参考答案

未移除的工具仍会被发现和调用，因此它是活跃行为残留，不只是占用内存。HMR 后旧版和新版注册可能同时存在，造成重复 Schema、错误实现被选中或同一调用执行多次；Agent Scope 卸载后旧工具仍全局可见，还会让原本撤销的权限继续生效。把注册放进 effect 并保存 disposer，才能使代码版本、作用域和可见能力同步变化。

## L1-Q3

> 什么场景适合 Service 方法，什么场景适合 Waterfall Event？请分别举一个 Harness 中的例子。

### 参考答案

Service 方法适合调用者明确请求一个能力并期待结果，例如 `ctx.fs.read()`、`ctx.sessions.create()` 或 `ctx.tools.execute()`。Waterfall Event 适合多个插件围绕一个生命周期点按顺序观察、改写或截断处理，例如 `agent/pre-step` 改写本次模型输入，或 `tools/pre-execute` 在工具执行前实施策略。Waterfall Listener 必须调用 `next()` 才会继续后续链路；不调用表示有意接管或终止。

## L1-Q4

> 为什么“`ctx.llm` 存在”不足以证明某个模型 Route 可用？一个更合理的不变量应该检查什么关系？

### 参考答案

`ctx.llm` 存在只证明注册表服务已经创建，不能证明目标 Route 的 Adapter 仍在当前 Scope 中、配置有效或与 Consumer 的选择一致。更合理的不变量应检查“请求引用的 Route 能解析到当前作用域中由预期插件拥有的 Adapter”，必要时还要验证模型配置、Credential Reference 和 Provider 注册属于同一有效关系。检查关系能发现空注册表、错误作用域和已卸载 Provider，单纯检查对象存在不能。
