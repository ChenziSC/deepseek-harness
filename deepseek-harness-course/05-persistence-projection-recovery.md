# 第 5 课：持久化、Projection 与恢复

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课需要区分三类经常被混为一谈的数据：

```text
Session Log：发生过什么
Persistence：这些事实如何耐久保存
Projection：为了读取和展示，从事实计算出什么状态
```

## 本课在课程中的位置

- **前置课程：**L4 已经建立“日志是事实、模型历史是投影”；本课把这个区分推广到保存、恢复和产品读取。
- **本课只新增一个判断：**Persistence 负责耐久保存事实，Repair 负责闭合中断生命周期，Projection 负责计算读取状态，三者互不替代。
- **第一遍重点：**只读 Persistence、热路径写入、恢复修复和 Projection；Coordinator 的完整写入规则与分页一致性可第二遍阅读。
- **核心自检：**把聊天列表保存进数据库，为什么仍不能代替保存 Session Event Log？
- **本课输出：**至此必修主干结束。接下来不要同时读两条分支：想理解 Web 进入 L6，想理解后端能力可直接进入 L9。

## 从 Pi / Claude 到 DSH：Session 存储被拆成三种能力

L4 已经说明 Event Log 是事实来源，Surface 是面向模型的读取结果。本课把同一关系扩展到整个产品：

```text
Session Log  定义记录哪些事实及其顺序
Persistence  把 Header 和日志耐久写入 JSONL、SQLite 等介质
Projection   从完整事实流计算会话列表、统计或 UI 所需状态
Recovery     重新加载事实，并把中断协议闭合到可继续状态
```

四者不能互相替代。数据库里的聊天列表只是 Projection，不能证明工具调用是否已经结算；内存 Session 已经接受一个事件，也不能证明磁盘写入已经完成；读取到一段以 `step/start` 结尾的日志，也不能直接当作可继续状态。

这里还要区分两个成功时刻：`append` 成功表示事实已进入当前内存 Session，`flush` 完成才表示排队写入已经到达 Provider 的耐久点。理解这个时间差，才能看懂为什么运行热路径不等待每个 Chunk 落盘，但进程退出前必须 Flush。

| 参照实现 | 持久化与恢复模型 | Compaction/读取视图 | DSH 的变化 |
|---|---|---|---|
| [Pi coding-agent `SessionManager`](../../pi/packages/coding-agent/src/core/session-manager.ts) | 产品层管理 JSONL、分支和会话元数据 | [Compaction](../../pi/packages/coding-agent/src/core/compaction/compaction.ts) 生成执行历史 | DSH 把底层存储替换能力从产品 Session Manager 中抽离 |
| [Claude Code `sessionStorage`](../../claude-code/src/utils/sessionStorage.ts) | UUID/Parent 关系、JSONL 与 [Resume Repair](../../claude-code/src/utils/conversationRecovery.ts) 共同重建逻辑链 | Compact Boundary 区分物理记录、逻辑链和 API 视图 | DSH 使用连续 Event Seq、Header、Surface 与独立 Projection Fold |
| DSH | Session 接受事实，Persistence Provider 保存，Repair 追加闭合事件 | Projection 从完整日志计算读取状态，可缓存但可重算 | JSONL/SQLite、Web 列表和模型历史不再共享一个存储对象 |

DSH 具体多做的是给存储实现、协议修复和读取模型分别定义所有者。它避免“换数据库就重写恢复语义”或“为了 UI 列表改变事实格式”；代价是需要 Coordinator、版本验证、Projection 注册表和明确 Flush 点。

## 一、Session Header 和事件日志承担不同职责

Session Header 保存：

- SessionId；
- 格式版本；
- 创建时间；
- 工作目录；
- Fork 父 Session 和 Seed Boundary；
- 来源、委派深度等创建元数据。

这些信息与存储对象的身份有关，不是对话中可重放的模型事实，因此和事件日志分开保存。

事件日志则保存按 `seq` 连续追加的运行事实。恢复时必须同时验证 Header 和事件序列，而不是只解析几行 JSON。

## 二、Persistence 是一个可替换能力

持久化接口定义在 [SessionPersistence](../packages/session/session-persistence/src/index.ts#L84)。它不假设底层是文件还是数据库，而是定义：

```text
create   建立一个持久 Session
append   追加连续事件并等待耐久
load     读取并验证逻辑日志
flush    等待当前写入收敛
locate   可选地给出独立物理 Artifact 位置
```

两个主要 Provider 是：

- [JsonlSessionPersistence](../packages/session/session-persistence-jsonl/src/index.ts#L121)
- [SqliteSessionPersistence](../packages/session/session-persistence-sqlite/src/index.ts#L52)

上层 Session Store 和 Agent Resume 不需要根据 Provider 写分支。

## 三、热路径 Append 不直接等待磁盘

`Session.append()` 先在内存中同步接受事实并通知观察者。持久化插件监听事件，再交给 Write-Behind 队列批量写入。

```text
Agent Loop
→ Session.append
→ 内存事实已提交
→ session/event 通知 Persistence
→ Write-Behind 缓冲和批量追加
→ flush 等待耐久点
```

这么做避免每个流式 Chunk 都阻塞模型循环，但也意味着：

> “已经进入内存日志”和“已经耐久保存”是两个时间点。

因此 Headless Runner 在打印最终结果和退出前显式调用 `sessions.flush()`，见 [packages/bundle/headless/src/index.ts](../packages/bundle/headless/src/index.ts#L121)。

## 四、PersistenceCoordinator 统一写入不变量

[PersistenceCoordinator](../packages/session/session-persistence/src/coordinator.ts#L588) 把 Provider 共有的规则集中起来：

- Header 先于事件；
- 追加必须从已保存前缀之后连续开始；
- 写入批次有明确提交位置；
- 缓存的 Prepared Session 必须与后端 Revision 一致；
- 加载要拒绝不支持的格式版本；
- 损坏或 Torn Tail 需要明确分类。

这体现了能力接口和 Provider 的另一个分工：Provider 负责物理 I/O，协调器负责 Harness 自己拥有的持久化语义。

## 五、恢复要闭合中断的 Turn

进程可能在下面任何位置退出：

```text
turn/start
step/start
assistant/message(tool call)
tool/call
── crash ──
```

恢复时不能假装 Tool 成功，也不能保留永远悬空的 Step。Session Repair 会根据已有事件追加合成的错误结果和结束事件：

```text
tool/result(isError = true)
step/end
turn/end(reason = interrupted)
```

相关逻辑在 [packages/core/session/src/repair.ts](../packages/core/session/src/repair.ts#L1)。

修复是“在事实尾部追加明确结果”，不是改写已经提交的旧事件。

## 六、Projection 是可重算读取模型

Projection 注册表在 [SessionProjectionRegistry](../packages/session/session-projection/src/index.ts#L184)。领域插件注册纯 Fold：

```text
初始状态
 + SessionEvent 0
 + SessionEvent 1
 + ...
 = 当前 Projection State
```

典型 Projection 包括：

- Session 列表摘要；
- Token 与使用统计；
- 子 Agent Identity 和 Timing；
- Goal、Plan 等领域状态；
- Web 页面需要的轻量读取状态。

Projection 可以缓存以提高读取速度，但缓存不是事实来源。缓存丢失时，系统应能从 Header 和事件日志重新折叠。

## 七、Client 仍然只是 Projection 的消费者

浏览器中的 [ProjectionValueStore](../packages/client/runtime/src/client/sessions/projection-store.ts#L66) 保存 Host 发送的 Projection Value。

[ConversationNodeAssembler](../packages/client/runtime/src/client/sessions/conversation-assembler.ts#L137) 则把一个事件窗口组织成 Chat 或 Trajectory 可以消费的业务节点。

因此浏览器状态有三种性质：

```text
耐久事实        Session Event
可重算业务状态  Projection / Assembler
纯交互状态      当前 Tab、滚动位置、弹窗开关
```

把耐久事实只放在 React Store 中，刷新页面或换客户端后就无法恢复。

## 八、分页不能改变整体 Projection

聊天列表可以只加载最近一段事件，但 Session 总 Token、标题、子 Agent 数量等整体状态不能随着分页窗口变化。

所以：

- 全局统计来自对完整事件流的 Projection；
- 当前视图节点来自分页事件窗口的 Assembler；
- 两者不能由同一个“当前页面数组”顺手计算。

## 本课核心结论

```text
Header 保存存储身份，Event Log 保存运行事实。
Persistence 是可替换 Provider，协调器保存 Harness 的写入语义。
内存 Append 和磁盘耐久是两个时刻，退出前需要 Flush。
恢复通过追加修复事件闭合协议，不改写旧事实。
Projection 是从日志可重算的读取模型，不是新的事实来源。
Client Store 和 UI Assembler 仍是 Projection 消费者。
```

## 对照练习

`L5-C1`：Claude Code 的 JSONL 读取端会重建 Parent 链，DSH 则要求连续 Event Seq 并通过 Projection Fold 读取状态。这两种方式分别更自然地支持什么能力？为什么 DSH 仍需要 Repair，而不是认为“事件是追加式的就不会损坏”？

## 课后问题

1. `L5-Q1`：为什么 Session Header 不适合全部写成普通 Session Event？它和事件日志分别表达什么？
2. `L5-Q2`：`Session.append()` 已经成功后，为什么进程仍可能需要 `flush()`？这两个成功分别意味着什么？
3. `L5-Q3`：恢复发现 `tool/call` 没有结果时，为什么应该追加合成失败结果，而不是删除原 Tool Call 或自动重放工具？
4. `L5-Q4`：Projection Cache 丢失后应该如何恢复？为什么它不能成为唯一事实来源？
5. `L5-Q5`：为什么 Session 总 Token 统计不能直接从浏览器当前加载的消息窗口计算？

回答格式：

```text
L5-Q1: ...
L5-Q2: ...
L5-Q3: ...
L5-Q4: ...
L5-Q5: ...
```
