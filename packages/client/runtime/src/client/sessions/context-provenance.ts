// Context 来源投影：仅从持久 `source` 读取一条已记录、非用户 `user/message` 的角色和
// 面向人的生产者名称。客户端不维护已知插件 ID 表；生产者重命名或新挂载后不应要求
// 发布新客户端才能识别，恢复或外部日志也必须与实时日志采用相同投影方式。

/**
 * 一条已记录非用户消息在模型侧扮演的角色。
 *
 * `recall` 表示从另一 session 日志取出的材料；`inject` 表示其他生产者提供的上下文。
 * turn 中途 steering 是记录中区分的第三种角色，但它有自己的事件和 Node 类型
 * （`steering/message` / `SteeringMessageNode`），不会进入这里。
 */
export type ContextRole = 'inject' | 'recall'

/** 一条已记录非用户消息所展示的角色和生产者名称。 */
export interface ContextProvenanceView {
  /** 该上下文在面向模型的对话中扮演的角色。 */
  role: ContextRole
  /**
   * 行标题使用的生产者名称，取自持久来源：指令路径、被引用 session 标题、插件 ID，
   * 或本 UI 版本不认识的生产者所携带的原始 source kind。仅当来源完全没有可读 kind
   * 时为 null。
   */
  label: string | null
}

/** 将持久来源收窄为可读记录结构；其他值返回 null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 将记录字段读取为非空字符串；否则返回 null。 */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 按首次出现顺序收集数组来源成员中不重复的非空 `field` 值。 */
function collect(source: Record<string, unknown>, member: string, field: string): string[] {
  const list = source[member]
  if (!Array.isArray(list)) return []
  const seen: string[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    const value = record === null ? null : readString(record, field)
    if (value !== null && !seen.includes(value)) seen.push(value)
  }
  return seen
}

/** 将收集的名称列表渲染为一个标签；列表为空时返回 null。 */
function joined(names: string[]): string | null {
  return names.length > 0 ? names.join(', ') : null
}

/**
 * 一个持久 `session-reference` recall 来源引用的 session 标签，按首次出现顺序排列。
 * 其他来源结构均返回空数组，包括引用条目没有可读标签的外部或旧日志。
 * @param source - 已记录 `user/message` 的原始 source。
 * @returns 去重后的非空引用标签。
 */
export function sessionRecallLabels(source: unknown): string[] {
  const record = asRecord(source)
  if (record === null || readString(record, 'kind') !== 'session-reference') return []
  return collect(record, 'references', 'label')
}

/**
 * 将一个持久消息来源投影为记录角色和生产者名称。
 *
 * 来源以不透明 JSON 经传输到达。`MessageSource` 可通过声明合并扩展，因此客户端联合
 * 类型无法穷举；持久日志也可能早于或晚于本 UI。任何无法识别的结构都降级为
 * `inject`，并尽量使用记录仍携带的名称。
 * @param source - 已记录 `user/message` 的原始 source。
 * @returns 本上下文要展示的角色和生产者名称。
 */
export function contextProvenance(source: unknown): ContextProvenanceView {
  const record = asRecord(source)
  const kind = record === null ? null : readString(record, 'kind')
  if (record === null || kind === null) return { role: 'inject', label: null }
  switch (kind) {
    // 跨 session 快照是唯一携带其他 session 材料的持久来源；references 指明材料
    // 来自哪些 session。
    case 'session-reference':
      return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind }
    // Workspace 指令列出其协调来源文件，这比插件 ID 更能说明生产者。
    case 'agent-instructions':
      return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind }
    case 'plugin':
      return { role: 'inject', label: readString(record, 'plugin') ?? kind }
    // 用户显式调用 skill 时，来源会给出所注入 skill 的名称。
    case 'skill-invocation':
      return { role: 'inject', label: readString(record, 'name') ?? kind }
    // 可通过声明合并扩展的来源映射采用此默认分支；未知生产者仍以自身持久 kind 标识。
    default:
      return { role: 'inject', label: kind }
  }
}

/**
 * 本 UI 版本提供专门展示方式的 Context form。持久词汇表（dsh-llm 中的
 * `ContextForm`）可能已经更宽；无法识别或缺失的值会降级为不透明展示，而不是丢弃
 * 该行，从而仍能渲染较新或外部生产者写入的日志。
 */
const KNOWN_FORMS = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'] as const

/** 本 UI 版本知道如何展示的一种持久 Context form。 */
export type KnownContextForm = typeof KNOWN_FORMS[number]

/**
 * 从一个持久消息来源读取生产者声明的 form。
 * @param source - 已记录 `user/message` 的原始 source。
 * @returns 本 UI 版本支持的 form；否则返回 null，按不透明内容展示。
 */
export function contextForm(source: unknown): KnownContextForm | null {
  const record = asRecord(source)
  const form = record === null ? null : readString(record, 'form')
  return form !== null && (KNOWN_FORMS as readonly string[]).includes(form)
    ? form as KnownContextForm
    : null
}
