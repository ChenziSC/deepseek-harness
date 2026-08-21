/** 用于打开文件支撑 Host 文档的可选 settings-header 操作。 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsDocumentStore } from './settings-document-store.ts'
import css from './SettingsDocumentAction.module.css'

/** 由注册者拥有的 {@link SettingsDocumentAction} 依赖。 */
export interface SettingsDocumentActionInjected {
  /** 提供方元数据和操作状态拥有者。 */
  controller: SettingsDocumentStore
  hooks: {
    /** 由 UI 渲染器绑定为 useSnapshot 的控制器快照。 */
    snapshot: SettingsDocumentStore['store']
  }
}

/** header 操作 owner share、本地化文案和注册者状态接口。 */
export type SettingsDocumentActionProps =
  PropsRuntime<'settings.action'> & PropsLocale<'settings'> & InjectFace<SettingsDocumentActionInjected>

/**
 * 只有 Host 元数据确认文档可用后才渲染打开文档操作。
 * @param props - header owner props、本地化文案和注入的文档状态。
 * @returns 操作；不可用或尚未解析时为 null。
 */
export function SettingsDocumentAction({ controller, useSnapshot, t }: SettingsDocumentActionProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)

  useEffect(() => {
    void controller.load()
  }, [controller])

  if (state.status !== 'ready') return null

  return (
    <div className={css.action}>
      {state.error === null ? null : <span className={css.error} role="alert">{t('openDocument.error')}</span>}
      <Button
        variant="outline"
        size="sm"
        disabled={state.opening}
        onClick={() => { void controller.open() }}
      >
        {t('openDocument')}
      </Button>
    </div>
  )
}
