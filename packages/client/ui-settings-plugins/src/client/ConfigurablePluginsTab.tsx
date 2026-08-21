/**
 * 贡献到共享 Plugins 分区的可配置 Host 插件。
 *
 * 标签页枚举 settings 命名空间但绝不解释它们。卡片通过 `settings.plugin.item`
 * 到达，并以其编辑的命名空间为键；因此附带浏览器端的插件拥有自己的卡片，本标签
 * 只决定分发哪些键。
 */

import { Fragment } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import type { ConfigurablePluginsTabFace } from './tab-store.ts'
import css from './PluginsSettingsSection.module.css'

/** 渲染器为可配置标签页绑定的 props。 */
export type ConfigurablePluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugin.item'>
  & InjectFace<ConfigurablePluginsTabFace>

/**
 * 渲染由暴露可编辑设置的插件注册的卡片。
 * @param props - locale 文案、Slot 渲染和要分发的命名空间。
 * @returns 卡片列表；Host 回答后无卡片时返回空状态行。
 */
export function ConfigurablePluginsTab(props: ConfigurablePluginsTabProps) {
  const { t, renderSlot } = props
  const { loaded, namespaces } = props.useConfigurablePlugins(snapshot => snapshot)
  if (namespaces.length > 0) {
    return (
      <ul className={css.cards}>
        {namespaces.map(ns => (
          // 每个命名空间分发一次，因此列表身份是命名空间，而不是随卡片到达移动的位置。
          <Fragment key={ns}>{renderSlot('settings.plugin.item', {}, { entryKey: ns })}</Fragment>
        ))}
      </ul>
    )
  }
  return loaded ? <p className={css.empty}>{t('empty')}</p> : null
}
