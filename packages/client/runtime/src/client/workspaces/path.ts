/**
 * 把 Workspace 相对路径解析为 openPath 使用的 Host-facing 表示。
 * @param cwd - 已知时为 Session Workspace 根目录。
 * @param path - 绝对路径或 Workspace 相对路径。
 * @returns 存在 Workspace 根目录时返回绝对路径，否则返回原路径。
 */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/') || isWindowsStylePath(path)) return path
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[/\\]+$/, '')
  const rel = path.replace(/^[/\\]+/, '')
  return `${base}/${rel}`
}

/** 盘符或 UNC 路径；Web 展示不能将其改写为 `~`。 */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/**
 * 仅用于展示的 POSIX Home 缩写。Windows 盘符和 UNC 路径保持原样，包括 `home` 本身是
 * Windows 路径的情况。`home` 缺失、为空或为文件系统根目录时保持 `path` 不变，避免把
 * `/` 变成 `~`。
 * @param path - 绝对路径或已缩短的展示路径。
 * @param home - 来自 `host.describe` 的 Host 账户 Home；缺失时不缩写。
 * @returns POSIX Home 及其子路径使用 `~` 或 `~/…`，否则返回 `path`。
 */
export function abbreviateHomePath(path: string, home?: string): string {
  if (home === undefined || home === '') return path
  if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path
  const root = home.replace(/\/+$/, '')
  if (root === '' || root === '/') return path
  if (path.replace(/\/+$/, '') === root) return '~'
  if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`
  return path
}
