/**
 * Settings 域基础插件的浏览器端。它提供 `ctx.settingsScope`：每个偏好设置行都通过这一
 * Settings namespace scope 服务绑定自身的持久化 section；同时拥有浏览器中唯一的
 * `settings.describe` reader，即 describe mirror。Mirror 的失效订阅
 *（`settings/document-updated`、`connection/reset`）也位于此处，使所有派生界面都从
 * 同一次 wire 读取刷新。本包不依赖任何 `ui-*` 展示包，因此拥有偏好设置的任意功能都能
 * 使用它。Settings Shell（`sidebar.settings` 占位组件、导航和 chrome）放在
 * ui-settings-general，因为 Shell 若依赖 ui-sidebar，会经 ui-layout 与 ui-theme 形成
 * 闭合引用环。导出规则见 packages/client/AGENTS.md。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// 仅导入类型：提供 `$on` 及其键接口，同时避免把构建产物拖入 Host 图；理由见
// settings-scope.ts 中相同的导入对。
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import { SettingsSchemaService } from './schema.ts'
import { SettingsScopeBinder } from './settings-scope.ts'
import { SettingsDescribeMirror } from './settings-mirror.ts'

export type {
  SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps, SettingsOnboardingOwnerProps,
  SettingsPluginsTabOwnerProps, SettingsSectionOwnerProps, SettingsTriggerOwnerProps,
} from './contract/slots.ts'
export type { SettingsScopeController, SettingsScopeBinder } from './settings-scope.ts'
export type { SettingsSchemaService } from './schema.ts'
export type { SchemaNode } from './schema.ts'
export type { SettingsDescribeFace, SettingsDescribeView, SettingsMirrorSnapshot } from './settings-mirror.ts'

/**
 * 必需服务：Mirror 读取所用的 wire handle，以及触发 Mirror 刷新的转发 Settings 失效事件。
 */
export const inject = ['connection', 'remote']

/**
 * 在共享 describe mirror 上提供 Settings namespace scope 服务，并在两种会改变 Settings
 * 文档的信号到来时刷新 Mirror：文档提交以及连接/重连。
 *
 * 在本插件 fiber 内构造服务，使其 traced method 绑定到各消费插件的 Context。
 * @param ctx - 客户端根 Context。
 */
export function apply(ctx: ClientContext): void {
  const schema = new SettingsSchemaService(ctx)
  const connection = ctx.get('connection') as ConnectionHandle
  const mirror = new SettingsDescribeMirror(
    connection.api,
    connection.isLoopback ? 'host' : 'memory',
  )
  ctx.effect(() => {
    const disposers = [
      (ctx.get('remote') as ClientContext['remote']).$on('settings/document-updated', () => { void mirror.load() }),
      ctx.on('connection/reset', () => { void mirror.load() }),
    ]
    // 首次连接也会发出 connection/reset，因此启动通常产生两次读取；其预算由
    // startup-rpc-budget.e2e.ts 固定。in-flight fold 不会把二者合成一次读取，但能保证
    // 任一时刻最多只有一次读取待定，并且读取期间到达的失效信号不会丢失。
    void mirror.ensure()
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings: describe mirror invalidations')
  new SettingsScopeBinder(ctx, { mirror, schema })
}
