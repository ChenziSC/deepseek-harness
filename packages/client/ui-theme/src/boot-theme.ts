/**
 * 浏览器在插件启动前使用的主题引导项。每次渲染 index 时都会嵌入当前持久化的
 * 内置主题偏好；浏览器只需解析 `system`，随后写入与 Client 插件树启动后
 * ui-layout 的 ThemePresenter 所负责内容相同的 DOM 字段。
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { DEFAULT_PREFERENCE, type ThemePreference } from './theme-settings.ts'

/** 为一个已经通过 Schema 校验的内置主题偏好构造内联脚本。 */
function bootThemeScript(preference: ThemePreference): string {
  return `(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
})()`
}

/**
 * 把主题引导逻辑封装为注入项：内联脚本紧跟在 body 开始标签之后，
 * 早于页面外壳挂载和模块脚本执行。
 * @param preference - 当前由 Host 保存的内置主题偏好。
 * @returns body 脚本注入项。
 */
export function bootThemeInjection(
  preference: ThemePreference = DEFAULT_PREFERENCE,
): IndexInjection {
  return { kind: 'script', placement: 'body', text: bootThemeScript(preference) }
}
