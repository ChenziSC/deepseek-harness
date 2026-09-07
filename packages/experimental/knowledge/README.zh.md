# @deepseek-ai/dsh-experimental-knowledge

[English](README.md) | 中文

面向外部知识语料只读检索的实验性 Service Definition。该包拥有与提供方无关的 `ctx.knowledge` API、品牌化文档与分片标识、排序结果和调用方可见错误码，不选择检索算法，不读取索引，也不注册模型工具。

## API

提供方继承默认导出的 `Knowledge` Service，并实现：

```ts
import type { KnowledgeSearchRequest, KnowledgeSearchResult } from '@deepseek-ai/dsh-experimental-knowledge'

interface Knowledge {
  search(request: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResult>
}
```

`request.query` 必须非空，`request.maxResults` 必须是正整数。`request.strategy` 可以请求自动路由或 BM25、Dense、Hybrid 召回、自动或具体的 Dense 索引，以及自动、开启或关闭重排序。提供方应用部署策略，并随排序命中返回实际执行的高层策略。每条命中包含来源文档与分片标识、可选标题、Markdown 章节路径、来源标签、去重后的相邻文本、原始分片正文，以及仅能在本次响应内比较的有限分数。

`KnowledgeError` 提供 `KNOWLEDGE_INVALID_REQUEST`、`KNOWLEDGE_STRATEGY_NOT_ALLOWED`、`KNOWLEDGE_CANCELLED` 和 `KNOWLEDGE_SEARCH_FAILED`。提供方内部的文件与模型细节不会进入公共错误类型。

## 组合方式

不要在 `cordis.yml` 中挂载这个抽象包。应挂载一个提供方，例如 `@deepseek-ai/dsh-experimental-knowledge-local`；Consumer 只依赖 `ctx.knowledge`。

## 模型体验

通过 `dsh-experimental-tool-knowledge` 等消费方间接影响模型；消费方决定是否暴露检索，以及命中结果如何进入模型上下文。

#### KV Cache 影响

本包不会直接导致 KV Cache 失效；请求前缀变更由消费方负责。

## 已知限制与后续工作

- 当前约定在每个 Cordis context 中只支持一个只读知识源。
- 当前没有写入、知识库选择、提供方选择，以及提供方专属调参和诊断 API。
- API 处于实验阶段，不承诺兼容性。
