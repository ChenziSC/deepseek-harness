/**
 * 不依赖 UI 框架的启动页与失败报告。React 只随 UI renderer 到达，因此即使客户端
 * 插件失败，该页面仍然可用。
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** 创建带有一个模块类名及可选文本的 div。 */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** 挂载在应用根元素下、由内核所有的页面。 */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly wordmark: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined

  /**
   * 创建并挂载启动页。
   * @param container - 应用挂载点。
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.wordmark = div(css.wordmark, 'HARNESS')
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, 'Loading plugins…')
    this.card.append(this.wordmark, this.spinner, this.hint)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
  }

  /**
   * 设置进度弧所表示的 loader 配置项总数。
   * @param total - 完整启动名单的大小。
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * 投影一个 loader 配置项的 fiber 状态。
   * @param id - Loader 配置项名称。
   * @param state - 投影后的 fiber 状态。
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * 显示启动失败报告。
   * @param message - 失败报告文本。
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** 在 UI renderer 接管挂载点前后均可移除该页面。 */
  dispose(): void {
    this.root.remove()
  }

  /** 重绘文字标志下方依赖状态的内容。 */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.card.replaceChildren(this.wordmark, report)
  }

  /** 随 loader 配置项激活，单调增加旋转弧的长度。 */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
