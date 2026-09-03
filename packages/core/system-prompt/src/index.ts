/**
 * 有序 system 段、动态上下文、Tool schema 与 Prompt 变量的注册表。
 *
 * @module @deepseek-ai/dsh-system-prompt
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer, Scoped } from '@deepseek-ai/dsh-scope'
import type { ContextSnapshotSection, ToolSchema } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: SystemPrompt
  }

  interface Events {
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
    /**
     * 任一 Prompt Provider 变化时发出。全局变化会影响所有 Scope，因此该注册表通知不做过滤。
     * @mode emit
     */
    'system-prompt/change'(): void
  }
}

/** 一次 Prompt 组装使用的可声明合并扩展 Context。 */
export interface AssembleContext {
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  scope?: ScopeKey
  /** Explicit control signal for the turn that requested this assembly, when any. */
  signal?: AbortSignal
}

/** 一项贡献给 System Prompt 的注册表输入。 */
export interface PromptSection {
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

/** 会物化为持久 User Role 快照的动态模型上下文。 */
export interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  readonly name: string
  /** Contexts are joined in ascending order. */
  readonly order: number
  /** Static text or a provider evaluated for each assembly. Empty text contributes nothing. */
  readonly text: string | ((context: AssembleContext) => string)
}

/** 组装结果中的一个 Section：已经解析 text 的 {@link PromptSection}。 */
export interface AssembledSection {
  /** The contributing section's unique name. */
  name: string
  /** The resolved (but not yet interpolated) section text. */
  text: string
}

/** 一项已解析的动态 Context 贡献。 */
export interface AssembledContext {
  /** The contributing context's unique name. */
  name: string
  /** The resolved text before variable interpolation. */
  text: string
}

/** 一次组装中可见的 Tool Schema，以及应用限制前的名称集合。 */
export interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}

/**
 * 可通过声明合并扩展的模型输入。Section 和 Context 在渲染前保持未插值状态，Tool 已按
 * 规范顺序排列。
 */
export interface PromptAssembly {
  sections: AssembledSection[]
  contexts: AssembledContext[]
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
}

/**
 * 部署 persona 的段名与顺序。组合可以替换这个槽位：Agent preset 用自己的 persona 遮蔽
 * 部署 persona。两侧使用同一个段名才能实现替换而不是产生重复，因此这里导出该名称。
 */
export const PERSONA_SECTION = 'deployment:persona'

/** persona 槽位的 Prompt 顺序；这是模型读取的第一个部署段。 */
export const PERSONA_ORDER = 0

/** 合法变量名，即花括号之间允许的写法。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** 扫描位置处完整的 `{{...}}` 引用组，内容稍后校验。 */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** {@link Config.toolOrder} 为未列出 Tool 保留的标记。 */
export const TOOL_ORDER_REST = '<unlisted-tools>'

/**
 * 校验重复名称和必需的 {@link TOOL_ORDER_REST} 标记。插件尚未加载，因此已注册名称稍后校验。
 */
function validateToolOrder(toolOrder: string[] | undefined): string[] | undefined {
  if (toolOrder === undefined) return undefined
  const seen = new Set<string>()
  for (const name of toolOrder) {
    if (seen.has(name)) throw new Error(`toolOrder lists "${name}" more than once`)
    seen.add(name)
  }
  if (!seen.has(TOOL_ORDER_REST)) {
    throw new Error(`toolOrder must contain the "${TOOL_ORDER_REST}" rest entry (where unlisted tools are inserted)`)
  }
  return toolOrder
}

/**
 * 应用配置的 Tool 顺序，并在 {@link TOOL_ORDER_REST} 处按字典序插入未列出的 Tool。
 * 配置中的未知名称会失败；已知但受限制的名称可以缺省。
 */
function orderTools(tools: ToolSchema[], toolOrder: string[] | undefined, knownNames: ReadonlySet<string>): ToolSchema[] {
  const reserved = tools.find(tool => tool.name === TOOL_ORDER_REST)
  if (reserved !== undefined) {
    throw new Error(`tool provider returned reserved tool name "${TOOL_ORDER_REST}" (reserved for toolOrder's rest entry)`)
  }
  if (toolOrder === undefined) return tools.sort(compareToolNames)
  const unknown = toolOrder.filter(name => name !== TOOL_ORDER_REST && !knownNames.has(name))
  if (unknown.length > 0) {
    throw new Error(`toolOrder lists unregistered tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}; known tools: ${[...knownNames].sort().join(', ') || '(none)'}`)
  }
  const listed = new Set(toolOrder)
  const rest = tools.filter(tool => !listed.has(tool.name)).sort(compareToolNames)
  return toolOrder.flatMap(name =>
    name === TOOL_ORDER_REST ? rest : tools.filter(tool => tool.name === name))
}

/** 按 code unit 比较名称，与 locale 无关，因此所有机器上的顺序一致。 */
function compareToolNames(a: ToolSchema, b: ToolSchema): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** 插件配置：由部署方编写的 System Prompt 片段，具体约定见 {@link Config.persona}。 */
export interface Config {
  /** Include the fixed DeepSeek Harness identity before the deployment persona (default true). */
  includeHarnessIdentity?: boolean
  /** Include dynamic runtime-context snapshots in model history (default true). */
  includeRuntimeContext?: boolean
  /**
   * Deployment-wide order-0 persona template. A scoped section named
   * `deployment:persona` shadows it; `{{variable}}` references are strict.
   */
  persona?: string
  /**
   * Model-facing tool names in order, with {@link TOOL_ORDER_REST} exactly once.
   * Invalid fields fail at load and unknown names fail at assembly; known names
   * hidden in one scope may be absent there. Omitted means lexicographic order.
   */
  toolOrder?: string[]
}

/**
 * 插值严格的 `{{variable}}` 引用，删除空段，并用空行连接其余段。格式错误、未知或值为
 * undefined 的引用会抛错；后面没有 `}}` 的孤立 `{{` 按普通文本处理；替换后的值不再扫描。
 * @param assembly - 要渲染其段和变量的 assembly。
 * @returns 渲染后的 Prompt；全部段为空时返回 `''`。
 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => interpolate(section, assembly.variables, 'section'))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/**
 * 渲染完整动态上下文快照。
 * @param assembly - 要渲染其上下文和变量的 assembly。
 * @returns 当前完整快照；没有活动上下文时返回 `''`。
 */
export function renderContextSnapshot(assembly: PromptAssembly): string {
  return joinContextSections(renderContextSections(assembly))
}

/**
 * 已渲染段列表对应的模型可见快照文本。
 *
 * 同时需要各段的调用方只渲染一次，再在这里连接，避免一次请求对每个上下文插值两遍。
 * @param sections - {@link renderContextSections} 返回的段。
 * @returns 当前完整快照；没有活动上下文时返回 `''`。
 */
export function joinContextSections(sections: readonly ContextSnapshotSection[]): string {
  const body = sections.map(section => section.text).join('\n\n')
  if (body.length === 0) return ''
  // 下方英文会作为动态 user-role 快照前言发送给模型。中文译文：“当前运行时上下文。
  // 此快照取代之前的运行时上下文快照。”运行时原文保持不变，以维持已记录的模型行为。
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

/**
 * 同一份快照，但保留组装它的具名贡献。
 *
 * {@link renderContextSnapshot} 将这些贡献连接后交给模型；展示快照的消费者使用这些名称
 * 把各部分归因到贡献它的子系统，无需重新拆分已连接文本。
 * @param assembly - 要渲染其上下文和变量的 assembly。
 * @returns 每个渲染为非空文本的贡献上下文对应一个条目。
 */
export function renderContextSections(assembly: PromptAssembly): ContextSnapshotSection[] {
  return assembly.contexts
    .map(context => ({ name: context.name, text: interpolate(context, assembly.variables, 'context') }))
    .filter(section => section.text.length > 0)
}

/** 插值一个段或上下文，并把诊断归因到拥有它的输入。 */
function interpolate(
  input: AssembledSection | AssembledContext,
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      // 后面存在闭合花括号时属于格式错误；否则按普通文本处理。
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}" (references are complete simple {{name}} groups)`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    // `{{}}` 产生空名称，按引用格式错误处理。
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}" (variable names match ${String(VARIABLE_NAME)})`)
    }
    // 不通过 Object.prototype 解析未注册名称。
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`)
    }
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

/** 存储在一个 Prompt layer 中的 Tool schema Provider。 */
type ToolProvider = (context: AssembleContext) => ToolProviderResult

/** 存储在一个 Prompt layer 中的 Prompt 变量 Provider。 */
type VariableProvider = (context: AssembleContext) => string | undefined

/** 一个全局或 scoped layer 拥有的全部 Prompt 注册。 */
class PromptLayer implements ScopeLayer {
  readonly sections: NamedEntries<PromptSection>
  readonly contexts: NamedEntries<PromptContext>
  readonly runtimeContextSuppressors = new AnonymousEntries<true>()
  readonly toolProviders = new AnonymousEntries<ToolProvider>()
  readonly variables: NamedEntries<VariableProvider>

  /**
   * 创建一个 Prompt layer，并使用与其所有权 scope 对应的诊断。
   * @param scope - scoped owner；全局注册时为 `undefined`。
   */
  constructor(scope: ScopeKey | undefined) {
    this.sections = new NamedEntries(name => new Error(scope === undefined
      ? `prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt section "${name}" is already registered in this scope`))
    this.contexts = new NamedEntries(name => new Error(scope === undefined
      ? `prompt context "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt context "${name}" is already registered in this scope`))
    this.variables = new NamedEntries(name => new Error(scope === undefined
      ? `prompt variable "${name}" is already registered (for a per-agent value, register through that agent's \`agent.ctx\` instead)`
      : `prompt variable "${name}" is already registered in this scope`))
  }

  /** @returns 此 layer 是否不拥有任何 Prompt 注册。 */
  isEmpty(): boolean {
    return this.sections.isEmpty()
      && this.contexts.isEmpty()
      && this.runtimeContextSuppressors.isEmpty()
      && this.toolProviders.isEmpty()
      && this.variables.isEmpty()
  }
}

/** 在每个模型 Step 前组装 Prompt 输入的注册表 Service。 */
export class SystemPrompt extends Service {
  static Config: z<Config> = z.object({
    includeHarnessIdentity: z.boolean().default(true),
    includeRuntimeContext: z.boolean().default(true),
    persona: z.string().default(''),
    // 保留缺省状态，因为显式空顺序不含 rest 标记。
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })

  private readonly layers = new ScopedLayers(
    scope => new PromptLayer(scope),
    () => { this.ctx.emit('system-prompt/change') },
  )
  private readonly toolOrder: string[] | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'systemPrompt')
    this.toolOrder = validateToolOrder(config.toolOrder)
    // 让 Harness 拥有的开场文本不依赖所选 loop 插件。
    if (config.includeHarnessIdentity ?? true) {
      // 该英文身份文本位于默认系统提示词开头，每次模型请求都会消费它。
      // 它是已记录的模型可见稳定文本；翻译会改变默认行为、token 与 KV Cache 前缀，
      // 因此中文说明放在源码和包 README 中，运行时原文保持不变。中文译文：
      // “你是由 DeepSeek Harness 驱动的 AI Agent。”
      this.section({
        name: 'harness:identity',
        order: -100,
        text: 'You are an AI agent powered by DeepSeek Harness.',
      })
    }
    this.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      // fallback 只用于收窄可选输入类型；schema 已提供默认值。persona 是部署方动态文本，
      // 没有可在源码中固定翻译的英文原文。
      text: config.persona ?? '',
    })
    if (!(config.includeRuntimeContext ?? true)) this.suppressRuntimeContext()
  }

  /**
   * 在调用方 Context 的 Scope 中注册有序 Prompt Section。Scope Section 会覆盖同名全局项；
   * 同一层重复名称或非有限 Order 会抛错。注册和释放都会发出 `system-prompt/change`。
   * @param section - 要注册的 Section。
   * @returns Cordis Effect 返回的原始 disposer。
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.sections.insert(section.name, section),
      { label: 'systemPrompt.section()' },
    )
  }

  /**
   * 在调用方 Context 的 Scope 中注册有序动态 Context。Scope 条目覆盖同名全局条目。
   * @param context - 要注册的 Context 贡献。
   * @returns Cordis Effect 返回的原始 disposer。
   */
  context(context: PromptContext): () => void {
    if (!Number.isFinite(context.order)) {
      throw new TypeError(`prompt context "${context.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.contexts.insert(context.name, context),
      { label: 'systemPrompt.context()' },
    )
  }

  /**
   * 抑制调用方 Scope 中的全部动态运行时 Context，但不改变拥有或强制这些事实的 Service。
   * 多个抑制器可以相互独立地释放。
   * @returns Cordis Effect 返回的原始 disposer。
   */
  suppressRuntimeContext(): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.runtimeContextSuppressors.append(true),
      { label: 'systemPrompt.suppressRuntimeContext()' },
    )
  }

  /**
   * 在调用方 Scope 中注册 Tool Schema Provider。全局和匹配 Scope 的 Provider 都会贡献；
   * 返回保留名称 {@link TOOL_ORDER_REST} 会导致组装失败。
   * @param provider - 每次组装时使用该次 Context 求值的 Provider。
   * @returns Cordis Effect 返回的原始 disposer。
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.toolProviders.append(provider),
      { label: 'systemPrompt.tools()' },
    )
  }

  /**
   * 在调用方 Scope 中注册 Prompt 变量。Scope 值覆盖全局值；无效或重复名称会抛错。Provider
   * 可以返回 `undefined`，但之后渲染引用该值的 Section 会失败。
   * @param name - 符合 `[a-z][a-z0-9_]*` 的引用名称。
   * @param provider - 每次组装时求值的 Provider。
   * @returns Cordis Effect 返回的原始 disposer。
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.variables.insert(name, provider),
      { label: 'systemPrompt.variable()' },
    )
  }

  /**
   * 组装全局与 Scope Provider，复制 Tool 参数并应用规范顺序，再执行组装 Waterfall。Scope
   * Section 和变量覆盖全局值。Waterfall 返回值具有最终权威，但若存在有效 Complete
   * Section，之后会恢复它并作为唯一 Prompt Section。
   * @param context - 可选 Scope 以及插件定义的组装字段。
   * @returns Waterfall 处理后、并已强制应用 Complete Prompt 的组装结果。
   */
  // 让配置失败继续位于已声明的异步错误路径上。
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    const scope = context.scope
    const scopeLayers = this.layers.chainLayers(scope)
    const runtimeContextSuppressed = !this.layers.global.runtimeContextSuppressors.isEmpty()
      || scopeLayers.some(layer => !layer.runtimeContextSuppressors.isEmpty())
    // scoped 变量遮蔽全局变量。
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.layers.global.variables.entries()) {
      variables[name] = provider(context)
    }
    // scope 链变量从最远端开始处理，使最近的 scope 最终取得同名变量。
    for (const layer of scopeLayers) {
      for (const [name, provider] of layer.variables.entries()) {
        variables[name] = provider(context)
      }
    }
    // 在稳定 order 排序前让 scoped 段遮蔽全局段。
    const sectionByName = this.layers.merge(scope, layer => layer.sections)
    const contextByName = this.layers.merge(scope, layer => layer.contexts)
    // 收集可见 schema 时，使用限制前名称校验顺序。
    const providers = [
      ...this.layers.global.toolProviders.values(),
      ...scopeLayers.flatMap(layer => [...layer.toolProviders.values()]),
    ]
    const collected: ToolSchema[] = []
    const knownNames = new Set<string>()
    for (const provider of providers) {
      const result = provider(context)
      const schemas = result.schemas.map(({ name, description, parameters }): ToolSchema => ({
        name,
        description,
        parameters: structuredClone(parameters),
      }))
      const acceptedKnownNames = result.knownNames ?? schemas.map(tool => tool.name)
      collected.push(...schemas)
      for (const name of acceptedKnownNames) knownNames.add(name)
    }
    const sectionDefinitions = [...sectionByName.values()].sort((a, b) => a.order - b.order)
    const completeSections = sectionDefinitions.filter(section => section.complete === true)
    if (completeSections.length > 1) {
      throw new Error(`multiple complete prompt sections are active: ${completeSections.map(section => JSON.stringify(section.name)).join(', ')}`)
    }
    let completeSection: AssembledSection | undefined
    const sections = sectionDefinitions
      .map((section) => {
        const assembled = {
          name: section.name,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
        }
        if (section.complete === true) completeSection = { ...assembled }
        return assembled
      })
    const assembly: PromptAssembly = {
      sections,
      contexts: runtimeContextSuppressed
        ? []
        : [...contextByName.values()]
          .sort((a, b) => a.order - b.order)
          .map(entry => ({
            name: entry.name,
            text: typeof entry.text === 'function' ? entry.text(context) : entry.text,
          })),
      tools: orderTools(collected, this.toolOrder, knownNames),
      variables,
    }
    const transformed = await this.ctx.waterfall(
      scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
      () => Promise.resolve(assembly),
    )
    if (completeSection === undefined && !runtimeContextSuppressed) return transformed
    return {
      ...transformed,
      sections: completeSection === undefined ? transformed.sections : [completeSection],
      contexts: runtimeContextSuppressed ? [] : transformed.contexts,
    }
  }
}

export default SystemPrompt
