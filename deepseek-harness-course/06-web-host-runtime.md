# 第 6 课：Web Host 如何投影同一个 Agent 运行时

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课回答：

> `dsh web` 是另一套 Agent，还是同一运行时的另一种入口和投影？

答案是后者。Web Bundle 复用 Base 中的 Session、Agent、LLM 和 Tools，只增加 Host、API、静态前端与浏览器模块。

## 本课在课程中的位置

- **所属分支：**这是产品表面分支的第一课；只研究后端 Agent 时可以先跳过。
- **前置课程：**L0 的 Bundle 装配、L2 的核心服务和 L5 的 Projection。
- **本课只新增一个判断：**Web 不是第二套 Agent，而是为同一插件运行时增加 Host、API 和浏览器投影。
- **第一遍重点：**阅读 Web Bundle、Host 插件协作、受限 Host 接口以及 Headless/Web 对比；启动参数、Ready Signal 和网络信任可第二遍阅读。
- **本课输出：**Host 已经能告诉浏览器当前部署提供哪些能力。L7 研究浏览器为什么也需要动态模块系统。

## 从 Pi / Claude 到 DSH：产品入口变成同一内核的投影

L0–L5 的 Session、Agent 和 Persistence 可以在一个 Node.js 进程中独立运行。浏览器不能直接拿到这些内存对象：它运行在另一个执行环境，只能通过 HTTP、RPC 和事件流交换可序列化数据。

**Host**是连接两边的后端边界。它把浏览器请求解析成对核心服务的调用，再把 Session Event 或 Projection 变成浏览器可接收的数据。**Client**是浏览器中的消费者，它不拥有后端 Agent 的生命周期。

```text
Browser Client
→ Wire Request（外部输入，必须验证）
→ Web Host
→ ctx.agents / ctx.sessions（同一核心运行时）
→ Event / Projection
→ Wire Response 或 Event Stream
```

这里的 Projection 仍沿用 L5 的含义：从同一事实流计算某个读取者需要的状态。Web 只是新增一个读取和操作入口，不会因此产生第二套 Session 或 AgentLoop。

| 参照实现 | 多入口怎样复用核心 | 远程边界 | DSH 的变化 |
|---|---|---|---|
| [Pi coding-agent modes](../../pi/packages/coding-agent/src/modes/index.ts) | Interactive、Print、RPC 等模式围绕 AgentSession 组合 | 产品模式拥有自己的适配逻辑 | DSH 用 Profile/Bundle 选择 Host 或 Headless Consumer |
| [Claude Code](../../claude-code/src/QueryEngine.ts) | REPL、Print、SDK、Remote 能复用 QueryEngine 与 query | SDK/Remote 层把产品消息转成协议输出 | DSH Host 通过 Typert RPC 和 Event Stream 只暴露受限服务面 |
| DSH | Web 与 Headless 复用 Session、Agent、LLM、Tools、Persistence | Host 解析身份、验证 Wire、执行 Trusted Host Fence | 浏览器是同一事件运行时的远程消费者 |

DSH 具体多做的是让“入口差异”也由插件组合表达。Headless Runner、Web Host 和 ACP 不需要成为不同 Agent 类型；它们是同一核心服务的 Consumer。代价是远程方法、事件流、身份解析和 Wire Validation 都要形成明确协议，不能直接把后端对象传给 UI。

## 一、Web Bundle 是 Base 的上层 Patch

[packages/bundle/web-app/cordis.patch.yml](../packages/bundle/web-app/cordis.patch.yml#L1) 会在 Base 之上加入：

```text
WebServer
API Proxy / Typert Gateway
Session Query 与 Projection Cache
Frontend Static
Client Module Registry
Browser Client Runtime
Conversation、Settings、Tool、Plan 等 UI 插件
```

它没有重新实现 Agent Loop。浏览器创建或恢复 Session 时，Host 仍通过 `ctx.agents` 和 `ctx.sessions` 操作同一核心服务。

## 二、命令参数本身也由插件提供

Web 参数解析在 [packages/bundle/web-app/src/startup.ts](../packages/bundle/web-app/src/startup.ts#L68)。这个插件读取启动器提供的 `ctx.cmdlineArgs`，再提供不可变的 `ctx.webStartup`：

```text
--host
--port
--trusted-host
--no-open
```

Web Server、浏览器自动打开等其他配置行再从这个服务读取值。

这保持了上一课的原则：顶层 CLI 不必知道 Web 的全部参数，具体应用插件拥有自己的命令语义。

## 三、Web Host 是多个插件协作，不是巨型应用类

[web-app apply()](../packages/bundle/web-app/src/index.ts#L235) 主要完成组合性工作：

- 解析可访问地址与信任 Host；
- 提供 Web Runtime Facts；
- 挂载静态前端插件；
- 注册 Web Surface Prompt；
- 给 Shell 环境暴露当前 Web URL；
- 在整个 Loader 树稳定后输出 URL 或打开浏览器。

HTTP 路由由 [WebServer](../packages/host/webserver/src/index.ts#L73) 注册；RPC 和事件流由 API 插件提供；静态文件由 [frontend-static](../packages/host/frontend-static/src/index.ts#L104) 提供。

## 四、Ready Signal 必须晚于整棵树稳定

如果 Web App 自己激活后立刻输出 URL，其他同级插件可能仍在挂载 `/api` 路由或 Module Manifest。

于是可能发生：

```text
终端打印“已就绪”
→ 浏览器立刻访问
→ index.html 能返回
→ /api 或客户端模块还不存在
```

所以 Web App 等待 Loader `await()` 完成后才打印 URL、打开浏览器。这和 Headless 在创建 Agent 前等待树稳定是同一个生命周期原则。

## 五、浏览器获得的是受限 Host 接口

浏览器不会直接导入后端 Session、Agent 或 FileSystem 对象。它通过：

```text
HTTP / API Proxy
→ Typert Remote 方法
→ Host 解析 Session/Agent 身份
→ 调用后端服务
→ RPC Response 或 Event Stream
```

远程接口位于 `packages/api/remotes`，Host API 入口集中在 `packages/host/apiproxy`。

这样做不仅是打包需要，也建立了进程边界：浏览器输入必须经过 Wire Validation、权限和 Host 身份解析，不能依赖 TypeScript 的同进程静态类型。

## 六、静态前端只是 Shell

`apps/web` 构建浏览器 Shell，但它不是可以单独启动的完整应用。真正的 Web 运行时需要 Host 在 Index 中注入：

- API 地址；
- Client Module Manifest；
- 启动数据；
- 当前部署的插件集合。

所以另起一个 Vite Server 不会自动连接当前 Harness Runtime。前端产物和 Host 组合共同构成产品。

## 七、网络信任属于 Host，不属于 React

Web 启动层有意拒绝 `--host 0.0.0.0`，因为该界面最终可以触发文件、Shell 和 Agent 能力。Host 还维护 Trusted Host Fence，防止浏览器请求通过伪造 Host Header 进入本地 API。

这类安全规则必须在 HTTP Host 边界执行，而不是依赖 UI 隐藏按钮。一个恶意请求可以绕过 React 直接访问 API。

## 八、Headless 与 Web 的真正差异

```text
共同部分：
Session + Agent + AgentLoop + LLM + Tools + Persistence

Headless：
一次性创建 Agent → followup → whenIdle → flush → stdout

Web：
Host API 创建/恢复 Agent → 浏览器持续发送输入 → Event Stream 投影 UI
```

两种入口共享同一产品主干，因此行为修复应优先落在拥有它的核心插件，而不是分别修复 Web 和 Headless。

## 本课核心结论

```text
Web 是 Base Runtime 的上层组合，不是另一套 Agent。
Web 参数由应用插件解析，顶层 CLI 只提供原始参数快照。
Host、API、静态前端和浏览器模块分别由多个插件拥有。
Ready Signal 必须等整棵插件树稳定。
浏览器通过经过验证的远程接口操作后端，不能直接持有服务对象。
网络信任和身份验证必须在 Host 边界执行。
```

## 对照练习

`L6-C1`：Pi RPC Mode、Claude Code SDK/Remote 和 DSH Web Host 都能远程驱动 Agent。请比较它们复用的是 Loop、会话 Engine 还是 Cordis Service Graph；为什么 DSH 把“浏览器当前可见的能力集合”也视为 Host 投影的一部分？

## 课后问题

1. `L6-Q1`：为什么 `dsh web` 不需要重新实现 Agent Loop？Web Bundle 相比 Base 主要增加了哪些职责？
2. `L6-Q2`：为什么 Web 参数解析放在 `web-startup` 插件，而不是全部塞进顶层 `bin.ts`？
3. `L6-Q3`：Web App 如果在自己激活后立即打印 URL，而不等 Loader 树稳定，可能产生什么竞态？
4. `L6-Q4`：浏览器为什么不能直接复用后端 TypeScript 类型并调用 Session 对象？跨进程后还必须增加哪些验证？
5. `L6-Q5`：为什么禁止 `0.0.0.0` 和 Trusted Host 检查必须位于 Host，而不能只靠 UI 限制？

回答格式：

```text
L6-Q1: ...
L6-Q2: ...
L6-Q3: ...
L6-Q4: ...
L6-Q5: ...
```
