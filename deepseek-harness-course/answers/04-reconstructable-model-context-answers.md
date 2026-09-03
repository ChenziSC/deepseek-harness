# 第 4 课参考答案：模型可见为什么必须能够重建

[返回第 4 课](../04-reconstructable-model-context.md)

## L4-C1

只在 `agent/request` Listener 中拼入文字，会让本次请求正确但 Session 无法证明模型看见过它。迁移到 DSH 时至少要定义一个能够保存该动态环境事实的 Session Event，并说明它怎样生产或替换 Surface 节点；若它改变 System Prompt、Tool Schema、Route 或 Context Window，还要让 Request Header/Context 记录新的请求基线。Listener 可以参与组装，但最终模型可见结果必须由已记录事实重建。

## L4-Q1

> 为什么不能简单地把 Session 中所有事件按顺序转换成模型 Message？请举出至少三种不应直接进入模型历史的事件。

### 参考答案

Session Event 同时记录生命周期、流式过程、请求元数据和模型消息，只有声明了 Surface 操作的消息生产事件才能进入模型历史。`turn/start`、`step/start`/`step/end`、`assistant/chunk`、`request/header`、`request/context`、`session/title` 等都不应直接变成 Message；它们分别服务于生命周期、回放、诊断或元数据。若全部转换，模型会看到内部控制记录和重复的流式内容，也无法正确处理 Compaction 的替换语义。

## L4-Q2

> 运行时 Sandbox Policy 如果只在调用模型前临时拼入字符串、但不写 Session，会破坏哪些功能？

### 参考答案

Resume 和 Fork 无法重建当时模型看到的 Sandbox 约束，回放与审计也无法解释模型为何选择某个工具或拒绝某项操作。Compaction、Transcript、遥测和 UI 会得到另一份上下文，模型请求与持久事实发生分叉；请求前缀变化和缓存判断也缺少来源。正确做法是在 Pre-Step 把动态 Policy 投影为带来源的可记录消息，再从 Session Surface 构造请求。

## L4-Q3

> 为什么同时需要 `assistant/chunk` 和 `assistant/message`？只保留其中一种分别会失去什么？

### 参考答案

`assistant/chunk` 保存模型流的原始时间顺序，供实时 UI、精确回放和流式故障诊断使用；`assistant/message` 是组装后的稳定语义单元，供下一次模型请求、Transcript 和 Usage 读取。只保留 Message 会失去流式过程与回放保真度；只保留 Chunk 则每个消费者都必须重新组装，而且无法可靠判断哪组 Chunk 构成一个完整、可进入模型历史的 Assistant Message。`sourceEventSeqs` 把二者关联起来。

## L4-Q4

> Compaction 为什么采用 Surface Replace，而不是删除或改写旧事件？

### 参考答案

旧事件是已经接受的事实，删除或改写会破坏追加式历史、序号稳定性、审计和 Fork 边界。Compaction 追加摘要事件，并用 `surfaceOp: replace` 只改变当前模型视图：日志仍保留原消息和生成摘要的事实，Surface 则用摘要替代旧范围。这样既缩短下一次模型上下文，又允许回放、诊断和恢复看到未被篡改的原始历史。

## L4-Q5

> Request Header 已经记录完整 System Prompt 和 Tool Schema，为什么还需要结构化的来源事件与 Surface？

### 参考答案

Request Header 是某次请求前缀的快照，能说明“发出了什么”，但不能表达各段由哪个插件或 Scope 贡献、动态上下文何时替换旧版本、哪些 Chunk 形成稳定 Message，以及 Compaction 或 Fork 应如何处理历史。结构化事件保存来源和生命周期，Surface 定义当前有效消息序列。三者共同支持审计、差异判断、重建和缓存分析；只有压平后的 Header 无法成为可演化的事实模型。
