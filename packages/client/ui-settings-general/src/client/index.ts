/**
 * 设置外壳和无特定拥有者文案插件的浏览器端：渲染 `sidebar.settings` 占用者，
 * 包括面板外观、分区导航和 onboarding 阶段；并注册设置页面上不属于单一功能的
 * 内容：触发器/header 外观、本地文档操作、General 分区和 `settings` 字典。
 * 功能拥有的行和分区仍留在对应功能内。导出规范见 packages/client/AGENTS.md。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
// 仅类型：引入 settings Slot 声明和 ctx.settingsScope Context 合并。跨插件协作
// 通过服务完成，绝不进行值导入，以满足客户端 bundle 纯度门。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 仅类型：把 ctx.locale 引入本程序。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  SettingsOnboardingStep, SettingsRootInjected, SettingsSectionRow,
} from './shell-contract.ts'
import { SettingsRoot } from './SettingsRoot.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from './chrome.tsx'
import { GeneralSection } from './GeneralSection.tsx'
import { SettingsDocumentAction } from './SettingsDocumentAction.tsx'
import type { SettingsDocumentActionInjected } from './SettingsDocumentAction.tsx'
import { SettingsDocumentStore } from './settings-document-store.ts'
import { en, zh, type SettingsKey } from './locales.ts'

export type {
  CloseLabelProps, HeaderContentProps, TriggerContentProps,
} from './chrome.tsx'
export type {
  GeneralSectionComponentProps,
} from './GeneralSection.tsx'
export type { SettingsDocumentActionInjected, SettingsDocumentActionProps } from './SettingsDocumentAction.tsx'
export type { SettingsDocumentState } from './settings-document-store.ts'
export { SettingsDocumentStore } from './settings-document-store.ts'
export type { SettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 外壳外观和由外壳拥有的 General 分区文案。 */
    settings: SettingsKey
  }
}

/** 本插件拥有的字典命名空间：外壳外观加 General 文案。 */
const NS = 'settings'

/**
 * 必需服务，通过 Cordis fiber inject。目标 Slot 由 ui-settings 的 apply 声明，
 * 它与本插件的激活顺序没有约束；注册通过 `slots.inject()` 依赖对应 Slot。
 */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

/**
 * 在各 Slot 声明进入台账后，分别注册 `settings` 字典、外观内容和 General 分区。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-general: dictionaries')

  // 文案新鲜度由框架负责：组件读取标准 `t` 座位，导航标签则是拥有者每次渲染时
  // 解析的 thunk；无需 locale/change 重新注册接线。
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  // 此操作跟随共享 describe 镜像；拥有该镜像的插件已负责文档提交和重连时刷新。
  const documentController = connection.isLoopback
    ? new SettingsDocumentStore(connection.api, ctx.settingsScope.describe())
    : undefined
  const documentInjected = documentController === undefined
    ? undefined
    : (): SettingsDocumentActionInjected => ({
      controller: documentController,
      hooks: { snapshot: documentController.store },
    })
  ctx.effect(() => () => { documentController?.dispose() }, 'ui-settings-general: document action directory')
  // 设置外壳：本包占用 sidebar 所拥有孔位，并声明 settings Slot。台账到导航行的
  // 投影作为 observable 来源；按 uSES 约定，台账版本变化前 getSnapshot 返回缓存行。
  // 标签可能是跟随 locale 的 thunk，因此缓存键包含 locale 修订号，订阅者同时跟随
  // 两个来源。
  let rowsVersion = -1
  let rowsRevision = -1
  let rows: readonly SettingsSectionRow[] = []
  let onboardingVersion = -1
  let onboardingSteps: readonly SettingsOnboardingStep[] = []
  const shellInjected = (): SettingsRootInjected => ({
    hooks: {
      sections: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.section')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== rowsVersion || revision !== rowsRevision) {
            rowsVersion = version
            rowsRevision = revision
            rows = ctx.slots.entries('settings.section')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id (SlotCore rejects an entry without one) */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
                label: resolveSlotLabel(e.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return rows
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.section', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
      onboardingSteps: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.onboarding')
          if (version !== onboardingVersion) {
            onboardingVersion = version
            onboardingSteps = ctx.slots.entries('settings.onboarding')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
              }))
              .sort((a, b) => a.order - b.order)
          }
          return onboardingSteps
        },
        subscribe: listener => ctx.slots.subscribe('settings.onboarding', listener),
      },
    },
  })
  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    children: {
      'settings.trigger': { kind: 'single', scope: 'root' },
      'settings.header': { kind: 'single', scope: 'root' },
      'settings.action': { kind: 'list', scope: 'root' },
      'settings.close': { kind: 'single', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.onboarding': { kind: 'list', scope: 'root' },
    },
    inject: shellInjected,
  }, SettingsRoot))

  ctx.slots.inject('settings.trigger', () =>
    ctx.slots.register({ name: 'settings.trigger', locale: NS }, TriggerContent))
  ctx.slots.inject('settings.header', () =>
    ctx.slots.register({ name: 'settings.header', locale: NS }, HeaderContent))
  if (documentInjected !== undefined) {
    ctx.slots.inject('settings.action', () => ctx.slots.register({
      name: 'settings.action',
      id: 'open-document',
      order: 0,
      locale: NS,
      inject: documentInjected,
    }, SettingsDocumentAction))
  }
  ctx.slots.inject('settings.close', () =>
    ctx.slots.register({ name: 'settings.close', locale: NS }, CloseLabel))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'general',
    order: 0,
    label: () => t('general.nav'),
    locale: NS,
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
  }, GeneralSection))
}
