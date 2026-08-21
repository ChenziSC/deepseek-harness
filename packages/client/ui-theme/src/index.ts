/** 在 Host 注册浏览器主题偏好及插件启动前使用的配色。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { bootThemeInjection } from './boot-theme.ts'
import {
  DEFAULT_PREFERENCE, THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema,
  type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

export {
  DEFAULT_PREFERENCE, THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE,
  type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

const THEME_NAMESPACE = settingsNamespace(THEME_SETTINGS_NAMESPACE)

/** 读取已注册的偏好；没有设置 Provider 时使用 Schema 默认值。 */
function readPreference(ctx: Context): ThemePreference {
  const settings = ctx.get('settings')
  if (settings === undefined) return DEFAULT_PREFERENCE
  const section = settings.get(THEME_NAMESPACE) as ThemeSettings | undefined
  if (section === undefined) return DEFAULT_PREFERENCE
  return section.preference
}

/**
 * 可选设置服务组合进来后注册持久化主题区段，并在每次收集 index 注入项时
 * 提供基于当前偏好的主题引导项。
 * @param ctx - 可能取得设置服务的 Host 上下文。
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema)
  })
  ctx.on('webserver/index-inject', (table) => {
    table.push(bootThemeInjection(readPreference(ctx)))
  })
}
