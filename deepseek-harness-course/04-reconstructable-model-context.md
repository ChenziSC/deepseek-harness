# 第 4 课：为什么“模型可见”必须能够从日志重建

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课解释 DeepSeek Harness 最核心的不变量之一：

> 任何真正进入模型请求的内容，都必须能够从 Session 日志重建。

否则 Resume、Fork、Compaction、遥测、回放和 UI 会各自维护一份不同的“模型看见了什么”。

## 本课在课程中的位置

- **前置课程：**L3 已经展示 User Message、Assistant Message 和 Tool Result 怎样在多个 Step 中产生。
- **本课只新增一个判断：**Session Event Log 是事实来源，模型消息历史是从日志 Surface 计算出的投影，不是另一份独立真相。
- **第一遍重点：**先读“事件日志不等于模型历史”“Append 接受事实”“Surface 投影”和最后的反例；Request Header、Chunk 与 Compaction 是第二遍内容。
- **自检问题：**如果一段动态上下文只拼进内存 Prompt、没有 Session Event，Resume 后为什么无法解释模型行为？
- **本课输出：**你已经理解模型上下文怎样重建。L5 会把同一事实流连接到磁盘保存、恢复修复和其他读取 Projection。

## 从 Pi / Claude 到 DSH：执行视图必须拥有可重建来源

L3 产生了 Turn、Step、Message、Chunk 和 Tool Result。它们都可以是 Session Event，但模型下次并不需要看见全部事件。

| 层次 | 保存或计算什么 | 例子 |
|---|---|---|
| Event Log | 按顺序保存发生过的事实 | `turn/start`、`assistant/chunk`、`tool/result` |
| Surface | 从日志维护当前有效的模型消息节点 | User、Assistant、Tool Result、Compaction Summary |
| Model Request | 某一 Step 真正发送的完整请求 | Surface 消息 + System Prompt + Tool Schema + 模型配置 |

**Projection**是“从事实计算某种读取状态”的通用动作，Surface 是专门面向模型历史的一种 Projection。它不是第二份事实：日志仍是来源，Surface 只回答“下一次模型请求当前应看到哪些消息”。

所以本课的关键检查不是“内存 Prompt 拼对了吗”，而是“这段模型可见内容能否从 Session Event 和请求记录重建”。只有后者能支持 Resume、Fork、Compaction 和回放得到一致结果。

| 参照实现 | 模型前历史如何形成 | 动态上下文如何进入 | DSH 的变化 |
|---|---|---|---|
| [Pi agent core](../../pi/packages/agent/src/agent-loop.ts) | `context.messages → transformContext → convertToLlm` | 宿主可在转换回调中临时改写 | DSH 要求真正模型可见的输入拥有 Session Event 来源 |
| [Claude Code](../../claude-code/src/utils/messages.ts) | Transcript/内存消息经过 Compact Boundary、Attachment 和 API Normalization | Prompt Section、User Context、Attachment、Tool Schema 分通道组装 | DSH 用 SurfaceOp、Request Header/Context 把来源规则集中进日志协议 |
| DSH | Event Log 经过 Surface 得到消息，再叠加记录过的请求前缀 | 动态 Section 先投影成可记录 User Message | Resume、Fork 和遥测可以从相同事实重建模型视图 |

DSH 的强约束是“模型可见 ⟺ 已记录”。Pi 的转换回调更自由，Claude Code 也能通过 Transcript、Attachment 与请求组装恢复大量上下文，但规则分布在多个产品层。DSH 用更多事件和请求 Header 换取统一可重建性；代价是任何新增模型输入都必须设计对应事件，而不能只在调用前拼字符串。

## 一、原始事件日志不等于模型消息历史

Session 日志包含很多事件：

```text
turn/start
step/start
assistant/chunk
request/header
tool/call
session/title
user/message
assistant/message
tool/result
```

只有其中一部分生产模型消息。因此 [Session.append()](../packages/core/session/src/index.ts#L604) 要求消息生产事件声明 `surfaceOp`：

```text
append   在模型 Surface 尾部加入节点
replace  用新的节点替换一段旧 Surface
```

`turn/start` 和 `assistant/chunk` 是持久事实，但不直接成为下一次请求里的 Message。

## 二、Append 是持久事实的接受边界

写入事件时，Session 会：

- 验证数据能够无损 JSON 序列化；
- 验证事件序号连续；
- 验证 Surface 转换是否合法；
- 创建深冻结快照；
- 先提交内存日志，再同步通知观察者；
- 隔离观察者失败，避免已接受事实被回滚。

因此调用方后续修改原对象，不会改写历史。坏数据也会在 Append 现场失败，而不是等到后台持久化时才暴露。

## 三、模型历史从 Surface 投影

[deriveMessages()](../packages/core/session/src/index.ts#L726) 遍历有序 Surface 节点，而不是遍历全部日志。

```text
user/message       → User Message
assistant/message  → Assistant Message
tool/result        → User-role Tool Result Message
compaction replace → 删除被替代节点，加入摘要节点
```

这使日志可以同时保留：

```text
原始事实：旧消息和流式 Chunk 仍可审计
当前模型视图：只包含 Surface 中仍然有效的节点
```

## 四、动态运行时上下文也要变成消息

System Prompt Registry 除了静态 Prompt，还会组装每次请求变化的运行时 Section，例如：

- Sandbox Policy；
- Approval Policy；
- 当前时间；
- Workspace 指令；
- 插件注入上下文。

`preStep()` 会把动态 Section 投影成带来源信息的 `user/message`，然后再调用模型。参考工具快照中的运行时上下文事件：[tool-call-turn/session.jsonl](../examples/acp-agent/tests/snapshots/tool-call-turn/session.jsonl#L6)。

如果只在内存变量里把一段文字拼进请求，它就无法在 Resume 或 Fork 后重新得到。

## 五、Request Header 记录请求前缀

[buildRequest()](../packages/core/agent-loop/src/agent.ts#L430) 在真正流式调用前记录：

```text
request/header
  ├─ provider / model / reasoning / maxTokens
  ├─ system prompt
  └─ tool schemas

request/context
  └─ route 与 contextWindow
```

第一次请求记录 `initial`，Resume 后建立新基线记录 `resume`，配置或 Prompt 变化记录 `change`。

这不仅服务于审计，也让系统能够判断模型请求前缀何时变化、哪一段 KV Cache 可能失效。

## 六、Chunk 和 Message 服务不同消费者

模型流中的每个 Chunk 都记录为 `assistant/chunk`，最终稳定结果记录为 `assistant/message`。

```text
assistant/chunk
  → 实时 UI、精确回放、流式诊断

assistant/message
  → 下一次模型历史、稳定 Transcript、Usage
```

最终 Message 的 `sourceEventSeqs` 指向构成它的 Chunk。这样回放 UI 可以保留原始流，同时模型历史只消费稳定 Message。

工具结果也通过 `sourceEventSeqs` 指向自己的 `tool/call`，保持调用和结果之间的来源关系。

## 七、Compaction 修改 Surface，不篡改旧事实

当上下文过长时，Compaction 可以追加一个新的摘要事件，并以 `surfaceOp: replace` 替换旧节点。

结果是：

```text
日志：旧消息 + 新摘要都存在
Surface：旧范围被摘要节点替代
模型：下一次只看到替代后的历史
```

这与直接修改或删除旧事件不同。事实历史仍可审计，当前模型执行视图则可以缩短。

## 八、为什么不能只记录最终 Prompt 字符串

只保存完整 Prompt 字符串虽然看似简单，却会丢失：

- 哪个插件贡献了哪一段；
- 哪些动态上下文已取代旧快照；
- 哪些 Tool Schema 属于当前 Scope；
- 哪些 Message 是 Compaction 替换结果；
- 哪些 Chunk 构成最终 Assistant Message；
- Fork 时应该复制哪些结构化事实。

所以 Harness 同时保存结构化事件和请求 Header，而不是把所有状态压扁成一段无法解释的文本。

## 本课核心结论

```text
Session 日志保存事实，Surface 定义当前模型消息序列。
消息生产事件必须声明如何进入或替换 Surface。
动态模型上下文必须记录成可重建事件。
Request Header 保存 System Prompt、Tool Schema 和模型配置基线。
Chunk 服务流式回放，Message 服务稳定历史。
Compaction 替换模型 Surface，不篡改旧事实。
```

## 对照练习

`L4-C1`：Pi 的 `transformContext` 可以临时加入一段环境说明，Claude Code 可以通过 Attachment 加入动态上下文。若把同样功能迁到 DSH，为什么仅实现一个 `agent/request` Listener 还不够？至少还要设计哪类 Session Event 或 Surface 行为？

## 课后问题

1. `L4-Q1`：为什么不能简单地把 Session 中所有事件按顺序转换成模型 Message？请举出至少三种不应直接进入模型历史的事件。
2. `L4-Q2`：运行时 Sandbox Policy 如果只在调用模型前临时拼入字符串、但不写 Session，会破坏哪些功能？
3. `L4-Q3`：为什么同时需要 `assistant/chunk` 和 `assistant/message`？只保留其中一种分别会失去什么？
4. `L4-Q4`：Compaction 为什么采用 Surface Replace，而不是删除或改写旧事件？
5. `L4-Q5`：Request Header 已经记录完整 System Prompt 和 Tool Schema，为什么还需要结构化的来源事件与 Surface？

回答格式：

```text
L4-Q1: ...
L4-Q2: ...
L4-Q3: ...
L4-Q4: ...
L4-Q5: ...
```
