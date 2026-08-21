# 源码学习路径

[English](source-learning-path.md) | 中文

这份路径面向希望理解 DeepSeek Harness 设计而非逐行阅读实现的维护者。学习单位不是文件，而是一段可观察的运行流程：先找到谁拥有输入，再沿事件、服务与生命周期追到输出。每课只精读少量入口，其余文件用测试和 README 验证职责。

## 使用方法

每课按同一顺序进行：先读“概念目标”，再沿“运行分区”定位代码，最后执行“观察点”并回答“检查点”。不要一开始展开类型、样式或测试夹具；只有运行分区中的某一步无法解释时，才向下追一层。

建议先完成第 0—4 课，建立主干模型；第 5—8 课解释当前 Web 产品如何把主干投影给用户；第 9—11 课再学习可替换能力。完整路径约需两到三周，每课适合安排半天到一天。

## 总体心智模型

一次请求并不是从 CLI 直接调用某个大函数。应用先把若干组合包叠成 Cordis 插件树；插件树提供会话、agent、LLM、工具等服务；agent loop 只推进轮次与步骤；所有模型可见内容和用户可见结果写入会话事件；Host 把事件投影成客户端状态；浏览器再通过动态模块与 slot 选择具体界面。

| 层次 | 主要问题 | 真源 |
|---|---|---|
| 组合 | 这次进程装载了哪些能力？ | profile、组合包 patch、`cordis.yml` |
| 执行 | 当前轮次为什么继续、停止或重试？ | agent inbox、agent loop、事件分发 |
| 记录 | 哪些事实能够恢复、回放和分页？ | 仅追加会话事件日志 |
| 投影 | Host 与浏览器如何得到当前状态？ | 会话投影、API remotes、客户端 assembler |
| 展示 | 哪个插件拥有某块 UI？ | 客户端 manifest、slot 注册与 locale |

## 第 0 课：从命令入口到插件树

**概念目标：**理解“启动应用”实际是解析模式、组合 profile、挂载 Cordis 配置树，而不是实例化一个固定应用类。

**运行分区：**

1. **命令分派：**[`apps/cli/src/bin.ts`](../apps/cli/src/bin.ts) 的顶层 `switch` 只选择 `profile`、`plugin` 或 `dump-config` 路径；动态导入避免其他模式进入当前启动链。
2. **Profile 组合：**[`apps/cli/src/profile-boot.ts`](../apps/cli/src/profile-boot.ts) 读取 profile manifest，把组合包、用户 patch 与命令行 overlay 按优先级组成配置。
3. **根上下文：**[`packages/boot/app-boot/src/index.ts`](../packages/boot/app-boot/src/index.ts) 的 `boot()` 创建 Cordis 根上下文、挂载 include，并等待配置树全部激活。
4. **实际装配：**[`apps/cli/config/agent-presets/standard/agent.cordis.yml`](../apps/cli/config/agent-presets/standard/agent.cordis.yml) 与 [`packages/bundle/web-app/cordis.patch.yml`](../packages/bundle/web-app/cordis.patch.yml) 展示“功能由插件行组成”的最终形态。

**观察点：**运行 `pnpm dsh --profile web --dump-config`，从输出中任选一个 UI 插件，反查是哪一层 patch 将它插入树中。

**检查点：**能够解释为什么新增功能通常要增加插件或组合包配置，而不是修改 CLI 入口。

## 第 1 课：Cordis 生命周期与“一切皆插件”

**概念目标：**理解 context、服务注入、effect disposer 与插件 fiber 如何共同确定资源所有权。

**运行分区：**

1. **声明依赖：**从 [`docs/cordis-primer.zh.md`](cordis-primer.zh.md) 理解 `inject`、`ctx.plugin()` 与 `ctx.get()`；依赖决定插件何时可激活。
2. **注册贡献：**在 [`packages/core/system-prompt/src/index.ts`](../packages/core/system-prompt/src/index.ts) 观察注册表服务如何接收插件贡献并返回 disposer。
3. **绑定生命周期：**在 [`packages/boot/app-boot/src/index.ts`](../packages/boot/app-boot/src/index.ts) 观察失败启动如何 dispose 已构造的根上下文。
4. **验证关系：**阅读 [`packages/AGENTS.md`](../packages/AGENTS.md) 的 invariant 规则，区分“服务存在”与“插件拥有的关系仍成立”。

**观察点：**选择一个 `ctx.effect()` 注册，画出“创建 → 对外可见 → disposer → 不再可见”的四个时刻。

**检查点：**能够说明为什么直接修改全局数组或留下无 disposer 的监听器会破坏插件卸载语义。

## 第 2 课：会话、agent 与 agent loop 主干

**概念目标：**区分三个常被混在一起的角色：Session 保存事实，AgentRegistry 管理存活 agent，AgentLoop 提供具体驱动实现。

**运行分区：**

1. **会话身份与日志：**[`packages/core/session/src/index.ts`](../packages/core/session/src/index.ts) 定义会话存储及追加事件的接口。
2. **Agent 注册：**[`packages/core/agent/src/index.ts`](../packages/core/agent/src/index.ts) 的 `AgentRegistry` 管理创建工厂、存活实例和 initiator 归属。
3. **具体实现：**[`packages/core/agent-loop/src/agent.ts`](../packages/core/agent-loop/src/agent.ts) 的 `ReactLoopAgent` 持有 inbox、phase 与驱动状态。
4. **发布事务：**[`packages/core/agent-loop/README.zh.md`](../packages/core/agent-loop/README.zh.md) 解释 create/resume 如何在 setup 完成后依次发布 Session 与 Agent。

**观察点：**从 `AgentRegistry.create()` 追到具体工厂，再记录会话创建、agent 创建与循环启动的先后关系。

**检查点：**能够解释为什么调用方在创建完成前看不到“只配置了一半”的 agent，以及 handle 为什么代表销毁能力。

## 第 3 课：一个轮次如何推进

**概念目标：**掌握 Session > Turn > Step 的层级，以及 inbox、系统提示词、LLM 流和工具调用如何让一个轮次产生多个步骤。

**运行分区：**

1. **领取输入：**`ReactLoopAgent.preStep()` 从 inbox 领取目标消息，并组装本步骤使用的系统提示词上下文。
2. **建立边界：**`ReactLoopAgent.turn()` 追加 `turn/start` 与 `step/start`，然后把领取的消息写成 `user/message`。
3. **请求模型：**`ReactLoopAgent.step()` 解析模型目标、收集工具 schema、发出 LLM 请求并记录流式输出。
4. **执行工具：**[`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts) 配对工具调用与结果；新 inbox 消息可进入下一步骤。
5. **确定结束：**循环追加 `step/end` 和 `turn/end`，保留 completed、max-tokens、blocked、aborted 或 error 等结构化原因。

**观察点：**运行一个只需回答的问题和一个需要工具的问题，对比两份日志中的 Turn/Step 数量与事件顺序。

**检查点：**能够说明“一个用户消息”等于一次唤醒，而不一定只产生一次模型请求。

## 第 4 课：模型可见内容为什么必须写入日志

**概念目标：**理解系统提示词、工具 schema、上下文注入与模型消息的组装位置，以及“模型可见 ⟺ 可从日志重建”的约束。

**运行分区：**

1. **提示词注册：**[`packages/core/system-prompt/src/index.ts`](../packages/core/system-prompt/src/index.ts) 聚合插件提供的具名段落与变量。
2. **工具注册：**[`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts) 管理工具、展示意图与 Code Mode 表层。
3. **请求头：**[`packages/core/session/src/request-header.ts`](../packages/core/session/src/request-header.ts) 记录一次请求采用的模型、选项和上下文来源。
4. **运行时英文：**默认系统提示词、工具 schema 与模型格式约束保持英文，因为它们直接发送给模型或被机器解析；中文学习说明只能放在相邻注释与文档中。

**观察点：**任选一个 prompt 段落，回答“谁注册、何时组装、写入哪类事件、修改后影响哪段 KV Cache 前缀”。

**检查点：**能够判断一段英文是说明性文案、模型运行时文本还是协议字段，并选择翻译、注释或保持原文。

## 第 5 课：持久化、投影与恢复

**概念目标：**理解日志是真源，投影是可重算的读取模型，SQLite/JSONL 只是持久化提供方。

**运行分区：**

1. **追加事实：**[`packages/core/session/src/types.ts`](../packages/core/session/src/types.ts) 定义事件信封和类型扩展方式。
2. **持久化：**[`packages/session/session-persistence/README.zh.md`](../packages/session/session-persistence/README.zh.md) 说明 prepare、append 与恢复职责。
3. **Host 投影：**[`packages/session/session-projection/src/index.ts`](../packages/session/session-projection/src/index.ts) 的注册表把多个投影单元折叠成可查询状态。
4. **客户端镜像：**[`packages/client/runtime/src/client/sessions/projection-store.ts`](../packages/client/runtime/src/client/sessions/projection-store.ts) 保存 Host 投影值；[`conversation-assembler.ts`](../packages/client/runtime/src/client/sessions/conversation-assembler.ts) 再把事件窗口组装成各视图的业务 Node。

**观察点：**从一个 UI 统计值反向追踪到投影单元，再追到它消费的会话事件；确认分页不会改变该值。

**检查点：**能够解释为什么不能把需要恢复的产品状态只放在 React store 或进程内 Map 中。

## 第 6 课：Web Host 如何启动并连接浏览器

**概念目标：**理解 Web 组合包同时拥有启动命令、Host 服务、静态资源和浏览器连接，但这些仍由多个插件协作完成。

**运行分区：**

1. **命令入口：**[`packages/bundle/web-app/src/startup.ts`](../packages/bundle/web-app/src/startup.ts) 注册 Web 命令并决定何时启动 surface。
2. **Host 组装：**[`packages/bundle/web-app/src/index.ts`](../packages/bundle/web-app/src/index.ts) 连接 webserver、API proxy、静态前端与自动打开浏览器策略。
3. **远程接口：**[`packages/api/remotes/README.zh.md`](../packages/api/remotes/README.zh.md) 说明浏览器消费的 RPC 与事件流如何由插件投影出来。
4. **首页注入：**[`packages/host/frontend-static/README.zh.md`](../packages/host/frontend-static/README.zh.md) 解释 Host 如何把客户端模块 manifest 和启动数据注入首页。

**观察点：**启动 `pnpm dsh web`，在浏览器网络面板中区分首页、客户端 bundle、RPC 与事件流四类请求。

**检查点：**能够说明 Web UI 不是直接 import 整个后端，也不是由单一“Web 应用插件”拥有所有功能。

## 第 7 课：动态客户端模块与 slot

**概念目标：**理解 Host 先发送模块 manifest，浏览器再按依赖顺序加载 bundle；功能通过 slot 注册进入现有页面，而不是集中写入一个 App 组件。

**运行分区：**

1. **模块协议：**[`packages/client/modules/src/client/manifest.ts`](../packages/client/modules/src/client/manifest.ts) 定义 Host 描述模块所需的记录及依赖关系。
2. **模块装载：**[`packages/client/modules/src/client/system.ts`](../packages/client/modules/src/client/system.ts) 提供模块工厂、`require` 与动态 bundle 加载。
3. **客户端根：**[`packages/client/runtime/src/client/index.ts`](../packages/client/runtime/src/client/index.ts) 注册会话、workspace 与通用客户端服务。
4. **页面组合：**[`packages/client/ui-conversation/src/client/apply.ts`](../packages/client/ui-conversation/src/client/apply.ts) 声明会话页骨架与 slot；工具、附件、模型选择等包各自填入具名位置。

**观察点：**从 `conversation.view` 或 `tool.call.toolview` 任选一个 slot，列出 owner、注册者、注入 props 与卸载结果。

**检查点：**能够解释为什么同步 `require` 不能等待尚未到达的模块，以及 Host 为什么必须按外部依赖图先发送提供方。

## 第 8 课：输入、附件、设置与多视图

**概念目标：**理解浏览器输入不是直接发字符串，而是经过输入状态机、附件信封、Host admission、会话事件和视图投影。

**运行分区：**

1. **输入状态机：**[`packages/client/ui-conversation/src/client/input/machine.ts`](../packages/client/ui-conversation/src/client/input/machine.ts) 管理草稿阶段；`facade.ts` 把 UI 操作映射为提交事务。
2. **附件所有权：**[`packages/client/ui-attachment/README.zh.md`](../packages/client/ui-attachment/README.zh.md) 说明草稿附件、提交信封与历史图片的不同生命周期。
3. **插件设置：**[`packages/client/ui-settings/README.zh.md`](../packages/client/ui-settings/README.zh.md) 说明插件自有 schema 如何经 Host 镜像进入统一设置界面。
4. **并行视图：**Chat 与 [`packages/client/ui-trajectory/README.zh.md`](../packages/client/ui-trajectory/README.zh.md) 消费同一事件窗口，但各自拥有 Definition、assembler 状态和渲染器。

**观察点：**发送一条带图片的消息，分别记录草稿图片 id、Host 接纳、持久事件和历史图片读取发生在哪个阶段。

**检查点：**能够说明为什么附件、设置或 Trajectory 不能只在 `ui-conversation` 内部临时实现。

## 第 9 课：subagent、后台任务与实验性 Agent Teams

**概念目标：**区分能力定义、具体提供方、模型工具与客户端展示；理解子级运行的所有权和父子通信不是同一个概念。

**运行分区：**

1. **能力注册表：**[`packages/subagent/subagent/src/index.ts`](../packages/subagent/subagent/src/index.ts) 的 `SubagentRuntime` 管理具名提供方。
2. **运行生命周期：**[`packages/subagent/subagent/src/lifecycle.ts`](../packages/subagent/subagent/src/lifecycle.ts) 统一前台、后台、继续执行与结算事实。
3. **模型消费方：**[`packages/subagent/tool-subagent/src/index.ts`](../packages/subagent/tool-subagent/src/index.ts) 把委派能力包装成模型工具；控制与报告由独立包承担。
4. **实验层：**[`packages/experimental/README.zh.md`](../packages/experimental/README.zh.md) 中的 Agent Teams 在真实运行时上试验 roster、mailbox 与共享任务 DAG，但不进入正式发布。

**观察点：**选择 in-process 与一个 out-of-process 提供方，对比它们共享的 `SubagentRequest`/结果约定和各自持有的资源。

**检查点：**能够解释为什么“增加一种 subagent”应注册新提供方，而不是在工具实现中增加 provider 分支。

## 第 10 课：凭据记录与交互式授权

**概念目标：**区分配置里的凭据引用、提供方保存的凭据记录，以及需要询问用户才能取得凭据的授权 flow。

**运行分区：**

1. **引用与记录：**[`packages/credentials/credentials/src/index.ts`](../packages/credentials/credentials/src/index.ts) 提供解析与记录注册表。
2. **本地提供方：**[`packages/credentials/credentials-local/README.zh.md`](../packages/credentials/credentials-local/README.zh.md) 决定环境变量和本地凭据文件的优先级。
3. **授权 flow：**[`packages/credentials/authorization/src/index.ts`](../packages/credentials/authorization/src/index.ts) 通过交互服务索取值、写入记录，再返回记录键。
4. **消费边界：**模型提供方在执行操作时解析引用；UI 只读取安全的元数据，不读取密钥原值。

**观察点：**从一个模型 Provider 的 `CredentialRef` 追到解析调用，标出哪一步可能显示交互、哪一步接触明文、哪一步只返回元数据。

**检查点：**能够说明为什么 API key 不能直接进入设置投影、会话日志或通用错误文本。

## 第 11 课：能力 seam 与代码执行

**概念目标：**用代码运行时作为范例，掌握 Service Definition / Service Provider / Consumer 三种角色组成的完整能力 seam。

**运行分区：**

1. **Service Definition：**[`packages/code-runtime/code-runtime/src/index.ts`](../packages/code-runtime/code-runtime/src/index.ts) 定义语言、绑定、请求与结果，不选择具体隔离实现。
2. **Service Provider：**[`packages/code-runtime/code-runtime-worker-thread/src/index.ts`](../packages/code-runtime/code-runtime-worker-thread/src/index.ts) 提供 Worker 线程执行；Python 提供方另有 fd3 JSONL 协议。
3. **协议边界：**[`packages/code-runtime/code-runtime-python/src/protocol.ts`](../packages/code-runtime/code-runtime-python/src/protocol.ts) 验证跨进程消息、预算与错误分类；字段和机器输出保持英文且稳定。
4. **Consumer：**[`packages/core/tools/src/code-mode.ts`](../packages/core/tools/src/code-mode.ts) 把已注册运行时转换成模型可调用的 Code Mode 工具。

**观察点：**替换或禁用一个 Service Provider，确认 Consumer 的请求类型不变，并记录缺少提供方时在哪个最早可判定位置失败。

**检查点：**能够为任一新能力画出三种角色、配置解析位置、跨边界验证位置和生命周期 owner。

## 学完后的维护顺序

面对一个新需求或故障时，按以下顺序定位：先找用户或模型实际看到的结果，再找到拥有该结果的插件；向上追它消费的投影、事件或服务；确认事实由谁记录、资源由谁释放；最后才进入具体算法。若改动进入模型请求，检查会话事件与快照；若改动进入 Web UI，检查 locale、slot、Host 投影和 GUI 测试；若改动跨进程，检查协议验证、错误分类和关闭路径。

这条顺序能避免把展示问题修进 agent loop、把持久状态放进客户端 store，或把某个提供方的特殊逻辑泄漏到能力接口中。
