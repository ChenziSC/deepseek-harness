# 第 8 课参考答案：输入、附件与模型请求投影

[返回第 8 课](../08-input-attachment-request-projection.md)

## L8-C1

若只在构造模型 Message 时处理图片，浏览器上传失败可能已让 UI 认为提交成功；某张图片验证失败时，Session 可能已经记录引用不存在对象的消息；Provider Files API 失败又可能迫使代码修改已持久化 Message 或混合表示重试。DSH 在 Host Admission 前不发布 Session 事实，成功后只保存 Provider 无关 AttachmentId，请求阶段再生成 Route Variant 和 Wire 表示。因此 UI 可重试 Draft，Session 保持稳定，Provider Fallback 只影响单次请求。

## L8-Q1

> 为什么不能在用户点击发送后先追加 Session Message，再逐张处理图片？

### 参考答案

Session Message 一旦追加就是耐久事实。如果先写消息，再发现某张图片 Base64、媒体类型、结构或尺寸无效，日志会永久引用一个未被 Attachment Store 接纳的对象，Resume 和其他客户端无法重建该消息。Host 必须先验证并接纳整批图片，只有所有成员成功并取得稳定 AttachmentId 后，才能原子地把引用交给 Agent；任一失败都不产生用户消息事实。

## L8-Q2

> 耐久 Attachment 为什么不能直接按 DeepSeek 当前模型的最大像素保存？

### 参考答案

耐久 Attachment 属于 Session 的 Provider 无关事实，可能在未来被不同模型、Fork、导出或 UI 使用。若按当前 DeepSeek Route 的上限永久缩小，原始可复用信息会不可逆丢失，换 Provider 时也只能使用旧限制。Attachment Store 应按稳定的通用规范保存内容寻址对象；具体 Route 的像素、字节和编码限制在请求阶段生成独立 Variant，而不是反向定义耐久格式。

## L8-Q3

> 同一源 Attachment 为什么还需要 Request VariantId？VariantId 应覆盖哪些信息？

### 参考答案

同一 Attachment 面向不同 Route 时可能采用不同最大像素、最大字节、编码格式、缩放方式或转换算法，实际发送字节并不相同。VariantId 用来标识“源内容 + 完整转换策略”的结果，至少应覆盖 AttachmentId、像素与字节限制、编码和缩放政策及影响输出的转换版本。这样缓存命中才能证明结果字节与策略身份一致，而不是只证明来自同一原图。

## L8-Q4

> Files API 中一张图解析失败后，为什么 Adapter 选择整份请求回退到 Base64，而不是只回退这一张？

### 参考答案

一份请求需要一致、可解释的图片表示策略。混合 `file_id` 与 Base64 会让总字节限制、裁剪顺序、重试条件、缓存身份和错误归因同时依赖每张图的临时状态。整份回退后，Adapter 可以按统一的 Base64 上限重新裁剪和序列化，保证同一输入得到确定请求。这个回退只改变本次 Wire 表示，不改写 Session 或耐久 Attachment。

## L8-Q5

> Provider 请求失败后，哪些状态可以改变，哪些耐久事实必须保持不变？

### 参考答案

可以改变的是本次请求的 Wire 表示、容量裁剪结果、Files API 上传/复用状态、重试选择以及临时错误信息；Route Variant 也可以作为派生缓存保留或重新生成。必须保持不变的是已经接纳的用户消息、AttachmentId、规范化附件字节和既有 Session 事件。Provider 的暂时失败不能把历史图片改成 Provider 专属格式，也不能删除用户已经提交的事实；失败应以新的运行结果记录。
