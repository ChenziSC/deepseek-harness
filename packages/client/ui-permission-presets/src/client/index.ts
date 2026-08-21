/**
 * 权限 preset 插件的浏览器端：在 Host `/permission` 命令上挂一个 popupSelect
 * DECORATION，展示扁平 preset 列表、标记当前值，并在选择后执行切换。装饰只拥有
 * 裸调用；Host 命令仍保留目录行、带参数路径（`/permission <preset>` 仍可直接切换）
 * 和生命周期日志。选项及活动标记读取会话 `permissions` 投影，也就是编辑器胶囊
 * 渲染的同一个 Host 计算 select；选择后提交 `/permission <preset>` 命令行，因此
 * 两个界面共用一条写入路径，推送的投影 frame 是唯一确认。Full access 行采用与
 * 编辑器胶囊相同的显式风险门，模态机制由共享 popup 外壳拥有。General 设置行则
 * 通过 Host Settings API 单独写入后续新建会话所用的默认 preset。
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// 仅类型：引入 locale 插件的 Context 合并（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 仅类型：引入 settings Slot 类型；本包会注册一个 General 行。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 仅类型：把 ctx.remote 合并和转发事件键接口引入本程序；settings 失效事件通过
// allowlist 转发。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission-presets/client'
import { PermissionRow } from './PermissionRow.tsx'
import type { PermissionRowInjected } from './PermissionRow.tsx'
import {
  accessEn, accessZh, en, zh,
} from './locales.ts'
import {
  displayPermissionPreset, FULL_ACCESS_PRESET,
} from './presentation.ts'
import { PermissionPresetSettingsController } from './settings-store.ts'

export type { PermissionRowInjected, PermissionRowProps } from './PermissionRow.tsx'
export type {
  PermissionDefaultOption, PermissionSettingsState,
} from './settings-store.ts'

/** 必需服务，通过 Cordis fiber inject。 */
export const inject = ['commandUi', 'sessions', 'slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsSchema']

const ACCESS_NS = 'permission.access'

/** 读取一个会话当前权限投影值；undefined 表示能力不存在。 */
function selectOf(session: SessionFace | undefined): PermissionSelect | undefined {
  return session?.projections.faceOf('permissions').getSnapshot() as PermissionSelect | undefined
}

/** 把投影 select 展平为弹窗行；`custom` 只是展示状态，绝不是选择目标。 */
function optionsOf(value: PermissionSelect, t: (key: string) => string): SelectOption[] {
  return value.options
    .filter(option => option.value !== 'custom')
    .map(option => ({
      id: option.value,
      label: displayPermissionPreset(option.value, option.name, t),
      ...(option.description !== undefined ? { detail: option.description } : {}),
      ...(option.value === value.currentValue ? { active: true } : {}),
      ...(option.value === FULL_ACCESS_PRESET
        ? {
          confirmation: {
            title: t('confirm.title'),
            description: t('confirm.description'),
            acknowledgeLabel: t('confirm.acknowledge'),
            cancelLabel: t('confirm.cancel'),
            confirmLabel: t('confirm.enable'),
          },
        }
        : {}),
    }))
}

/**
 * 客户端插件主体：在 permissions 投影上注册 /permission 弹窗选择器。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const command = ctx.get('commandUi') as CommandUiContract
  const sessions = ctx.sessions
  // 此可选 bundle 与 ui-conversation 可独立加载，因此各自在自己的 locale 命名空间
  // 拥有一份相同安全文案。
  /* jscpd:ignore-start */
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(ACCESS_NS, 'zh', {
        'preset.readOnly': accessZh['preset.readOnly'],
        'preset.workspaceWrite': accessZh['preset.workspaceWrite'],
        'preset.fullAccess': accessZh['preset.fullAccess'],
        'confirm.title': accessZh['confirm.title'],
        'confirm.description': accessZh['confirm.description'],
        'confirm.acknowledge': accessZh['confirm.acknowledge'],
        'confirm.cancel': accessZh['confirm.cancel'],
        'confirm.enable': accessZh['confirm.enable'],
      }),
      ctx.locale.register(ACCESS_NS, 'en', {
        'preset.readOnly': accessEn['preset.readOnly'],
        'preset.workspaceWrite': accessEn['preset.workspaceWrite'],
        'preset.fullAccess': accessEn['preset.fullAccess'],
        'confirm.title': accessEn['confirm.title'],
        'confirm.description': accessEn['confirm.description'],
        'confirm.acknowledge': accessEn['confirm.acknowledge'],
        'confirm.cancel': accessEn['confirm.cancel'],
        'confirm.enable': accessEn['confirm.enable'],
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-permission: Full access confirmation dictionaries')
  /* jscpd:ignore-end */
  const t = ctx.locale.bind(ACCESS_NS)
  const sessionFor = (session: ClientSessionContext): SessionFace | undefined =>
    sessions.binding(session.sessionId)?.session

  ctx.effect(() => ctx.locale.register('settings.permission', { zh, en }), 'ui-permission: settings row dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  // 此行跟随共享 describe 镜像；拥有该镜像的插件已负责在文档提交和重连时刷新。
  const controller = new PermissionPresetSettingsController(
    ctx.settingsScope.describe(), connection.api, ctx.settingsSchema)
  const load = (): Promise<void> => controller.load()
  const select = (preset: string): Promise<void> => controller.select(preset)
  const injected = (): PermissionRowInjected => ({
    hooks: { permission: controller.store },
    load,
    select,
  })

  ctx.effect(() => () => { controller.dispose() }, 'ui-permission: settings row directory')

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'permission',
    order: -20,
    locale: 'settings.permission',
    inject: injected,
  }, PermissionRow))

  ctx.effect(() => command.decorate({
    name: 'permission',
    // 选择器只在投影存在时存在：不提供权限能力的 Host 不发布该键，裸调用会落回
    // Host 命令；该命令同样不存在，因此该文本行只是未命中。
    available: session => selectOf(sessionFor(session)) !== undefined,
    ui: {
      kind: 'popupSelect',
      options: (session) => {
        const value = selectOf(sessionFor(session))
        if (value === undefined) throw new Error('permission presets are not available on this host')
        return Promise.resolve(optionsOf(value, t))
      },
      onSelect: async (option, session) => {
        const live = sessionFor(session)
        if (live === undefined) throw new Error('this session is not materialized yet')
        const result = await live.command(`/permission ${option.id}`)
        if (!result.ok) throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`)
        if (!result.value.matched) throw new Error('the host offers no /permission command')
      },
    },
  }), 'ui-permission: /permission decoration')
}
