# 第 0 课参考答案：从命令入口到插件树

[返回第 0 课](../00-entry-and-composition.md)

## L0-C1

Pi 通常由宿主创建一组只读 Tools，并通过 Callbacks 限制行为，复杂度留在调用者的装配代码。Claude Code 可以让 Mode、ToolUseContext、Permission 和 Prompt 共同表达只读审查，复杂度进入产品状态机和策略层。DSH 会优先复用 Base Bundle，再用审查 Profile 或 Patch 替换工具集合、FS Provider/Policy 与相关 Prompt 插件；配置层决定“装什么”，Scope 与工具策略决定“当前 Agent 看见什么”。DSH 的方案更容易形成可复用部署组合，但必须维护稳定配置 ID、覆盖顺序和插件依赖。

## L0-Q1

> 为什么增加一个新的模型工具通常不应该修改 `apps/cli/src/bin.ts`？请说明入口、组合和能力注册三层各自的职责。

### 参考答案

`bin.ts` 的职责是识别 `profile`、`plugin`、`dump-config` 等启动路径并把控制交给对应实现，它不拥有模型或工具逻辑。Profile、Bundle 和 Patch 决定本次进程装载哪些插件；工具插件则通过 `ctx.tools` 注册 Schema 与执行能力，并让注册归属于插件生命周期。新工具应通过插件加入 Bundle 或用户 Patch。若修改 `bin.ts`，入口会逐渐依赖具体能力，Web、Headless 等组合也无法复用同一注册机制。

## L0-Q2

> Bundle Patch、Profile Patch 和 `--patch` 为什么要有明确的覆盖顺序？如果顺序不稳定，会产生什么问题？

### 参考答案

这些层分别表达发行默认值、Profile 选择、用户级配置和本次启动覆盖，后层必须能够确定地覆盖前层。由于同一 `id` 的配置是整体替换，顺序就是最终配置的语义。顺序不稳定会使相同命令得到不同插件树，用户覆盖可能偶尔失效，模型、权限或 Provider 配置也可能来自不同层，导致运行结果不可复现、问题无法可靠诊断。

## L0-Q3

> 为什么不能根据 `cordis.patch.yml` 中的行顺序推断插件启动顺序？真正的启动条件是什么？

### 参考答案

YAML 行顺序主要帮助人阅读和生成组合结果，不是运行时依赖协议。插件通过 `inject` 等声明自己所需的服务；Cordis Loader 只有在依赖服务可用时才激活 Consumer，并在 Provider 卸载时让相关生命周期失活。因此真正的启动条件是依赖关系和 Loader 的稳定状态，而不是配置行位于前面还是后面。

## L0-Q4

> Headless Runner 为什么必须等 Loader 树稳定后再创建 Agent？如果提前创建，可能观察到什么半配置状态？

### 参考答案

Agent 创建会读取当时可见的 LLM Route、工具、Prompt Section、策略和持久化服务。Loader 未稳定时，这些 Provider 或注册可能仍在激活，Agent 一旦发布，观察者就可能立即发送输入。结果可能是模型 Route 缺失、Tool Schema 不完整、Prompt 少了运行时规则，或持久化监听器尚未挂载。等待 Loader 稳定保证第一次请求看到的是完整组合，而不是偶然的中间状态。
