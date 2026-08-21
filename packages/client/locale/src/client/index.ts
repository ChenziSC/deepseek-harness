/**
 * Browser-side locale registry. Bound translation functions retain stable
 * identity for injected consumers. The plugin also registers the Language
 * preference row into the settings General section — the locale feature owns
 * its own settings surface.
 */
/* oxlint-disable typescript/no-redundant-type-constituents --
 * `keyof LocaleNamespaceMap & string` is the declare-merge key pattern (see
 * ui-slots): in THIS unit the map holds only this package's own merges, but
 * consumers merge more namespaces in and the intersection keeps them
 * string-typed. The rule fires on the narrow-map view, not real redundancy. */
import type { Context } from '@deepseek-ai/cordis'
import {
  type BoundActions, type LocaleDictOf, type LocaleNamespaceMap, type Translate, type TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.settingsScope Context merge and the settings slot types.
// Cross-plugin collaboration goes through the service, never a value import
// (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  LOCALE_PREFERENCE_FIELD, LOCALE_SETTINGS_NAMESPACE, type LocaleId, type LocaleSettings,
} from '../locale-settings.ts'
import { en, zh, type CommonKey } from '../locales/index.ts'
import {
  en as settingsEn, zh as settingsZh, type SettingsLocaleKey,
} from '../locales/settings.ts'
import type { LanguageRowInjected } from './LanguageRow.tsx'
import { LanguageRow } from './LanguageRow.tsx'
import { createLanguageRowStore } from './settings-store.ts'

export type { LanguageRowComponentProps, LanguageRowInjected } from './LanguageRow.tsx'
export type { LanguageOptionRow, LanguageRowState } from './settings-store.ts'
export type { CommonKey } from '../locales/index.ts'
export type { LocaleId, LocaleSettings } from '../locale-settings.ts'

// The translate currency lives in ui-slots (the render machinery synthesizes
// the seat); re-exported here so dictionary owners import one package.
// TranslateNS<'model'> is the namespace-addressed developer-facing form.
export type { Translate, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shared cross-feature vocabulary, consulted by the lookup chain after the entry's own namespace misses. */
    common: CommonKey
    /** This feature's own settings-row copy (the Language row). */
    'settings.locale': SettingsLocaleKey
  }
}

/** Locale dictionary: flat key to template string ({name} placeholders). */
export type LocaleDict = Record<string, string>

/** One selectable locale: id plus its self-described display name. */
export interface LocaleDefinition {
  /** Locale id (persisted; the setLocale argument). */
  id: LocaleId
  /** Display name in its own language (中文 / English). */
  label: string
}

/** Immutable locale state published on every change. */
export interface LocaleSnapshot {
  /** Active locale id. */
  active: LocaleId
  /** Selectable locales in display order. */
  locales: readonly LocaleDefinition[]
  /** Monotonic change counter (registry or active changes). */
  revision: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    locale: LocaleRuntime
  }
  interface Events {
    /**
     * 活动 locale 已切换。注册词典不会发出本事件，因为 listener 可能据此重新注册 Slot，
     * 而启动时每个包都会注册一个 namespace；连续渲染刷新改由 LocaleFace revision 驱动。
     * @param snapshot - 当前不可变 locale 快照。
     * @mode emit
     */
    'locale/change'(snapshot: LocaleSnapshot): void
  }
}

/**
 * 浏览器未指定已随附语言时（以及非浏览器运行时），UI 以英语启动；活动 locale 缺少某个键时
 * 也查询英语词典。两项职责共用一个常量，因为随附的 `zh`/`en` 词典具有相同键集合，双向
 * 回退都不会遗留未解析键。最后仍回退到英语而非中文，是因为浏览器未声明任一随附语言时，
 * 读者最不可能理解中文。
 */
export const FALLBACK_LOCALE: LocaleId = 'en'

/** Shared namespace for shell-level texts. */
export const COMMON_NS = 'common'

/** Namespace owning this feature's settings-row copy. */
export const SETTINGS_NS = 'settings.locale'

/** The two shipped locales. */
const LOCALES: readonly LocaleDefinition[] = Object.freeze([
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
])

/**
 * 每个随附 locale 对应的 `<html lang>` tag。Locale id 是 App 自有词汇（primary subtag），
 * 文档属性则需要 BCP 47 tag；辅助技术和浏览器功能会读取它来选择发音规则、翻译建议、字体
 * fallback 与拼写检查行为。仅写 `zh` 无法确定书写系统，因此随附中文文案明确标注实际变体。
 */
const DOCUMENT_LANGUAGE: Record<LocaleId, string> = { zh: 'zh-CN', en: 'en' }

/**
 * 让 `<html lang>` 指向活动 locale。每次 locale 变化时调用，使该属性跟随 UI，而不是停留
 * 在 Server 返回的 markup 初始声明值。
 * @param active - 活动 locale id。
 */
function syncDocumentLanguage(active: LocaleId): void {
  // 非浏览器运行（在 Node 中启动客户端 tree）没有 document。
  if (typeof document === 'undefined') return
  document.documentElement.lang = DOCUMENT_LANGUAGE[active]
}

/**
 * 词典注册表与 locale 偏好设置。每个键的查找链为：活动 locale 中条目所属 namespace →
 * 该 namespace 的英语 fallback → 共享 common namespace（先活动 locale，再英语）→ 键本身。
 * 缺失文本保持可见，让 UI 明确失败而不是显示空白。读取经 {@link getLocale}，写入只经
 * {@link setLocale}；持续同步经 `locale/change` 事件，或渲染机制消费的 LocaleFace
 * getSnapshot/subscribe 对（由 `ctx.slots.installLocale` 安装）。
 */
export class LocaleRuntime {
  private dicts = new Map<string, Map<string, LocaleDict>>()
  private bound = new Map<string, Translate>()
  private snapshot: LocaleSnapshot
  private listeners = new Set<() => void>()
  private readonly ctx: Context
  private readonly host: SettingsScope<LocaleSettings> | undefined
  /** 没有显式 Host 选择时使用的浏览器派生 locale。 */
  private readonly provisional: LocaleId

  /**
   * @param ctx - 所有者 Context；变化事件在此发出，释放时通过 ctx.effect 移除 scope listener。
   * @param host - 提供方插件拥有的持久化偏好 scope；缺省该组合时（独立词典注册表）只保留
   * 进程内状态。
   */
  constructor(ctx: Context, host?: SettingsScope<LocaleSettings>) {
    this.ctx = ctx
    this.host = host
    this.provisional = resolveInitialLocale()
    this.snapshot = Object.freeze({ active: this.provisional, locales: LOCALES, revision: 0 })
    if (host !== undefined) {
      ctx.effect(() => host.subscribe(() => { this.adopt(host) }), 'locale: settings scope adoption')
      this.adopt(host)
    }
  }

  /**
   * Read the current immutable locale snapshot.
   * @returns the current snapshot (stable reference until the next change).
   */
  getLocale(): LocaleSnapshot {
    return this.snapshot
  }

  /**
   * LocaleFace getSnapshot: the current snapshot (carries `revision`; stable
   * reference between changes, uSES-safe).
   * @returns the current snapshot.
   */
  getSnapshot(): LocaleSnapshot {
    return this.snapshot
  }

  /**
   * LocaleFace subscribe: notified on every snapshot change (locale switch
   * or dictionary registration — registrations bump the revision so already
   * rendered outlets pick up late-arriving dictionaries).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /**
   * 切换活动 locale；这是唯一的用户偏好写入入口。
   *
   * 即使 id 已与活动 locale 一致，也要执行持久化写入，因为活动值可能只是浏览器派生或
   * fallback 得到的临时选择，尚未被保存。再次选择屏幕上已有的语言仍是显式决定，必须能在
   * 共享同一 DSH Home 的其他浏览器中延续。只有渲染通知是条件性的：重新发布未变化的
   * locale 只会无意义地触发所有订阅方。
   * @param id - 已注册的 locale id；未知 id 会抛错。
   */
  setLocale(id: string): void {
    const match = this.snapshot.locales.find(l => l.id === id)
    if (match === undefined) throw new Error(`locale "${id}" is not registered`)
    if (this.snapshot.active !== match.id) this.publish(match.id, true)
    void this.host?.set(LOCALE_PREFERENCE_FIELD, match.id)
  }

  /**
   * Adopt the scope's accepted durable selection without writing it back; an
   * absent selection returns to the browser-derived locale.
   * @param host - the constructor-narrowed scope driving this adoption.
   */
  private adopt(host: SettingsScope<LocaleSettings>): void {
    const section = host.getSnapshot().value
    if (section === undefined) return
    const target = section.preference ?? this.provisional
    if (this.snapshot.active === target) return
    this.publish(target, true)
  }

  /**
   * Register a declared namespace's dictionaries, all locales in one call —
   * the typed form: each dictionary is checked against the namespace's
   * {@link LocaleNamespaceMap} key union (a missing or extra key is a
   * compile error), and every shipped locale is required (bilingual balance
   * enforced at registration). Duplicate (ns, locale) throws (single occupant; a
   * namespace's texts have one owner). Registration bumps the revision so
   * mounted outlets pick up late-arriving dictionaries.
   * @param ns - a namespace merged into LocaleNamespaceMap.
   * @param dicts - complete dictionaries keyed by locale id.
   * @returns disposer removing every locale registered by this call (idempotent).
   */
  register<N extends keyof LocaleNamespaceMap & string>(ns: N, dicts: Record<LocaleId, LocaleDictOf<N>>): () => void
  /**
   * Single-locale untyped form for namespaces outside the merge table
   * (dynamic composition, tests).
   * @param ns - namespace.
   * @param locale - locale tag.
   * @param dict - dictionary.
   * @returns disposer (idempotent).
   */
  register(ns: string, locale: string, dict: LocaleDict): () => void
  register(ns: string, localeOrDicts: string | Record<string, LocaleDict>, dict?: LocaleDict): () => void {
    const pairs: [string, LocaleDict][] = typeof localeOrDicts === 'string'
      // Overload guarantees dict on the single-locale arm.
      ? [[localeOrDicts, dict as LocaleDict]]
      : Object.entries(localeOrDicts)
    let locales = this.dicts.get(ns)
    if (!locales) {
      locales = new Map()
      this.dicts.set(ns, locales)
    }
    for (const [locale] of pairs) {
      if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
    }
    for (const [locale, entries] of pairs) locales.set(locale, entries)
    this.publish(this.snapshot.active, false)
    return () => {
      const owner = this.dicts.get(ns)
      /* v8 ignore next -- defensive: a namespace's locales map is created on
       * first register and never removed, so the disposer always finds it. */
      if (!owner) return
      let removed = false
      for (const [locale, entries] of pairs) {
        if (owner.get(locale) === entries) {
          owner.delete(locale)
          removed = true
        }
      }
      if (removed) this.publish(this.snapshot.active, false)
    }
  }

  /**
   * Bind a declared namespace to a translate function typed to its
   * dictionary key union (plus the shared common vocabulary) — the same key
   * domain the framework-injected `t` seat carries. The returned reference
   * is stable per namespace (repeat binds return the same function), so it
   * can ride inject surfaces without breaking memoization.
   * @param ns - a namespace merged into LocaleNamespaceMap.
   * @returns the typed translate function (reads the active locale at call time).
   */
  bind<N extends keyof LocaleNamespaceMap & string>(ns: N): TranslateNS<N>
  /**
   * Untyped form for namespaces outside the merge table (dynamic
   * composition, tests).
   * @param ns - namespace.
   * @returns the translate function.
   */
  bind(ns: string): Translate
  bind(ns: string): Translate {
    let t = this.bound.get(ns)
    if (!t) {
      t = (key, params) => this.translate(ns, key, params)
      this.bound.set(ns, t)
      return t
    }
    return t
  }

  private translate(ns: string, key: string, params?: Record<string, unknown>): string {
    const template = this.lookup(ns, key)
      ?? (ns !== COMMON_NS ? this.lookup(COMMON_NS, key) : undefined)
      ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }

  private lookup(ns: string, key: string): string | undefined {
    const locales = this.dicts.get(ns)
    return locales?.get(this.snapshot.active)?.[key] ?? locales?.get(FALLBACK_LOCALE)?.[key]
  }

  /**
   * Advance the snapshot revision and notify LocaleFace subscribers (render
   * refresh). Only an active-locale switch additionally emits
   * `locale/change` — dictionary registrations stay off the event so
   * registration-heavy boot cannot storm event listeners (which may
   * re-register slots in response).
   */
  private publish(active: LocaleId, localeChanged: boolean): void {
    this.snapshot = Object.freeze({
      active,
      locales: this.snapshot.locales,
      revision: this.snapshot.revision + 1,
    })
    if (localeChanged) this.ctx.emit('locale/change', this.snapshot)
    for (const fn of [...this.listeners]) {
      try {
        fn()
      } catch (error) {
        // One throwing subscriber must not strand the rest on a stale
        // revision (outlets would keep the previous language).
        console.error('locale subscriber crashed:', error)
      }
    }
  }
}

/**
 * The browser's own language wins over {@link FALLBACK_LOCALE}; an explicit
 * Host preference may replace this provisional value after plugin activation.
 */
function resolveInitialLocale(): LocaleId {
  return detectBrowserLocale() ?? FALLBACK_LOCALE
}

/**
 * The first shipped locale the browser asks for, matched on the primary
 * subtag so every regional variant lands on its language (`zh-Hans-CN` -> zh,
 * `en-GB` -> en). `window` is the browser test, not `navigator`: Node exposes
 * a global `navigator` reporting the machine's own language, which would
 * otherwise decide the locale for non-browser runs (node e2e booting the
 * client tree). `navigator.language` trails the ordered `languages` list and
 * covers its absence on hosts that expose only the single tag.
 */
function detectBrowserLocale(): LocaleId | undefined {
  if (typeof window === 'undefined') return undefined
  /* oxlint-disable-next-line typescript/no-unnecessary-condition --
   * The DOM lib types `languages` as always present; embedders and older
   * WebViews ship a Navigator without it, and spreading undefined would
   * throw at boot. */
  for (const tag of [...(navigator.languages ?? []), navigator.language]) {
    const primary = tag.toLowerCase().split('-')[0]
    const match = LOCALES.find(locale => locale.id === primary)
    if (match) return match.id
  }
  return undefined
}

/** Required services: slot registration plus the settings transport. */
export const inject = ['slots', 'connection', 'remote', 'settingsScope']

/**
 * Client plugin body: provide the locale service with base dictionaries and
 * register the feature-owned Language preference row into the General
 * section's item slot (a feature owns its settings surface).
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  const host = ctx.settingsScope.bind<LocaleSettings>({ namespace: LOCALE_SETTINGS_NAMESPACE })
  const locale = new LocaleRuntime(ctx, host)
  locale.register(COMMON_NS, { zh, en })
  locale.register(SETTINGS_NS, { zh: settingsZh, en: settingsEn })
  ctx.provide('locale', locale)
  // 本服务就是 LocaleFace（bind + getSnapshot/subscribe）；安装后，渲染机制才能合成标准
  // `t` seat。
  ctx.slots.installLocale(locale)

  const store = createLanguageRowStore()
  let bound: BoundActions<typeof store> | undefined
  const sync = (snapshot: LocaleSnapshot): void => {
    syncDocumentLanguage(snapshot.active)
    bound?.sync(
      snapshot.active,
      snapshot.locales.map(l => ({ id: l.id, label: l.label })),
      snapshot.revision,
    )
  }
  ctx.on('locale/change', sync)
  // Server 返回的 markup 只声明一种语言，解析后的 locale 可能不同，例如浏览器探测结果，
  // 或激活后采用的已保存偏好。因此在激活时立即设置一次，不等待首次变化。
  syncDocumentLanguage(locale.getLocale().active)
  const injected = (actions: BoundActions<typeof store>): LanguageRowInjected => {
    bound = actions
    // 从 getter 重新同步，避免注册与首次渲染之间丢失事件；store 的 revision guard 会丢弃
    // 陈旧重复项。
    sync(locale.getLocale())
    return {
      setLocale: (id) => { locale.setLocale(id) },
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'language',
    order: 0,
    store,
    locale: SETTINGS_NS,
    inject: injected,
  }, LanguageRow))
}
