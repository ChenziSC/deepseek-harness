/** 会话编辑器针对 Safari 的 textarea 布局恢复。 */

/** 区分 Safari 与其他 WebKit 浏览器所需的浏览器身份字段。 */
export interface BrowserIdentity {
  readonly userAgent: string
  readonly vendor: string
}

const ALTERNATE_IOS_BROWSER = /\b(?:CriOS|FxiOS|EdgiOS|OPiOS|OPT|DuckDuckGo|Brave)(?:\/|\b)/

/**
 * 检测 Safari 的 `Version/... Safari/...` 形式，同时排除已知 iOS 替代浏览器词元。
 * @param identity - 浏览器 user-agent 和 vendor 值。
 * @returns 该身份是否应使用 Safari 专用恢复。
 */
export function isSafariBrowser(identity: BrowserIdentity): boolean {
  return identity.vendor === 'Apple Computer, Inc.'
    && /\bVersion\/[\d.]+.*\bSafari\/[\d.]+/.test(identity.userAgent)
    && !ALTERNATE_IOS_BROWSER.test(identity.userAgent)
}

/**
 * 修复 Safari 过期的原生 textarea 布局，以及它可能污染的滚动区自动高度。
 * @param input - 自身可滚动溢出必须保持为零的编辑器 textarea。
 */
export function repairSafariTextareaLayout(input: HTMLTextAreaElement | null): void {
  if (input === null || input.scrollHeight <= input.clientHeight) return
  const scrollport = input.closest<HTMLElement>('[data-input-scroll]')
  if (scrollport === null) return

  const inputHeight = input.style.height
  input.style.height = `${String(input.clientHeight + 1)}px`
  void input.offsetHeight
  input.style.height = inputHeight
  void input.offsetHeight

  const scrollportHeight = scrollport.style.height
  scrollport.style.height = `${String(scrollport.clientHeight + 1)}px`
  void scrollport.offsetHeight
  scrollport.style.height = scrollportHeight
  void scrollport.offsetHeight
}
