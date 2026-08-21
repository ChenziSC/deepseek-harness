/** 需要显式 GUI 风险门的 preset 机器值。 */
export const FULL_ACCESS_PRESET = 'danger-full-access'

/** 内置权限 preset 标签的 locale 字典键。 */
export type PermissionPresetLabelKey =
  | 'preset.readOnly'
  | 'preset.workspaceWrite'
  | 'preset.fullAccess'

const PRESET_LABEL_KEYS = new Map<string, PermissionPresetLabelKey>([
  ['read-only', 'preset.readOnly'],
  ['workspace-write', 'preset.workspaceWrite'],
  [FULL_ACCESS_PRESET, 'preset.fullAccess'],
])

const DEFAULT_PRESET_LABELS: Record<PermissionPresetLabelKey, string> = {
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Full access',
}

/**
 * 把常规 kebab-case preset 名称转换为面向用户的标题格式。
 * @param name - Host 提供的 preset 标签或键。
 * @returns 标题格式的常规键；非 kebab 标签原样返回。
 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * 使用产品标签渲染权限 preset。
 * @param value - preset 机器值。
 * @param name - Host 提供的 preset 名称。
 * @param t - 内置产品标签的可选 locale 字典查询。
 * @returns 内置产品标签或常规展示名称。
 */
export function displayPermissionPreset(
  value: string,
  name: string,
  t?: (key: PermissionPresetLabelKey) => string,
): string {
  const key = PRESET_LABEL_KEYS.get(value)
  if (key !== undefined && (name === value || name === DEFAULT_PRESET_LABELS[key])) {
    return t?.(key) ?? DEFAULT_PRESET_LABELS[key]
  }
  return displayPresetName(name)
}
