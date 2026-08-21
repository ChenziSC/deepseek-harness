/**
 * Plugins 设置界面的浏览器端：一个分区，其中由功能拥有的标签页包括可配置 Host
 * 插件卡片和只读清单。
 *
 * 分区声明 `settings.plugins.tab`；其 `configurable` 标签再声明
 * `settings.plugin.item`，并渲染所有注册卡片。本包附带的三张卡片对应部署已暴露的
 * Host 平面分区；每张卡通过客户端 settings 作用域绑定自身命名空间，因此彼此以及
 * 与其他标签页都互不知晓。
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// 仅类型：引入 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 仅类型：引入 settings 外壳 SlotMap 合并（'settings.section' 条目）和
// ctx.settingsScope Context 合并。跨插件协作通过服务完成，绝不值导入，以满足
// 客户端 bundle 纯度门。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
// 仅类型：引入 ctx.remote Context 合并和转发事件键接口。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AgentLoopCard } from './AgentLoopCard.tsx'
import { BashCard } from './BashCard.tsx'
import { ConfigurablePluginsTab } from './ConfigurablePluginsTab.tsx'
import { PluginsSettingsSection } from './PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionInjected, PluginsSettingsTabEntry } from './PluginsSettingsSection.tsx'
import { WebSearchCard } from './WebSearchCard.tsx'
import { AGENT_LOOP_NS, AgentLoopCardController } from './agent-loop-card-controller.ts'
import { SHELL_NS, BashCardController } from './bash-card-controller.ts'
import { ConfigurablePluginsTabController } from './tab-store.ts'
import { WEB_SEARCH_NS, WebSearchCardController } from './web-search-card-controller.ts'
import { en, zh } from './locales.ts'

export type { PluginsSettingsSectionInjected, PluginsSettingsSectionProps } from './PluginsSettingsSection.tsx'
export type { ConfigurablePluginsTabProps } from './ConfigurablePluginsTab.tsx'
export type { ConfigurablePluginsTabFace, ConfigurablePluginsTabState } from './tab-store.ts'
export type { PluginCardProps } from './PluginCard.tsx'
export type { SettingsPluginItemOwnerProps } from './slot-contract.ts'
export type { FieldProps } from './fields.tsx'
export type {
  CardActions, CardFieldSpec, CardFieldState, CardSecretSpec, CardShell,
} from './card-form.ts'
export type { AgentLoopCardFace, AgentLoopCardState } from './agent-loop-card-controller.ts'
export type { BashCardFace, BashCardState } from './bash-card-controller.ts'
export type { WebSearchCardFace, WebSearchCardState } from './web-search-card-controller.ts'

/** 本插件拥有的字典命名空间。 */
const NS = 'settings.plugins'

/** 必需服务，通过 Cordis fiber inject。 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * 挂载插件配置分区和本包附带的卡片。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugins: section dictionaries')

  const bash = new BashCardController(ctx.settingsScope.bind({ namespace: SHELL_NS }))
  const agentLoop = new AgentLoopCardController(ctx.settingsScope.bind({ namespace: AGENT_LOOP_NS }))
  const webSearch = new WebSearchCardController(ctx.settingsScope.bind({ namespace: WEB_SEARCH_NS }), api)

  // 卡片报告的凭据不属于任何 settings 分区，因此写入时其作用域不会发布内容。
  // 这是其他界面写入的 key 已到达 Host 的唯一信号。
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { webSearch.refreshCredential(ref) }),
    'ui-settings-plugins: credential invalidations',
  )

  // Host 提供哪些命名空间来自共享 describe 镜像；拥有镜像的插件已负责文档提交和
  // 重连时刷新，标签页只做派生。
  const configurable = new ConfigurablePluginsTabController(
    ctx.settingsScope.describe(), () => ctx.slots.entries('settings.plugin.item'))
  ctx.effect(() => () => { configurable.dispose() }, 'ui-settings-plugins: tab directory')
  // 首次读取后注册的卡片无需线协议调用即可加入列表。
  ctx.effect(
    () => ctx.slots.subscribe('settings.plugin.item', () => { configurable.refresh() }),
    'ui-settings-plugins: card ledger',
  )

  let tabsVersion = -1
  let tabsRevision = -1
  let tabs: readonly PluginsSettingsTabEntry[] = []
  const sectionInjected = (): PluginsSettingsSectionInjected => ({
    hooks: {
      tabs: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.plugins.tab')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== tabsVersion || revision !== tabsRevision) {
            tabsVersion = version
            tabsRevision = revision
            tabs = ctx.slots.entries('settings.plugins.tab')
              .map(entry => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return tabs
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.plugins.tab', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
    },
  })

  // 本包拥有唯一 Plugins 导航条目和标签外观；功能插件贡献页面时无需竞争 Settings
  // 导航行。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugins',
    order: 15,
    label: () => t('nav'),
    locale: NS,
    inject: sectionInjected,
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  }, PluginsSettingsSection))

  // The existing configuration page is one ordinary tab. It keeps ownership
  // of the card slot and the three shipped card contributions below.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'configurable',
    order: 0,
    label: () => t('configurableTab'),
    locale: NS,
    inject: () => configurable.inject(),
    children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
  }, ConfigurablePluginsTab))

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: SHELL_NS,
      locale: NS,
      inject: () => bash.inject(),
    }, BashCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: AGENT_LOOP_NS,
      locale: NS,
      inject: () => agentLoop.inject(),
    }, AgentLoopCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: WEB_SEARCH_NS,
      locale: NS,
      inject: () => webSearch.inject(),
    }, WebSearchCard)
  })
}
