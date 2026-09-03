# 第 10 课参考答案：Credential Reference 与交互授权

[返回第 10 课](../10-credentials-authorization.md)

## L10-C1

Adapter 长期持有 Ref，可以让 CredentialProvider 在每次请求边界解析最新 Value，Key 更新无需重启插件。Endpoint 与 Ref 会先冻结为同一配置快照，避免旧 Endpoint 搭配新 Key。Ref 可以安全记录在设置和诊断中，而 Value 不进入 Session、普通错误或浏览器 Projection；UI 只读取“已配置”等元数据。若 Adapter 长期持有 Value，这四条隔离都会退化为依赖调用者谨慎处理字符串。

## L10-Q1

> CredentialRef 和 Credential Value 为什么必须是不同类型和不同数据流？

### 参考答案

CredentialRef 是可以进入配置、Schema 和诊断的稳定引用，只说明运行时去哪里解析秘密；Credential Value 是敏感明文，只应在受控操作边界短暂存在。分开后，Bundle、Settings、Session 和 UI 可以安全携带 Ref，而 Value 只从 CredentialProvider 流向实际 HTTP Header。若混为一个字符串，通用配置投影、日志、错误或前端回显都可能无意复制 Key，也无法用类型阻止错误数据流。

## L10-Q2

> 为什么 Adapter 在插件加载时没有 API Key 仍可以注册，但第一次请求不能静默跳过？

### 参考答案

加载时只能确定 Route 可以被提供，不能确定它一定会被调用；用户可能稍后通过 Settings 或 Authorization 添加 Key，CredentialProvider 也支持热更新。因此缺 Key 不是插件自身无法装载的静态错误。第一次实际请求时，所选 Route 已明确需要该凭据，此时必须以 `MISSING_CREDENTIAL` 等明确错误失败，不能匿名请求或偷偷换 Provider，否则模型选择、审计和安全语义都会被改变。

## L10-Q3

> Settings 同时更新 Endpoint 和 CredentialRef 时，为什么必须把二者解析成同一配置快照？

### 参考答案

Endpoint 决定秘密发送到哪里，CredentialRef 决定发送哪个秘密，两者必须来自同一已验证配置代。若分别热读，竞争窗口可能产生“旧 Endpoint + 新 Key”或“新 Endpoint + 旧 Key”，把凭据发送给错误服务器。Adapter 应先冻结 Endpoint、Route、Ref 和默认值的不可变快照，再从该快照解析 Key；无效新配置不能只覆盖其中一半。

## L10-Q4

> Authorization Service 和 CredentialProvider 分别拥有哪一段生命周期？把它们合并会造成什么耦合？

### 参考答案

Authorization Service 拥有“怎样取得秘密”的交互流程，包括提示用户、登录或令牌交换、取消和完成；CredentialProvider 拥有“怎样存储、解析、删除和报告安全元数据”的记录生命周期。Flow 完成后把记录写入 Provider，并返回 Credential Key。合并后，每种存储后端都要理解 OAuth/交互，每种授权方式也会绑定某种物理存储，难以替换、测试或让多个流程共享同一秘密库。

## L10-Q5

> 为什么浏览器可以看到“已配置”，却不应该通过普通 Settings API 读回 Key？

### 参考答案

“已配置”、记录来源和更新时间是安全元数据，足以支持状态展示、重新授权或删除。Key 明文一旦经普通 Settings Projection 返回浏览器，就会暴露给前端脚本、DevTools、网络日志和通用状态缓存，扩大泄漏范围。浏览器写入秘密也应走专门 Host API 并立即交给 CredentialProvider；普通 Settings 只保存 CredentialRef，不能提供秘密回显功能。
