# System Prompt Assembly

English | [中文](system-prompt.zh.md)

The [system-prompt package](../../packages/core/system-prompt) owns the data exchanged between prompt contributors and one assembly call. The package [README](../../packages/core/system-prompt/README.md) documents registration, ordering, scoping, and rendering behavior; this page records the exact cross-package types that plugins implement or pass.

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts).

## Assembly context

`AssembleContext` identifies the scope layer one assembly resolves and may carry the explicit control signal for that request. It is merge-extensible: `dsh-agent` adds the optional live `agent` field, and `assembleContextFor(agent, signal)` sets the explicit fields together. A bare assembly has neither scope nor signal.

```ts type-equiv
/** 一次 Prompt 组装使用的可声明合并扩展 Context。 */
interface AssembleContext {
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  scope?: ScopeKey
  /** Explicit control signal for the turn that requested this assembly, when any. */
  signal?: AbortSignal
}
```

## Tool-provider result

`ToolProviderResult.schemas` is the model-visible set for the current assembly. `knownNames` is the provider's pre-restriction name universe used to distinguish a configured-name typo from a known tool that is deliberately hidden in this scope.

```ts type-equiv
/** 一次组装中可见的 Tool Schema，以及应用限制前的名称集合。 */
interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}
```

## Prompt sections

`PromptSection` is a readonly same-process registration contract. Its text may be static or resolved from the current assembly context. One effective `complete` section becomes the sole prompt section after cooperative assembly.

```ts type-equiv
/** 一项贡献给 System Prompt 的注册表输入。 */
interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  readonly name: string
  /**
   * Sections are concatenated in ascending order. Convention: `-100` is the
   * harness identity, `0` the deployment persona, tool guidance uses 100–199;
   * other negative orders also render before the persona.
   */
  readonly order: number
  /**
   * Static text or a provider evaluated at each assembly with that assembly's
   * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
   * interpolated later, by {@link renderPrompt}.
   */
  readonly text: string | ((context: AssembleContext) => string)
  /**
   * Treat this contribution as the complete system prompt. Assembly still
   * runs the cooperative waterfall so tools, contexts, and variables can be
   * resolved, then restores this exact section as the sole prompt section.
   * More than one effective complete section makes assembly fail.
   */
  readonly complete?: boolean
}
```

## Dynamic prompt context

`PromptContext` is the cache-safe counterpart to `PromptSection`. The assembly resolves and orders these contributions, while agent-loop logs their complete current snapshot after retained model history only when it changed or compaction removed it.

```ts type-equiv
/** 会物化为持久 User Role 快照的动态模型上下文。 */
interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  readonly name: string
  /** Contexts are joined in ascending order. */
  readonly order: number
  /** Static text or a provider evaluated for each assembly. Empty text contributes nothing. */
  readonly text: string | ((context: AssembleContext) => string)
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsystemprompt--systemprompt"></a>

### `ctx.systemPrompt` — `SystemPrompt`

在每个模型 Step 前组装 Prompt 输入的注册表 Service。

```ts cordis-catalog
/**
 * 在调用方 Context 的 Scope 中注册有序 Prompt Section。Scope Section 会覆盖同名全局项；
 * 同一层重复名称或非有限 Order 会抛错。注册和释放都会发出 `system-prompt/change`。
 * @param section - 要注册的 Section。
 * @returns Cordis Effect 返回的原始 disposer。
 */
section(section: PromptSection): () => void

/**
 * 在调用方 Context 的 Scope 中注册有序动态 Context。Scope 条目覆盖同名全局条目。
 * @param context - 要注册的 Context 贡献。
 * @returns Cordis Effect 返回的原始 disposer。
 */
context(context: PromptContext): () => void

/**
 * 抑制调用方 Scope 中的全部动态运行时 Context，但不改变拥有或强制这些事实的 Service。
 * 多个抑制器可以相互独立地释放。
 * @returns Cordis Effect 返回的原始 disposer。
 */
suppressRuntimeContext(): () => void

/**
 * 在调用方 Scope 中注册 Tool Schema Provider。全局和匹配 Scope 的 Provider 都会贡献；
 * 返回保留名称 {@link TOOL_ORDER_REST} 会导致组装失败。
 * @param provider - 每次组装时使用该次 Context 求值的 Provider。
 * @returns Cordis Effect 返回的原始 disposer。
 */
tools(provider: (context: AssembleContext) => ToolProviderResult): () => void

/**
 * 在调用方 Scope 中注册 Prompt 变量。Scope 值覆盖全局值；无效或重复名称会抛错。Provider
 * 可以返回 `undefined`，但之后渲染引用该值的 Section 会失败。
 * @param name - 符合 `[a-z][a-z0-9_]*` 的引用名称。
 * @param provider - 每次组装时求值的 Provider。
 * @returns Cordis Effect 返回的原始 disposer。
 */
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void

/**
 * 组装全局与 Scope Provider，复制 Tool 参数并应用规范顺序，再执行组装 Waterfall。Scope
 * Section 和变量覆盖全局值。Waterfall 返回值具有最终权威，但若存在有效 Complete
 * Section，之后会恢复它并作为唯一 Prompt Section。
 * @param context - 可选 Scope 以及插件定义的组装字段。
 * @returns Waterfall 处理后、并已强制应用 Complete Prompt 的组装结果。
 */
async assemble(context: AssembleContext = {}): Promise<PromptAssembly>
```

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts)

<a id="system-prompt-events"></a>

### `system-prompt/*` events

<a id="system-promptassemble--waterfall"></a>

#### `system-prompt/assemble` — waterfall

对已组装的 Section、Context、Tool 和变量执行专家 Waterfall。Scope-filtered dispatch 按 Scope 过滤， Scope 监听器只接收该 Scope 的组装请求；返回值具有最终权威。传入的 signal 只控制 当前组装请求，不能保留用于控制后续 Turn。已注册的 Complete Section 会在 Waterfall 后恢复，因此监听器不能追加或替换该 Scope 的 System Prompt。

```ts cordis-catalog
/**
 * 对已组装的 Section、Context、Tool 和变量执行专家 Waterfall。Scope-filtered dispatch 按 Scope 过滤，
 * Scope 监听器只接收该 Scope 的组装请求；返回值具有最终权威。传入的 signal 只控制
 * 当前组装请求，不能保留用于控制后续 Turn。已注册的 Complete Section 会在 Waterfall
 * 后恢复，因此监听器不能追加或替换该 Scope 的 System Prompt。
 * @param assembly - 根据已注册 Provider 构造的可变组装结果。
 * @param context - 调用方为当前组装提供的 Context。
 * @mode waterfall
 */
'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
```

Types: [Scoped](scope.md)

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts)

<a id="system-promptchange--emit"></a>

#### `system-prompt/change` — emit

任一 Prompt Provider 变化时发出。全局变化会影响所有 Scope，因此该注册表通知不做过滤。

```ts cordis-catalog
/**
 * 任一 Prompt Provider 变化时发出。全局变化会影响所有 Scope，因此该注册表通知不做过滤。
 * @mode emit
 */
'system-prompt/change'(): void
```

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts)
<!-- END GENERATED cordis-surface -->
