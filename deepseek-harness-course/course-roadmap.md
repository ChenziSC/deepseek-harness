# 课程关系图：每一课为什么出现在这里

这套课程沿“Pi 最小循环 → Claude Code 产品化 → DSH 插件化与事件化”逐层推进。它不是十二个平行主题，也不是必须从 L0 一直线性读到 L11，而是一条必修主干和两条选修分支。

## 一、真实依赖关系

```text
L0 先建立“配置 ≠ 运行时”，再解释插件树怎样装配
   │
   ▼
L1 插件怎样提供能力并管理生命周期
   │
   ▼
L2 Session、AgentRegistry、AgentLoop 各自负责什么
   │
   ▼
L3 一次 Turn 怎样经过一个或多个 Step
   │
   ▼
L4 模型看见的内容为什么必须从日志重建
   │
   ▼
L5 日志怎样持久化、恢复并投影成读取状态
   │
   ├──────── 产品表面分支 ────────┐
   │                              ▼
   │                         L6 Web Host
   │                              │
   │                              ▼
   │                         L7 Client Module / Slot
   │                              │
   │                              ▼
   │                         L8 输入与附件跨层流程
   │
   └──────── 能力扩展分支 ────────┐
                                  ├─ L9 Subagent / Job
                                  ├─ L10 Credential / Authorization
                                  └─ L11 用 Capability Seam 统一复盘
```

L0–L5 是必修主干。每一课把所需概念放在第一次使用它的代码流程之前，因此不需要另读前置概念页。没有这六课，后面的 Web、Subagent 和 Credential 会像互不相关的包目录。

L6–L8 只在你想理解 Web 产品时阅读。L9–L11 研究怎样扩展后端能力，不要求先掌握浏览器 Slot 或图片上传。

## 二、主干课程共同解释一件事

假设用户在 CLI 中输入“读取配置文件并解释”。这一个任务会依次经过：

| 课程 | 它观察同一个任务的哪个问题 |
|---|---|
| L0 | 进程为什么拥有 LLM、FS 和工具能力？ |
| L1 | 这些能力由哪些插件注册，卸载时怎样撤销？ |
| L2 | 谁保存事实，谁管理活跃 Agent，谁驱动算法？ |
| L3 | 用户输入怎样变成模型请求、工具调用和下一次模型请求？ |
| L4 | 模型每一步看见的消息怎样从 Session 日志得到？ |
| L5 | 进程退出后，事实怎样保存、修复和重新投影？ |

这六课不是六套系统，而是从装配、生命周期、对象职责、运行时序、模型上下文和耐久状态六个角度观察同一次执行。

## 三、两条分支怎样接到主干

### 产品表面分支：L6–L8

L5 已经得到可恢复的 Session 和可计算的 Projection。L6 研究 Web Host 怎样把它暴露给浏览器，L7 研究浏览器功能怎样继续保持插件化，L8 用一次图片提交把 UI 临时状态、Host 接纳、Session 事实和模型请求串起来。

```text
核心运行时 → Host API → 浏览器模块 → 一次真实跨层输入
    L5          L6          L7              L8
```

如果你只想理解 Agent 后端，完成 L5 后可以暂时跳过这条分支。

### 能力扩展分支：L9–L11

L1 已经建立插件和 Provider 概念，L2–L5 已经建立 Agent、Session 和生命周期。L9 用 Subagent 展示复杂后台能力，L10 用 Credential 展示安全敏感能力，L11 再抽象出分析任何能力都能使用的 Definition、Provider、Consumer 方法。

```text
插件与运行主干 → 两个复杂能力案例 → 通用分析方法
     L1–L5          L9 / L10            L11
```

## 四、每课的输入和输出

| 课程 | 从 Pi / Claude 带入的已知问题 | DSH 新增的核心判断 |
|---|---|---|
| L0 | Agent 应用怎样选择 Model、Tools 和运行模式 | 组合本身成为 Profile/Bundle/Patch 驱动的插件图 |
| L1 | Callback、Hook 和 Registry 怎样扩展循环 | 注册必须属于 Cordis Effect，并随 Scope 撤销 |
| L2 | 会话对象、消息历史和循环由谁持有 | Session、AgentRegistry、AgentLoop 分别拥有事实、活跃实例和算法 |
| L3 | `runLoop` / `query` 怎样继续下一次模型请求 | Turn、Step、Inbox 和唯一 Driver 构成可记录控制协议 |
| L4 | 完整历史、执行视图和 Provider Payload 为什么不同 | 所有模型可见输入必须能从 Session Event Log 重建 |
| L5 | JSONL、Resume 与 Compaction 怎样恢复会话 | Persistence、Repair、Projection 是独立能力 |
| L6 | REPL、SDK、Remote UI 怎样复用内核 | Web Host 是同一插件运行时的受限远程投影 |
| L7 | 产品 UI 怎样接入新增功能 | Host Manifest、Client Module 和 Slot 使前端也按部署组合 |
| L8 | 图片和 Attachment 怎样进入模型请求 | Draft、耐久 Attachment、Route Variant、Wire 表示各有所有者 |
| L9 | Subagent 和后台任务怎样执行 | 委派 Provider、Job 所有权和 Team 协议彼此正交 |
| L10 | API Key 怎样存储和使用 | CredentialRef、Provider Record、Authorization Flow 分层 |
| L11 | Tool Definition 和执行器怎样解耦 | Definition、Provider、Consumer 必须共同构成完整能力 |

## 五、推荐学习顺序

### 第一次学习：只建立主干

```text
L0 → L1 → L2 → L3 → L4 → L5
```

每课第一遍先读“本课位置”和紧随其后的 Pi/Claude/DSH 对照区，再读运行图和核心结论，不点源码。能够讲清 DSH 改变了哪个职责或生命周期后，再读正文。

### 第二次学习：选择一个分支

想理解产品端，读 L6–L8；想理解插件能力设计，读 L9–L11。不要同时交替学习两条分支。

### 第三次学习：才使用源码锚点

源码用于验证概念，不用于第一次建立概念。每次只打开一个入口函数，回答“输入、输出、所有者、耐久事实”四个问题；不要沿所有 import 继续下钻。

## 六、什么时候可以进入下一课

不要求记住类名。只要能不看文档回答下面两个问题即可：

1. 本课解决的是哪一个架构问题？
2. 这个结论为什么是下一课的前提？

如果只能复述 API 或包名，说明还没有建立概念，应回到本课运行图而不是继续读更多源码。

下一步从 [第 0 课：从命令入口到插件树](00-entry-and-composition.md) 开始。
