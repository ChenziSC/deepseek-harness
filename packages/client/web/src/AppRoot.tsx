/**
 * Shell 根组件：启动加载页 → 启动结算 → 一次切换到真实 UI。
 *
 * 这是不依赖任何插件的纯内核组件。结算前只能依赖自身：错误展示不能依赖
 * 正在报告失败的系统，status/signal 存储也归内核所有，从而满足 shell
 * 自给规则。所有配置项激活后，app-shell 配置项才生成真实 UI。启动失败时
 * 保持加载页，列出各配置项的 fiber 状态和扫描报告，明确失败且不显示局部 UI。
 */
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { KernelSignal, LoaderStatus } from './loader-status.ts'
import css from './AppRoot.module.css'

/** AppRoot 属性：结算信号、fiber 状态投影、启动失败报告和延迟创建真实 UI 的工厂。 */
export interface AppRootProps {
  /** 启动链结算后为 true，即 loader 完全停稳且所有配置项均为 ACTIVE；由启动闭包切换。 */
  settled: KernelSignal<boolean>
  /** 按配置项记录的 fiber 状态投影存储，用于驱动加载和失败界面。 */
  status: KernelSignal<LoaderStatus>
  /** 启动失败报告，即结算拒绝消息；加载中或成功后为 undefined。 */
  error: KernelSignal<string | undefined>
  /** 创建真实 UI；仅在启动结算后调用。 */
  renderApp: () => ReactNode
}

/** 启动门控：结算前显示加载页，失败也停留在此处。 */
export function AppRoot(props: AppRootProps) {
  const settled = useSyncExternalStore(props.settled.subscribe, props.settled.getSnapshot)
  const status = useSyncExternalStore(props.status.subscribe, props.status.getSnapshot)
  const error = useSyncExternalStore(props.error.subscribe, props.error.getSnapshot)
  const failed = Object.entries(status).filter(([, s]) => s === 'failed')

  if (settled) return <>{props.renderApp()}</>

  const loud = error !== undefined || failed.length > 0

  return (
    <div className={css.boot}>
      <div className={css.card}>
        <div className={css.wordmark}>HARNESS</div>
        {!loud
          ? (
            <>
              <div className={css.spinner} />
              <div className={css.hint}>Loading plugins…</div>
            </>
          )
          : (
            <div className={css.failed}>
              <div className={css.failedTitle}>Failed to load plugins</div>
              {failed.map(([id]) => <div key={id} className={css.failedItem}>{id}</div>)}
              {error !== undefined && <div className={css.failedItem}>{error}</div>}
            </div>
          )}
      </div>
    </div>
  )
}
