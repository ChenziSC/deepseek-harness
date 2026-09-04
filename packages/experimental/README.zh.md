# experimental/：私有实验性包

[English](README.md) | 中文

本组包含使用仓库真实运行时、但不进入正式发布的原型与内部专用 Cordis 插件。组内包均为私有包，不承诺稳定性或支持，但仍须满足与发布包相同的工程、安全、文档、生命周期、测试和快照要求。

| 包 | 职责 | ctx key |
|---|---|---|
| `agent-team/` | 隐式 root Agent Teams roster、持久 peer mailbox、共享任务 DAG 与运行时协调 | `ctx.agentTeams` |
| `knowledge/` | 与提供方无关的只读外部知识检索 Service Definition | `ctx.knowledge` |
| `knowledge-local/` | 不可变本地 BM25 与 Dense 知识提供方及离线索引命令 | `ctx.knowledge` |
| `tool-agent-team/` | 按 Agent 作用域提供的 Agent Teams 模型工具与协作指引 | — |
| `tool-knowledge/` | 有输入输出上限的模型工具 `knowledge_search` Consumer | — |

[子树规则](AGENTS.md)规定依赖隔离、发布排除与 promotion。
