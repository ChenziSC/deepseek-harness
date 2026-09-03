# 第 6 课参考答案：Web Host 如何投影同一个 Agent 运行时

[返回第 6 课](../06-web-host-runtime.md)

## L6-C1

Pi RPC Mode 主要复用 AgentSession/Loop，并由模式适配协议；Claude SDK/Remote 复用 QueryEngine 与产品消息转换；DSH Web Host 复用整棵 Cordis Service Graph，包括 Session、Agent、Projection 和当前插件注册。浏览器能力集合也必须投影，因为 DSH 允许 Profile 和 Patch 改变后端实际装载的工具、领域插件与 UI 支持。只远程暴露 Loop 而静态构建前端，会让页面假设的功能与当前 Host 插件树不一致。

## L6-Q1

> 为什么 `dsh web` 不需要重新实现 Agent Loop？Web Bundle 相比 Base 主要增加了哪些职责？

### 参考答案

Base 已提供 Session、AgentRegistry、AgentLoop、LLM、Tools 和 Persistence，Web 只是另一种入口和读取投影。Web Bundle 主要增加 WebServer、API/Typert Gateway、Session Query 与 Projection Cache、静态前端、Client Module Registry、浏览器 Runtime 及各 UI 插件。浏览器通过 Host 调用 `ctx.agents` 和 `ctx.sessions`，因此核心行为修复只需落在拥有该行为的插件，不必在 Web 重写循环。

## L6-Q2

> 为什么 Web 参数解析放在 `web-startup` 插件，而不是全部塞进顶层 `bin.ts`？

### 参考答案

`--host`、`--port`、`--trusted-host`、`--no-open` 属于 Web 产品的启动语义，应由 Web 组合拥有。顶层 `bin.ts` 只提供原始参数并选择 Profile；`web-startup` 解析并发布不可变的 `ctx.webStartup`，WebServer 和自动打开插件再依赖它。这样入口无需导入每种产品的参数知识，Web 配置也可以随插件组合测试、替换或卸载。

## L6-Q3

> Web App 如果在自己激活后立即打印 URL，而不等 Loader 树稳定，可能产生什么竞态？

### 参考答案

浏览器可能在 API 路由、事件流、Client Module Manifest 或静态资源插件完成挂载前访问地址。此时 `index.html` 可能返回成功，但 `/api`、模块 Bundle 或启动数据仍不存在，用户看到的是“已就绪”后的随机失败。等待整棵 Loader 树稳定后再输出 URL，把 Ready Signal 定义为所有可激活兄弟插件已经完成，而不是单个 Web App 插件完成自己的局部激活。

## L6-Q4

> 浏览器为什么不能直接复用后端 TypeScript 类型并调用 Session 对象？跨进程后还必须增加哪些验证？

### 参考答案

TypeScript 类型在运行时被擦除，也不能跨 HTTP 或 WebSocket 传递对象身份、方法和资源所有权。浏览器数据属于不可信 Wire 输入，Host 必须验证 JSON 字段与判别标签、解析 Session/Agent 标识、检查权限和当前生命周期，并把错误转换为稳定的远程协议结果。版本、序列化限制和事件流顺序也需要显式处理；后端同进程类型不能替代这些边界验证。

## L6-Q5

> 为什么禁止 `0.0.0.0` 和 Trusted Host 检查必须位于 Host，而不能只靠 UI 限制？

### 参考答案

UI 只能约束正常页面交互，攻击者可以绕过 React，直接构造 HTTP 请求或伪造 Host Header。Web Host 最终可触发文件、Shell 和 Agent 能力，因此监听地址与可信 Host 是网络请求被接受前的安全条件，必须由服务端强制执行。只隐藏按钮不会阻止外部机器访问 `0.0.0.0`，也不能阻止 DNS Rebinding 或伪造 Host 请求进入本地 API。
