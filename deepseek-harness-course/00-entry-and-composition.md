# 第 0 课：从命令入口到插件树

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课解决的不是“CLI 参数怎么解析”，而是一个更重要的问题：

> DeepSeek Harness 启动时，究竟是谁决定这个进程拥有哪些能力？

答案不是某个 `Application` 类，而是 Profile、Bundle Patch 和 Cordis Loader 共同装配出的插件树。

## 本课在课程中的位置

- **起点：**用你熟悉的 Pi 调用者装配和 Claude Code 产品启动作为基线，定位 DSH 为什么把组合提升为插件图。
- **本课输入：**你已经知道配置只描述意图，但还不知道一个命令怎样选择并组合这些配置。
- **本课只新增一个判断：**运行中的能力来自有顺序的 Profile、Bundle 和 Patch，CLI 入口只负责选择装配路径。
- **第一遍重点：**阅读“入口只分流”“Profile 是组合方案”“Cordis 根 Context”和最后的完整启动流程；Patch 的精确覆盖规则可以第二遍再看。
- **本课输出：**你将得到一棵已经装配好的插件树。下一课才研究树里的插件怎样等待依赖、提供服务和撤销注册。

## 先把“配置生成插件树”说清楚

这句话的完整版本是：

> Profile 和 Patch 先计算出一份最终插件清单，Cordis Loader 再读取清单，为每一行创建运行时节点并执行对应插件。

所以不是 YAML 文件自己变成了对象。真正做转换的是 Loader。

### 第一步：先得到“这次到底要装什么”

Base Bundle 中有很多这样的配置行：

```yaml
- id: session
  name: '@deepseek-ai/dsh-session'

- id: agent
  name: '@deepseek-ai/dsh-agent'
```

一行只回答三个问题：

| 字段 | 通俗含义 | 例子 |
|---|---|---|
| `id` | 这行配置的稳定名称，后续 Patch 用它定位 | `session` |
| `name` | 要加载哪个插件模块 | `@deepseek-ai/dsh-session` |
| `config` | 创建插件时传给它的参数 | Session 存储路径、超时等 |

Profile 先选择若干 Bundle，随后按顺序应用 Profile Patch、用户 Patch 和 `--patch`。Patch 可以通过 `id` 替换一行配置，也可以插入新行。所有层处理完后，系统得到一份**最终配置清单**：这次进程需要 Session、Agent、LLM、Tools、Persistence、Headless Runner 等哪些插件，以及每个插件采用什么参数。

此时仍然没有 Agent，也没有 Session Service，只有一份数据清单。

### 第二步：Loader 把每行配置变成一个运行时节点

[boot()](../packages/boot/app-boot/src/index.ts#L757) 先创建根 Context 并安装 Loader，然后把最终配置交给根 Include。Loader 对每一行执行相同动作：

```text
读取 { id, name, config }
→ 根据 name 加载 JavaScript 模块
→ 为该配置行创建子 Context / 生命周期节点
→ 把 config 传给插件
→ 等插件依赖的 Service 可用
→ 执行插件的 apply
```

运行时结构因此大致变成：

```text
Root Context
└─ Include：负责读取最终配置清单
   ├─ session：执行 @deepseek-ai/dsh-session
   ├─ agent：执行 @deepseek-ai/dsh-agent
   ├─ llm：执行 @deepseek-ai/dsh-llm
   ├─ tools：执行 @deepseek-ai/dsh-tools
   ├─ agent-loop：执行 @deepseek-ai/dsh-agent-loop
   └─ headless-runner：执行 @deepseek-ai/dsh-headless
```

这里的“树”不是源码目录树，也不是类继承树。它表示这些插件节点都挂在根 Context 之下，各自拥有独立生命周期；父节点被释放时，它下面的插件节点也会被释放。

### 第三步：插件执行后才产生真正能力

配置行中的 `name` 只是模块地址。对应插件执行后，才会向 Context 提供服务或注册行为：

```text
session 配置行
→ Loader 加载 dsh-session 插件
→ 插件提供 ctx.sessions

agent 配置行
→ Loader 加载 dsh-agent 插件
→ 插件提供 ctx.agents

headless-runner 配置行
→ Loader 加载 Headless Runner
→ Runner 等 Session、Agent、LLM、Tools 就绪
→ 创建 Agent 并提交用户任务
```

因此可以把启动过程分成两个世界：

| 配置阶段 | 运行时阶段 |
|---|---|
| Profile、Bundle、Patch | Context、Service、Listener、Agent |
| 计算最终插件清单 | Loader 创建和激活插件节点 |
| 描述“希望装什么” | 真正获得可调用能力 |

### 用 Pi 和 Claude Code 对照

Pi 通常由调用者在代码里直接完成装配：

```text
调用者创建 Model、Tools、Callbacks
→ 传给 Agent / runLoop
```

Claude Code 的产品启动代码负责创建 QueryEngine、工具、设置和各种 Manager。DSH 做的事情本质相同，只是把“创建哪些组件”从启动代码移进配置清单，再让 Loader 统一执行：

```text
Pi / Claude：启动代码直接创建组件
DSH：配置列出组件 → Loader 统一创建组件
```

| 参照实现 | 组合入口 | 组合结果 | 主要特点 |
|---|---|---|---|
| [Pi agent core](../../pi/packages/agent/src/agent-loop.ts) | 调用者把 Model、Tools、Callbacks 传给循环 | 一个可运行的 Agent Loop | 最小、显式，产品装配留给宿主 |
| [Claude Code](../../claude-code/src/entrypoints/cli.tsx) | 产品启动代码装配 QueryEngine、工具、设置和模式 | 一个集成式会话产品 | 产品规则可以直接进入启动与 Manager 层 |
| DSH | Profile 选择 Bundle，Patch 得到最终清单，Loader 执行清单 | 一棵可检查、可卸载的运行时插件树 | Headless、Web、ACP 共享核心能力组合 |

DSH 多出的不是 Agent 算法，而是“清单 → 运行时节点”的通用装配层。它让同一组插件可以被不同 Profile 复用和覆盖；代价是理解启动时必须多看一层 Loader。

## 一、入口只分流，不承载产品逻辑

命令入口在 [apps/cli/src/bin.ts](../apps/cli/src/bin.ts#L31)。它只处理三类路径：

```text
profile      启动一个完整 Profile
plugin       管理 Profile 中安装的插件
dump-config  输出组合后的配置树
```

每条路径使用动态 `import()` 加载自己的实现。这么做不只是优化启动时间，也建立了职责边界：`bin.ts` 不需要知道 Agent、模型、工具或 Web UI 如何工作。

如果以后添加一个搜索工具，正常做法不是修改 `bin.ts`，而是让某个插件注册工具，并通过 Bundle 或用户 Patch 把插件装入树中。

## 二、Profile 是组合方案，不是运行时实现

Profile 启动入口是 [profile-boot.ts](../apps/cli/src/profile-boot.ts#L146)。有效配置按以下优先级组合：

```text
Profile 声明的 Bundle，按列表顺序
→ Profile 自己的 cordis.patch.yml
→ Harness Home 的 cordis.patch.yml
→ 命令行 --patch
→ 启动器强制策略，例如 telemetry disable
```

基础 Bundle 在 [packages/bundle/base/cordis.patch.yml](../packages/bundle/base/cordis.patch.yml#L15)。这里可以看到 `llm`、`session`、`agent`、`tools`、`system-prompt`、`agent-loop` 等能力都是普通配置行。

Web 和 Headless 并不各自复制一套核心运行时，而是在 Base 上继续叠加：

```text
base
  ├─ web-app：Host、API、静态前端、浏览器插件
  └─ headless：一次性任务 Driver
```

因此 Profile 表达的是“这次运行选择哪些插件”，而不是“这些插件如何实现能力”。

## 三、Patch 修改的是组合结果

每个配置行都有稳定 `id`。后面的 Patch 可以按 `id` 替换配置或插入新行。

这里有两个容易忽略的规则：

1. 目标行的 `config` 是整体替换，不是任意深度合并。覆盖方必须表达完整配置意图。
2. 配置行的书写顺序主要服务于阅读，不负责启动顺序。真正的激活条件来自插件声明的服务依赖。

例如 `agent-loop` 依赖 Agent、Session、LLM 等服务时，Cordis 会等依赖可用后再激活它，而不是依赖它在 YAML 中排在第几行。

## 四、Cordis 根 Context 才是运行时容器

真正创建运行时的入口在 [packages/boot/app-boot/src/index.ts](../packages/boot/app-boot/src/index.ts#L757)：

```text
创建根 Context
→ 安装 Loader
→ 挂载组合后的 Include
→ 等待插件树稳定
→ 返回可运行的 Context
```

失败时会释放已经创建的部分树。启动完成也不是“某个构造函数返回了”，而是 Loader 确认所有可激活插件已经完成激活。

Headless Runner 因此会先等待 Loader 稳定，再创建 Agent，见 [packages/bundle/headless/src/index.ts](../packages/bundle/headless/src/index.ts#L96)。否则它可能在模型 Provider 或工具插件尚未挂载完成时就启动第一轮。

## 五、一次启动的完整流程

```text
dsh --profile headless "检查项目"
        │
        ▼
bin.ts 解析为 profile 调用
        │
        ▼
profile-boot 加载 Profile 与 Bundle Patch
        │
        ▼
composeEntries 生成有效配置行
        │
        ▼
app-boot 创建 Cordis Context 与 Loader
        │
        ▼
各插件按服务依赖激活
        │
        ▼
headless-runner 等待树稳定并创建 Agent
```

可以运行下面的只读观察命令，把任意一条输出追溯到插入它的 Bundle：

```sh
pnpm dsh --profile web --dump-config
```

## 本课核心结论

```text
CLI 只负责选择启动路径。
Profile 和 Bundle 决定装载哪些插件。
Cordis Context 承载已经装配的运行时服务。
插件依赖决定激活时机，YAML 行顺序不决定启动顺序。
新能力通常通过插件和 Patch 加入，而不是扩大 CLI 入口。
```

## 对照练习

`L0-C1`：如果要增加一个只读审查模式，Pi 通常由调用者换一组 Tools/Callbacks，Claude Code 可以在产品 Mode 和 Tool Context 中组合，DSH 则倾向新增或覆盖哪些 Profile、Bundle、Patch？三种方案各自把复杂度留给了谁？

## 课后问题

1. `L0-Q1`：为什么增加一个新的模型工具通常不应该修改 `apps/cli/src/bin.ts`？请说明入口、组合和能力注册三层各自的职责。
2. `L0-Q2`：Bundle Patch、Profile Patch 和 `--patch` 为什么要有明确的覆盖顺序？如果顺序不稳定，会产生什么问题？
3. `L0-Q3`：为什么不能根据 `cordis.patch.yml` 中的行顺序推断插件启动顺序？真正的启动条件是什么？
4. `L0-Q4`：Headless Runner 为什么必须等 Loader 树稳定后再创建 Agent？如果提前创建，可能观察到什么半配置状态？

建议在 Side 中按以下格式回答：

```text
L0-Q1: ...
L0-Q2: ...
L0-Q3: ...
L0-Q4: ...
```
