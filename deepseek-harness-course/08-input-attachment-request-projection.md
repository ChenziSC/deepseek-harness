# 第 8 课：输入、附件与模型请求投影

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课用图片输入解释一个完整的跨层设计：

> 用户选择的一张图片，不会从浏览器原样穿透到模型 Provider。

它依次经过临时 UI 状态、Host 原子接纳、Provider 无关的耐久规范化、Route 专属请求版本、Provider Wire 表示和多个 UI 视图。

## 本课在课程中的位置

- **所属分支：**这是 Web 产品表面分支的综合案例，不是理解基础 Agent Loop 的前提。
- **前置课程：**L3 的 Step 请求、L4 的模型可见事实、L5 的 Projection、L6–L7 的 Host 与浏览器模块。
- **本课只新增一个判断：**同一份用户输入跨越 UI、Host、Session、Route 和 Provider 时会有不同表示；每一层只拥有自己需要的状态。
- **第一遍重点：**沿 `Draft → Host Admission → Durable Attachment → Route Request → Provider Wire` 阅读；容量裁剪和多种 UI View 可第二遍补充。
- **本课输出：**产品表面分支结束。你应能解释临时 UI 状态为什么不能直接成为模型或 Session 的事实。

## 从 Pi / Claude 到 DSH：Attachment 被拆成多阶段身份

L2 已经区分耐久事实和活跃状态，L6–L7 又加入浏览器与 Host。图片跨过这些层时，每层解决的问题不同，因此不能把一个可变的 `Image` 对象从 UI 一直传到 Provider。

| 阶段 | 这一层关心什么 | 生命周期 |
|---|---|---|
| Draft | 用户是否还在编辑、取消或重试 | 浏览器临时状态 |
| Admission | 输入是否合法，整批能否接纳 | 一次 Host 提交事务 |
| Attachment | 可长期引用的规范化内容 | 耐久、Provider 无关 |
| Request Variant | 当前模型 Route 的尺寸和容量限制 | 可重算请求版本 |
| Wire Representation | Provider 本次接受 `file_id` 还是 Base64 | 单次网络请求 |

**原子接纳**表示一批输入要么全部验证并取得耐久引用，要么一项都不进入 Session。它不要求数据库一定使用某种事务 API，而是要求外部可见结果不能出现“消息已记录，但第 3 张附件不存在”的半成功状态。

本课会沿这五种表示追踪同一张图片，并判断每次转换由谁拥有、失败时允许改变哪一层状态。

| 参照实现 | 图片进入模型前的主要处理 | 耐久身份与请求身份 | DSH 的变化 |
|---|---|---|---|
| [Pi coding-agent image utilities](../../pi/packages/coding-agent/src/utils/image-process.ts) | 读取、转换、缩放后形成模型内容 | 产品处理结果进入消息流程 | DSH 在 Host 接纳时先生成 Provider 无关 AttachmentId |
| [Claude Code](../../claude-code/src/utils/imageStore.ts) | Attachment/Image Store、消息规范化与 Provider 限制共同处理 | Transcript/Attachment 与 API Content 分层 | DSH 再显式区分耐久 Attachment、Route Variant 和 Wire Representation |
| DSH | Draft → 原子 Admission → Normalization → Route Variant → Capacity Trim → Wire | 每层有独立 ID、缓存规则和失败范围 | Provider Fallback 不改写 Session 事实 |

DSH 具体多做的是把图片处理从“构造模型消息的辅助函数”提升为跨 UI、Host、存储和 Provider 的数据生命周期。收益是附件可跨 Route 复用、批次不会半接纳、Provider 临时失败不污染历史；代价是同一图片拥有 DraftId、AttachmentId、VariantId 等多个身份，并需要独立缓存与清理规则。

## 一、浏览器 Draft 不是 Session 事实

输入状态机在 [InputMachine](../packages/client/ui-conversation/src/client/input/machine.ts#L108)。它管理：

- 文本 Draft；
- 本地图片 DraftId；
- Submit、Steer、Queue 等提交模式；
- 上传中、被接纳、失败、取消；
- 重复提交和 Session 切换。

这些状态服务于交互事务。用户尚未提交时，它们不应该进入 Session 日志。

## 二、Host 必须原子接纳整批图片

提交到 Host 后，[admitEncodedImages()](../packages/attachment/attachment/src/admission.ts#L36) 先验证整批 Wire 输入：

```text
Canonical Base64
→ Media Type
→ 图片结构和尺寸
→ 每个成员的接纳策略
→ 全部成功后返回引用
```

只有整批图片全部接纳成功，Host 才把包含附件引用的用户消息交给 Agent，入口在 [api-proxy.ts](../packages/host/apiproxy/src/api-proxy.ts#L133)。

如果先记录 Message，再发现第 3 张图无效，Session 就会引用不存在的附件。因此消息接纳和附件接纳必须形成一个逻辑事务。

## 三、耐久附件是 Provider 无关的规范化对象

Attachment Service Definition 在 [AttachmentStore](../packages/attachment/attachment/src/index.ts#L37)。本地 Provider 会把输入规范化为：

- 支持的稳定编码；
- 8-bit sRGB/sRGBA；
- 统一 Orientation；
- 有界尺寸和编码字节；
- 基于内容 Hash 的不可变 AttachmentId。

规范化入口在 [normalization.ts](../packages/attachment/attachment-local/src/normalization.ts#L165)。

Session Message 只保存可序列化的内容寻址引用，不把大块图片 Base64 重复塞入每个事件。

这里刻意不采用 DeepSeek 的具体像素限制，因为耐久附件应能被未来不同 Provider 复用。

## 四、模型 Route 生成独立请求版本

某个模型 Route 可能只接受更小的像素或编码字节。因此在请求阶段，[readImageRequest()](../packages/attachment/attachment-local/src/index.ts#L213) 根据 Route Policy 生成 Request Image Version。

```text
耐久 Attachment
 + maxPixels
 + maxBytes
 + 编码和缩放策略
 = variantId
```

同一 Attachment 在不同 Route 下可以产生不同 Variant。VariantId 覆盖所有转换策略，所以缓存命中意味着“字节和政策身份都相同”，而不是只看源图片 ID。

## 五、请求容量由 LLM 层统一裁剪

模型可能限制：

- 请求内图片总数；
- 原始文件字节；
- Base64 展开后的总字节。

[packages/llm/llm/src/content.ts](../packages/llm/llm/src/content.ts#L149) 从最旧图片开始，把超额图片替换成确定性英文占位文本。

这样仍保留对话语义：模型知道这里曾有一张被容量策略移除的图片，而不是让 Message 结构静默消失。

## 六、Provider 再选择 Wire 表示

DeepSeek Adapter 先尝试把每个 Request Variant 解析成 Files API `file_id`，见 [DeepSeekAdapter](../packages/llm/llm-deepseek/src/adapter.ts#L511)。

```text
Request Variant
→ 本地 Upload Index 查可复用 file_id
→ 必要时上传 Files API
→ Wire Message 使用 file_id
```

如果任意图片的 Files API 解析失败，Adapter 不会混用：

```text
图片 A = file_id
图片 B = base64
图片 C = file_id
```

而是把整份请求切换为 Base64 表示，并按更严格的 Base64 总字节上限重新裁剪和序列化。

原因是一次请求应具有一致且可解释的表示策略；部分 Fallback 会让容量、错误恢复和缓存身份都难以判断。

## 七、Provider 失败不能污染耐久事实

Files API 暂时失败或 Provider 拒绝某个 Wire 表示时：

- Session 中的用户消息不变；
- 耐久 Attachment 不变；
- Route Variant 可继续缓存；
- 只有本次 Request 的表示和裁剪结果改变。

这正是分层的价值。Provider 的暂时限制不会倒逼 Session 历史改写成 Provider 专属格式。

## 八、同一事件窗口可以投影成多个 View

Chat View 和 Trajectory View 消费同一 Session Event Window，但拥有不同：

- Node Definition；
- Assembler State；
- Layout；
- Renderer；
- 用户交互状态。

图片上传、请求 Variant 和 Provider Wire 表示属于不同阶段，UI 不应该把它们压成一个“Image Object”到处传递。

## 九、完整流程

```text
Browser File
→ DraftImageId（临时 UI）
→ Host Wire Admission（整批原子接纳）
→ Normalized AttachmentId（耐久、Provider 无关）
→ Session user/message（只存引用）
→ Route Request VariantId（模型限制）
→ Request Capacity Trim
→ file_id 或全量 base64（Provider 表示）
→ LLM Request
```

## 本课核心结论

```text
Draft 是临时交互状态，不是 Session 事实。
附件批次必须先完整接纳，再记录用户消息。
耐久附件采用 Provider 无关的规范化格式和内容寻址身份。
Route 为具体模型生成独立 Request Variant。
LLM 层处理跨消息的请求容量。
Provider 选择 Wire 表示；Fallback 只改变本次请求，不改写历史。
Chat 和 Trajectory 是同一事件流的不同投影。
```

## 对照练习

`L8-C1`：如果沿用 Pi/Claude 中“在构造模型 Message 时处理图片”的直觉，迁移到 DSH Web 后会在哪些失败点产生半状态？请至少覆盖浏览器重试、Session 持久化和 Provider Fallback。

## 课后问题

1. `L8-Q1`：为什么不能在用户点击发送后先追加 Session Message，再逐张处理图片？
2. `L8-Q2`：耐久 Attachment 为什么不能直接按 DeepSeek 当前模型的最大像素保存？
3. `L8-Q3`：同一源 Attachment 为什么还需要 Request VariantId？VariantId 应覆盖哪些信息？
4. `L8-Q4`：Files API 中一张图解析失败后，为什么 Adapter 选择整份请求回退到 Base64，而不是只回退这一张？
5. `L8-Q5`：Provider 请求失败后，哪些状态可以改变，哪些耐久事实必须保持不变？

回答格式：

```text
L8-Q1: ...
L8-Q2: ...
L8-Q3: ...
L8-Q4: ...
L8-Q5: ...
```
