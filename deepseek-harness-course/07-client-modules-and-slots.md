# 第 7 课：动态 Client Module 与 Slot 页面组合

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课解释为什么 DeepSeek Harness 的 Web 前端不是一个中央 `App.tsx` 导入所有功能。

> 后端由插件树组合，浏览器端也必须能根据同一部署动态组合功能。

## 本课在课程中的位置

- **所属分支：**这是 Web 产品表面的第二课，不是 Agent 后端主干的必修前置。
- **前置课程：**L6 已经解释 Host 怎样暴露同一个 Agent Runtime；L1 提供插件生命周期类比。
- **本课只新增一个判断：**浏览器不能静态假设所有功能都存在，Host 发送 Module Manifest，客户端按依赖加载模块并通过 Slot 组合页面。
- **第一遍重点：**先读 Manifest、Module System、Slot 和卸载语义；Keyed Renderer 与 Chain Slot 是具体扩展协议，可以第二遍再看。
- **本课输出：**浏览器的模块与运行时边界已经清楚。L8 会用“一次图片提交”把 UI、Host、Session 和模型请求串成完整实例。

## 从 Pi / Claude 到 DSH：前端也必须服从部署组合

L6 中 Host 只暴露当前部署真正拥有的能力，因此浏览器不能在构建时假设附件、Plan、Goal 或 Trajectory 永远存在。它需要两层动态组合：

```text
Module Manifest：Host 告诉浏览器本次部署要加载哪些代码包
Client Module：加载后的代码向浏览器 Cordis 注册服务和 UI 插件
Slot：页面骨架预留的命名位置，功能插件在这里注册组件
```

Manifest 解决“代码是否存在以及按什么依赖顺序加载”，Slot 解决“已经加载的功能放在页面哪里”。二者不是同一种机制。

浏览器端的插件也有 Scope 和生命周期。Session Scope 表示组件只在当前 Session 存在时有效；disposer 表示模块卸载或 HMR 时撤销旧注册。这样动态组合不会留下重复按钮、失效 Renderer 或过期状态。

| 参照实现 | UI 功能怎样进入产品 | 运行时是否由 Host 决定模块集合 | DSH 的变化 |
|---|---|---:|---|
| [Pi TUI / coding-agent extensions](../../pi/packages/coding-agent/src/core/extensions/index.ts) | 产品 Extension 注册命令、工具和 TUI 行为 | 通常由本地启动配置决定 | DSH Host 把本次部署的浏览器模块清单发送给 Client |
| [Claude Code UI](../../claude-code/src/main.tsx) | React/Ink 组件、Command、Hook 和 Store 组成主产品界面 | 主客户端知道自己的产品功能；远程 Web 有独立应用 | DSH Browser 本身也是 Cordis Runtime，不能静态假设后端功能存在 |
| DSH | Client Module 加载代码，Client Plugin 注册服务，Slot 接收组件 | 是；Manifest 来自当前 Host 插件树 | UI 骨架和功能插件具有可撤销注册关系 |

DSH 具体多做的是把后端部署差异投影到前端模块图。它解决“后端没有 Plan 插件但前端仍显示 Plan UI”这类组合漂移；代价是需要 Module Manifest、依赖排序、Slot 类型和 HMR disposer，而不是让一个中央 App 静态导入全部页面。

## 一、Host 先发送 Module Manifest

Host 中的 Client Module Registry 收集当前部署的浏览器插件。打开页面时，Index 注入 Module Manifest，其中描述：

- 模块名；
- Bundle URL；
- 外部依赖；
- 加载顺序所需元数据；
- 客户端插件入口。

浏览器解析入口在 [manifest.ts](../packages/client/modules/src/client/manifest.ts#L148)。Wire 数据不能直接信任，因此要验证字段、模块名和依赖关系。

## 二、Module System 负责依赖有序加载

[ClientModuleSystem](../packages/client/modules/src/client/system.ts#L48) 维护已定义模块、工厂和加载状态。

它的 `require()` 是同步读取：

```text
依赖尚未加载
→ require 不能等待未来结果
→ 当前模块激活失败
```

因此 Host 必须先根据外部依赖图安排 Provider Module，再发送依赖它的 Consumer Module。

这与后端 Cordis `inject` 的目标相同，但发生在不同阶段：

```text
Host：根据 Manifest 组织 Bundle 加载顺序
Client Cordis：根据服务依赖组织插件激活顺序
```

## 三、Client Runtime 提供浏览器侧领域服务

[packages/client/runtime/src/client/index.ts](../packages/client/runtime/src/client/index.ts#L187) 建立浏览器端公共服务，例如：

- Session Runtime；
- Workspace Runtime；
- Remote Connection；
- Conversation Event/View Registry；
- Slot Registry；
- Settings Scope。

UI 插件依赖这些抽象服务，不直接拥有 WebSocket、RPC 或全局 Store 的全部细节。

## 四、Slot 是页面结构的扩展协议

Slot Core 在 [packages/client/ui-slots/src/index.ts](../packages/client/ui-slots/src/index.ts#L621)。一个页面骨架可以声明子 Slot：

| Slot 类型 | 含义 |
|---|---|
| single | 最多一个实现 |
| list | 多个实现按顺序排列 |
| chain | 多个实现按 Selector/Priority 接管 |
| keyed | 按业务 Key 选择 Renderer |

Slot 还声明 Scope：

```text
root           整个浏览器应用
session        必须有当前 Session
session-maybe  允许没有 Session
```

## 五、Conversation 插件拥有骨架，不拥有所有功能

[ui-conversation apply()](../packages/client/ui-conversation/src/client/apply.ts#L114) 声明主要页面位置：

```text
conversation
  ├─ conversation.session
  │    └─ conversation.view
  ├─ conversation.session.header
  ├─ conversation.composer
  ├─ conversation.composer.bar
  ├─ conversation.input.left/right
  └─ conversation.input.attachments/model/plan
```

它提供默认 Chat View 和 Composer，但附件、模型选择、Plan、Goal、Subagent、Trajectory 等插件分别填入命名 Slot。

这使页面所有权变成：

```text
骨架插件：定义位置和注入协议
功能插件：注册自己的组件和领域接口
Slot Runtime：解决排序、接管和 Scope
```

## 六、Keyed Renderer 解耦事件与具体 UI

Conversation Assembler 将 Session Event 组织成带 Key 的业务节点。具体 UI 插件再为某个 Key 注册 Renderer。

例如工具、附件或特殊 Message 不需要让中央 Chat 组件写越来越长的 `switch`。新的节点类型可以同时提供：

- ConversationNodeDefinition：怎样从事件识别业务节点；
- keyed Renderer：怎样渲染该节点。

如果插件卸载，定义和 Renderer 都通过 disposer 撤销。

## 七、Chain Slot 表达“谁接管当前区域”

Composer 是 Chain Slot。普通输入条是 Fallback，但待处理 Question 或 Approval 可以根据当前 Session 状态接管。

```text
Question 正在等待回答
→ Question Panel 接管 Composer

Approval 正在等待
→ Approval Panel 接管 Composer

都不存在
→ 普通 Input Bar
```

这比在 Input Bar 内部导入所有交互类型更符合插件边界。

## 八、卸载语义是动态 UI 的必要条件

每次 Module、Locale、Slot、Renderer 注册都必须返回 disposer。否则 HMR 或插件卸载后：

- 旧 Tab 仍显示；
- 已删除 Tool Renderer 仍处理新事件；
- Locale Dictionary 重复；
- Chain Selector 中存在已失效组件。

因此浏览器端同样遵守“一切注册都是生命周期 effect”。

## 本课核心结论

```text
Host Manifest 决定当前部署有哪些客户端模块。
模块依赖必须先于同步 require 被加载。
Client Runtime 提供浏览器侧领域服务。
页面骨架通过 Slot 声明扩展位置和注入协议。
功能插件独立注册 Tab、控件和 Keyed Renderer。
Chain Slot 处理运行时接管，避免中央组件依赖所有功能。
所有 UI 注册都必须可撤销。
```

## 对照练习

`L7-C1`：Pi Extension 或 Claude Code Command 可以向现有产品增加功能，DSH 为什么还要区分 Module Manifest、Client Plugin 和 Slot？请分别说明三层解决的是下载/依赖、生命周期还是页面所有权。

## 课后问题

1. `L7-Q1`：为什么 Client Module 的同步 `require()` 不能等待尚未下载的依赖？Host 因此必须承担什么责任？
2. `L7-Q2`：后端 Cordis `inject` 和浏览器 Module Manifest 的依赖排序有什么相同点和不同点？
3. `L7-Q3`：为什么附件、Plan、模型选择不应该全部直接写进 `ui-conversation` 的中央组件？
4. `L7-Q4`：`single`、`list`、`chain`、`keyed` 四类 Slot 分别适合表达什么关系？
5. `L7-Q5`：插件卸载时如果只卸载业务服务、不撤销 Slot 和 Renderer，会产生哪些错误？

回答格式：

```text
L7-Q1: ...
L7-Q2: ...
L7-Q3: ...
L7-Q4: ...
L7-Q5: ...
```
