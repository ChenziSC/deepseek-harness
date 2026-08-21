/** 同步 schema 内省和不可变设置草稿编辑。 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** 用于设置内省和验证的实时 Schemastery 节点。 */
export type SchemaNode = Schema

function cloneContainer(container: unknown, key: string): Record<string, unknown> | unknown[] {
  if (Array.isArray(container)) return [...container as unknown[]]
  if (typeof container === 'object' && container !== null) return { ...container as Record<string, unknown> }
  return /^\d+$/.test(key) ? [] : {}
}

function cloneSpine(root: Record<string, unknown>, path: readonly string[]): {
  result: Record<string, unknown>
  parent: Record<string, unknown> | unknown[]
  leaf: string
} {
  const result = { ...root }
  let target: Record<string, unknown> | unknown[] = result
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index] as string
    const child = cloneContainer(
      Array.isArray(target) ? target[Number(key)] : target[key],
      path[index + 1] as string,
    )
    if (Array.isArray(target)) target[Number(key)] = child
    else target[key] = child
    target = child
  }
  return { result, parent: target, leaf: path[path.length - 1] as string }
}

/**
 * 由 settings 拥有的同步 schema 服务。动态客户端插件接收这个 Cordis 实体，
 * 而不是相互导入可执行辅助函数。
 */
export class SettingsSchemaService extends Service {
  /** @param ctx - 提供服务的 ui-settings 上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'settingsSchema')
  }

  /**
   * 复原一个序列化的 `schema.toJSON()` 信封。
   * @param serialized - 序列化 Schemastery 节点。
   * @returns 实时 schema 节点。
   */
  rehydrate(serialized: unknown): SchemaNode {
    return new Schema(serialized as Schema)
  }

  /**
   * 验证设置草稿。
   * @param schema - 实时 schema 节点。
   * @param draft - 候选设置值。
   * @returns 验证失败文本；合法时为 `undefined`。
   */
  validate(schema: SchemaNode, draft: unknown): string | undefined {
    try {
      ;(schema as unknown as (value: unknown) => unknown)(draft)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * 解析设置路径上的 object、dict 或 array schema 节点。
   * @param root - 要遍历的 schema 节点。
   * @param path - 对象键或数组索引。
   * @returns 已解析节点；路径不存在时为 `undefined`。
   */
  nodeAtPath(root: SchemaNode, path: readonly string[]): SchemaNode | undefined {
    let node: SchemaNode | undefined = root
    for (const key of path) {
      if (node === undefined) return undefined
      if (node.type === 'object') node = (node.dict as Record<string, SchemaNode> | undefined)?.[key]
      else if (node.type === 'dict' || node.type === 'array') node = node.inner as SchemaNode | undefined
      else return undefined
    }
    return node
  }

  /**
   * 按字符串键或数组索引路径读取嵌套值。
   * @param value - 要遍历的值。
   * @param path - 对象键或数组索引。
   * @returns 已解析值；路径不存在时为 `undefined`。
   */
  getPath(value: unknown, path: readonly string[]): unknown {
    let current: unknown = value
    for (const key of path) {
      if (Array.isArray(current)) {
        current = current[Number(key)]
        continue
      }
      if (typeof current !== 'object' || current === null) return undefined
      current = (current as Record<string, unknown>)[key]
    }
    return current
  }

  /**
   * 判断最终路径键是否存在，与其值无关。
   * @param value - 要遍历的值。
   * @param path - 对象键或数组索引。
   * @returns 路径是否存在。
   */
  hasPath(value: unknown, path: readonly string[]): boolean {
    if (path.length === 0) return value !== undefined
    const parent = this.getPath(value, path.slice(0, -1))
    const key = path[path.length - 1] as string
    if (Array.isArray(parent)) return Number(key) < parent.length
    if (typeof parent !== 'object' || parent === null) return false
    return key in parent
  }

  /**
   * 以不可变方式设置嵌套值，并实体化缺失容器。
   * @param root - 要复制的设置对象。
   * @param path - 非空对象键或数组索引路径。
   * @param value - 替换值。
   * @returns 包含替换值的已复制根对象。
   * @throws `path` 为空时抛错。
   */
  setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
    if (path.length === 0) throw new Error('ui-settings: setPath needs a non-empty path')
    const { result, parent, leaf } = cloneSpine(root, path)
    if (Array.isArray(parent)) parent[Number(leaf)] = value
    else parent[leaf] = value
    return result
  }

  /**
   * 以不可变方式移除嵌套键；路径缺失时保持根对象不变。
   * @param root - 要复制的设置对象。
   * @param path - 非空对象键或数组索引路径。
   * @returns 不含该键的已复制根对象；路径缺失时返回原 `root`。
   * @throws `path` 为空时抛错。
   */
  deletePath(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
    if (path.length === 0) throw new Error('ui-settings: deletePath needs a non-empty path')
    if (!this.hasPath(root, path)) return root
    const { result, parent, leaf } = cloneSpine(root, path)
    if (Array.isArray(parent)) parent.splice(Number(leaf), 1)
    else Reflect.deleteProperty(parent, leaf)
    return result
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 由 settings 拥有的同步 schema 和不可变路径操作。 */
    settingsSchema: SettingsSchemaService
  }
}
