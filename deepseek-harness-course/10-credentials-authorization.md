# 第 10 课：Credential Reference、秘密记录与交互授权

[课程总目录](README.md) · [课程关系图](course-roadmap.md)

这一课解决一个安全设计问题：

> 模型 Provider 需要 API Key，但为什么 Key 不能直接出现在 `cordis.yml`、Session 日志或浏览器 Settings Projection 中？

Harness 把“引用一个秘密”“存储秘密记录”“通过交互取得秘密”拆成三个层次。

## 本课在课程中的位置

- **所属分支：**这是能力扩展分支的安全案例，可以和 L9 独立学习。
- **前置课程：**L0 的配置、L1 的 Provider、L3 的模型请求操作边界以及 L4 的日志事实。
- **本课只新增一个判断：**配置只能保存 Credential Reference；Provider 在操作边界解析真实秘密；Authorization 负责取得或更新秘密，Session 和 UI 只接触安全元数据。
- **第一遍重点：**阅读 CredentialRef、CredentialProvider、请求边界解析和“Session 日志不能记录秘密”；配置代一致性与交互授权流程可第二遍阅读。
- **本课输出：**你已经看过后台委派和秘密管理两个完整能力。L11 会抽象出分析任何 Harness 能力的统一方法。

## 从 Pi / Claude 到 DSH：认证状态被提升为独立能力

“API Key”在产品流程中至少对应四种不同对象。把它们都当成字符串，会让秘密进入配置、日志和浏览器。

| 角色 | 表达什么 | 是否可以进入普通配置或 Projection |
|---|---|---:|
| CredentialRef | 去哪里寻找秘密 | 可以 |
| Credential Value | 真正发送给 Provider 的秘密字节 | 不可以 |
| Credential Record | Provider 管理的秘密及安全元数据 | 只能暴露非秘密元数据 |
| Authorization Flow | 怎样通过用户交互取得或更新记录 | 只暴露流程状态 |

**操作边界**是秘密第一次确实被某次外部请求需要的时刻。DeepSeek Adapter 可以先用 CredentialRef 完成注册；当某次模型 Stream 真正开始时，再解析 Value 并只把它放入 HTTP Header。

一次请求还必须使用同一代配置快照。Endpoint 与 CredentialRef 如果分别在热更新前后读取，Key 可能被发送到错误服务器；所以 Provider 要先冻结两者的组合，再解析本次秘密。

| 参照实现 | 凭据由谁保存和解析 | 登录/授权与请求怎样连接 | DSH 的变化 |
|---|---|---|---|
| [Pi `AuthStorage`](../../pi/packages/coding-agent/src/core/auth-storage.ts) / [RuntimeCredentials](../../pi/packages/coding-agent/src/core/runtime-credentials.ts) | coding-agent 产品层为 Model Provider 管理 Credential Store | CLI 登录与模型调用共享产品服务 | DSH 把引用、记录 Provider 和授权流程定义为独立 Service |
| [Claude Code auth](../../claude-code/src/utils/auth.ts) / [OAuth](../../claude-code/src/services/oauth/index.ts) | 产品 Auth/OAuth 与 Provider 请求层协作 | QueryEngine 外的产品服务管理登录和刷新 | DSH Adapter 配置只保存 CredentialRef，请求边界按次解析 Value |
| DSH | CredentialProvider 保存/解析记录，AuthorizationService 获取记录 | UI 只见安全元数据；Provider 请求获得短暂 Value | Endpoint 与 Ref 固化为同代请求快照，秘密不进入 Session |

DSH 具体多做的是把“哪里存 Key”“怎样取得 Key”“某次请求如何使用 Key”拆成三个生命周期。收益是 Credential Provider 可以替换、授权可以交互、Route 可以热更新且 Session 不接触秘密；代价是错误必须跨 Reference、Record、Flow 和 Operation Boundary 精确分类。

## 一、CredentialRef 不是秘密值

配置中保存的是 Credential Reference，例如：

```text
DEEPSEEK_API_KEY
OPENAI_API_KEY
某个受管 Credential Record Key
```

它表达“运行时应该去哪里解析秘密”，而不是把秘密本身复制到插件配置。

这样配置可以安全地进入：

- Bundle Patch；
- Settings Schema；
- Module Graph；
- 错误诊断；
- 配置目录。

而真实值只在需要发起请求的操作边界短暂出现。

## 二、CredentialProvider 统一解析和存储

Service Definition 在 [CredentialProvider](../packages/credentials/credentials/src/index.ts#L177)。它负责：

- 按 Reference 解析记录；
- 写入或删除受管记录；
- 返回可向 UI 暴露的安全元数据；
- 通知配置或 Credential 变化。

本地实现是 [LocalCredentialProvider](../packages/credentials/credentials-local/src/index.ts#L513)。它可以按明确优先级读取进程环境和 Harness Home 下的 Credential 文件。

Provider 决定物理存储方式；模型 Adapter 只依赖 Credential Service。

## 三、秘密在请求边界按次解析

DeepSeek Adapter 的注册插件保存：

```text
baseURL
CredentialRef
模型默认值
Retry Policy
```

真正开始一次 Stream 时才调用 Credential Provider 解析 Key，参考 [llm-deepseek apply()](../packages/llm/llm-deepseek/src/index.ts#L386) 和 [DeepSeekAdapter.streamWithConnection()](../packages/llm/llm-deepseek/src/adapter.ts#L433)。

每次请求重新解析带来两个结果：

- 用户更新 Key 后不必重启整个插件树；
- 运行中的请求保持自己的不可变快照，下一个请求才看到新值。

## 四、Endpoint 和 Key 必须来自同一配置代

如果 Settings 热更新同时改变 Endpoint 与 CredentialRef，下面的组合是危险的：

```text
旧 Endpoint + 新 Key
新 Endpoint + 旧 Key
```

Key 可能被发送给错误服务器。

所以 DeepSeek Provider 把连接信息和 Credential Reference 解析成一个完整配置快照，再从该快照解析 Key。无效的新配置不会拿其中一半覆盖旧配置。

这是安全领域中的一致性要求，不只是普通配置缓存。

## 五、Authorization 是获取 Credential 的交互流程

[AuthorizationService](../packages/credentials/authorization/src/index.ts#L182) 管理命名授权 Flow。

典型流程是：

```text
Consumer 请求某种授权
→ Authorization Flow 通过 Interaction Service 展示说明
→ 用户同意后进行登录或令牌交换
→ Flow 把 Credential Record 写入 Provider
→ 返回 Credential Key
```

Authorization Service 不等于 Credential Store：前者拥有“怎样取得秘密”的交互生命周期，后者拥有“怎样保存和解析记录”。

## 六、UI 只能读取安全元数据

浏览器 Models 或 Settings 页面可能需要显示：

```text
某个 Provider 已配置
记录来源是 managed store
最后更新时间
可执行重新授权或删除
```

但不能把秘密值发给浏览器用于回显。否则任何前端脚本、日志或 DevTools 都可能泄漏 Key。

UI 写入 Credential 时也应调用专门 Host API，让明文只经过受控请求并立即进入 Provider，而不是进入通用 Settings Projection。

## 七、Session 日志不能记录秘密

Session 会持久化、Fork、导出、回放、遥测和投影。秘密一旦进入：

- `request/header`；
- `user/message`；
- Tool Result；
- 普通错误文本；

就会扩散到多个长期保存位置。

所以 Request Header 记录 Provider、Model 和非秘密配置，但不记录 Authorization Header 或 API Key。

错误应说明缺少哪个 Reference 以及如何配置，而不是回显当前值。

## 八、缺少 Credential 为什么通常在操作边界失败

一个 Adapter 插件可以在没有 Key 时正常注册 Route，因为：

- 用户可能稍后在 Web Settings 中添加；
- 该 Route 可能从未被调用；
- Credential Provider 可以热更新。

但第一次真正请求该 Route 时，缺少 Key 必须明确失败为 `MISSING_CREDENTIAL`，不能静默换用另一个 Provider 或匿名请求。

这符合“在最早可解析点失败”：插件加载时尚不能确定操作是否需要 Key；请求开始时已经可以确定。

## 九、完整请求流程

```text
cordis.yml / settings
  保存 CredentialRef
        │
        ▼
Adapter prepareCall
  冻结 Endpoint、Route、Ref、Defaults
        │
        ▼
streamWithConnection
  CredentialProvider.resolve(ref)
        │
        ▼
Key 仅进入 Provider HTTP Header
        │
        ├─ 不进入 Session
        ├─ 不进入普通 Projection
        └─ 不进入模型 Prompt
```

## 本课核心结论

```text
CredentialRef 是可公开配置的秘密引用，不是秘密本身。
CredentialProvider 拥有记录存储和解析。
Authorization Service 拥有获取秘密的交互流程。
秘密按请求解析，运行中请求使用不可变配置快照。
Endpoint 和 CredentialRef 必须来自同一配置代。
UI 只能读取安全元数据，Session 和错误文本不能记录秘密。
缺少 Key 在真正操作 Route 的最早可解析点明确失败。
```

## 对照练习

`L10-C1`：Pi AuthStorage、Claude OAuth/Auth 与 DSH CredentialProvider 都能提供 API Key。DSH 为什么仍要求 Adapter 长期持有 Ref 而不是 Value？请从热更新、错误 Endpoint、Session 泄漏和浏览器 Projection 四个方面说明。

## 课后问题

1. `L10-Q1`：CredentialRef 和 Credential Value 为什么必须是不同类型和不同数据流？
2. `L10-Q2`：为什么 Adapter 在插件加载时没有 API Key 仍可以注册，但第一次请求不能静默跳过？
3. `L10-Q3`：Settings 同时更新 Endpoint 和 CredentialRef 时，为什么必须把二者解析成同一配置快照？
4. `L10-Q4`：Authorization Service 和 CredentialProvider 分别拥有哪一段生命周期？把它们合并会造成什么耦合？
5. `L10-Q5`：为什么浏览器可以看到“已配置”，却不应该通过普通 Settings API 读回 Key？

回答格式：

```text
L10-Q1: ...
L10-Q2: ...
L10-Q3: ...
L10-Q4: ...
L10-Q5: ...
```
