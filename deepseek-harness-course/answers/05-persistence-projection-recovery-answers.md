# 第 5 课参考答案：持久化、Projection 与恢复

[返回第 5 课](../05-persistence-projection-recovery.md)

## L5-C1

Parent 链天然适合从任意叶子恢复分支，并保留消息拓扑；连续 Event Seq 更适合验证一个 Session 的全序事实流，再让多个 Projection 按相同顺序折叠。DSH 仍需要 Repair，因为追加式只保证旧事实不被改写，不能保证进程退出前每个 `tool/call`、Step 和 Turn 都已得到终态，也不能证明写入尾部完整耐久。Repair 通过追加合成失败和结束事件把未知外部副作用收敛为明确协议状态。

## L5-Q1

> 为什么 Session Header 不适合全部写成普通 Session Event？它和事件日志分别表达什么？

### 参考答案

Header 描述持久对象本身的身份和创建条件，例如 SessionId、格式版本、创建时间、工作目录、父 Session、Seed Boundary 和委派深度；这些信息是加载和解释事件序列的前提，不是对话时间线上发生的一条模型事实。Event Log 则按连续 `seq` 记录 Turn、Step、Message 和 Tool 等运行事实。分开后，加载器可以先验证格式与血缘，再验证和重放事件。

## L5-Q2

> `Session.append()` 已经成功后，为什么进程仍可能需要 `flush()`？这两个成功分别意味着什么？

### 参考答案

`Session.append()` 成功表示事件已经通过 JSON、序号和 Surface 验证，提交到内存日志并同步通知观察者。持久化监听器通常采用 Write-Behind 队列，磁盘或数据库写入可能仍在进行。`flush()` 等待已排队批次到达 Provider 的耐久提交点。若进程在 Append 后立即退出而不 Flush，UI 已看到的最后事件仍可能尚未写盘，因此 Headless 在输出并退出前必须显式等待。

## L5-Q3

> 恢复发现 `tool/call` 没有结果时，为什么应该追加合成失败结果，而不是删除原 Tool Call 或自动重放工具？

### 参考答案

原 Tool Call 已经发生，是不可改写的事实；删除会伪造历史并破坏调用与结果协议。自动重放则可能再次执行写文件、发请求或启动进程等副作用，而且恢复时无法证明上次调用是否已经部分成功。Repair 应在尾部追加 `tool/result(isError=true)`、`step/end` 和中断原因明确的 `turn/end`，把未知结果收敛为可解释终态，由后续用户或模型决定是否重试。

## L5-Q4

> Projection Cache 丢失后应该如何恢复？为什么它不能成为唯一事实来源？

### 参考答案

系统应从 Session Header 和完整事件日志重新执行注册的 Projection Fold，计算当前状态，再按需重建缓存。Projection Cache 是读取优化，可能被删除、过期或因版本变化失效；它通常也只保存派生结果，不能解释每个事实的来源。若把它当唯一来源，缓存损坏就会造成不可恢复的数据丢失，也无法验证结果是否与事件流一致。

## L5-Q5

> 为什么 Session 总 Token 统计不能直接从浏览器当前加载的消息窗口计算？

### 参考答案

浏览器可能只分页加载最近一段事件，当前窗口还会随滚动、过滤或 View 类型变化。用它求和会让“总 Token”随着页面状态改变，并遗漏旧 Step、Compaction 前的 Usage 或未显示节点。总量必须由完整事件流上的 Projection 计算；分页窗口只交给 Conversation Assembler 生成当前可见节点。全局统计与局部视图属于不同读取范围。
