/**
 * 为支持 Scope 的注册表提供共享的插入顺序存储与 Effect 所有权。保存一份全局层和若干按
 * Scope Key 区分的覆盖层；读取时沿父链合并，写入时按调用 Context 自动选择所属层。
 *
 * @module @deepseek-ai/dsh-scope
 */

import type { Context } from '@deepseek-ai/cordis'
import { scopeChainOf, scopeOf } from './index.ts'
import type { ScopeKey } from './index.ts'

/** One scope's aggregate contribution to a registry. */
export interface ScopeLayer {
  /** Whether every table in this layer is empty. */
  isEmpty(): boolean
}

/** Internal common read contract for the two entry-table implementations. */
interface EntryValues<V> {
  values(): IterableIterator<V>
  isEmpty(): boolean
}

/**
 * Insertion-ordered named entries with caller-owned duplicate diagnostics.
 *
 * Values are borrowed. Iterators are live within one nonempty table
 * generation; draining the table detaches them from later insertions. Each
 * successful insertion returns an idempotent undo for that exact entry.
 */
export class NamedEntries<V> implements EntryValues<V> {
  private data = new Map<string, V>()

  constructor(
    private readonly duplicateError: (name: string) => Error,
  ) {}

  /**
   * Insert one unique name.
   * @param name - name unique within this table.
   * @param value - borrowed value to retain.
   * @returns an idempotent undo that removes only this insertion.
   */
  insert(name: string, value: V): () => void {
    const data = this.data
    if (data.has(name)) throw this.duplicateError(name)
    data.set(name, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(name)
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * Read one named value.
   * @param name - name to resolve.
   * @returns the retained value, or `undefined` when absent.
   */
  get(name: string): V | undefined {
    return this.data.get(name)
  }

  /**
   * Test one name for membership.
   * @param name - name to test.
   * @returns whether the table contains that name.
   */
  has(name: string): boolean {
    return this.data.has(name)
  }

  /**
   * Iterate live names in insertion order.
   * @returns the native live key iterator.
   */
  keys(): IterableIterator<string> {
    return this.data.keys()
  }

  /**
   * Iterate live entries in insertion order.
   * @returns the native live entry iterator.
   */
  entries(): IterableIterator<[string, V]> {
    return this.data.entries()
  }

  /**
   * Iterate live values in insertion order.
   * @returns the native live value iterator.
   */
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * Test whether this table has no entries.
   * @returns whether the table is empty.
   */
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

/**
 * Insertion-ordered anonymous entries with independent registration identity.
 *
 * Equal values remain separate registrations. Values are borrowed, and
 * iterators are live within one nonempty table generation; draining the table
 * detaches them from later appends.
 */
export class AnonymousEntries<V> implements EntryValues<V> {
  private data = new Map<symbol, V>()

  /**
   * Append one independently owned value.
   * @param value - borrowed value to retain.
   * @returns an idempotent undo for this exact append.
   */
  append(value: V): () => void {
    const data = this.data
    const key = Symbol()
    data.set(key, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(key)
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * Iterate live values in insertion order.
   * @returns the native live value iterator.
   */
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * Test whether this table has no entries.
   * @returns whether the table is empty.
   */
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

/**
 * 管理一个注册表的全局层和精确 Scope 层。读取不会创建 Scope 层；注册同时从传入的 Cordis
 * Context 推导可见性与 Effect 所有权，在通知前取得撤销函数，并且只回收完全为空的聚合层。
 */
export class ScopedLayers<L extends ScopeLayer> {
  /** The eagerly constructed context-global layer. */
  readonly global: L

  private readonly scoped = new Map<ScopeKey, L>()

  constructor(
    private readonly createLayer: (scope: ScopeKey | undefined) => L,
    private readonly onChange: () => void,
  ) {
    this.global = createLayer(undefined)
  }

  /**
   * Read an existing exact-scope overlay. Deliberately chain-blind: callers
   * addressing one scope's OWN contributions (its restrictions, its guards)
   * must not silently pick up an ancestor's — use {@link chainLayers} where
   * inheritance is the point.
   * @param scope - exact scope key; `undefined` denotes no overlay.
   * @returns the existing scoped layer, or `undefined` without creating one.
   */
  peek(scope: ScopeKey | undefined): L | undefined {
    if (scope === undefined) return undefined
    return this.scoped.get(scope)
  }

  /**
   * Existing overlays along the scope's parent chain ({@link scopeChainOf}),
   * farthest ancestor first and the exact scope last, so a caller layering
   * them in order gives the nearest scope the final word.
   * @param scope - viewing scope, or `undefined` for no overlays.
   * @returns the existing layers, nearest last; absent overlays are skipped.
   */
  chainLayers(scope: ScopeKey | undefined): L[] {
    const layers: L[] = []
    for (const key of scopeChainOf(scope).reverse()) {
      const layer = this.scoped.get(key)
      if (layer !== undefined) layers.push(layer)
    }
    return layers
  }

  /**
   * 先物化全局命名条目，再按最远祖先到最近 Scope 的顺序应用覆盖，使最近 Scope 的同名条目胜出。
   * @param scope - 查看结果的 Scope；`undefined` 表示全局视图。
   * @param pick - 从一层中选择命名条目表。
   * @returns 按插入顺序保存的最终 Map。
   */
  merge<V>(
    scope: ScopeKey | undefined,
    pick: (layer: L) => NamedEntries<V>,
  ): Map<string, V> {
    // 先放全局值，再从最远父 Scope 到当前 Scope 覆盖同名项；离 Agent 最近的定义最终胜出。
    const merged = new Map(pick(this.global).entries())
    for (const layer of this.chainLayers(scope)) {
      for (const [name, value] of pick(layer).entries()) merged.set(name, value)
    }
    return merged
  }

  /**
   * 把一次同步分层修改绑定到注册它的 Context。
   * @param ctx - 同时决定 Scope 可见性和 Effect 所有权的 Context。
   * @param action - 原子修改操作，并返回同步撤销函数。
   * @param options - Cordis Effect 标签以及是否发送变化通知。
   * @returns `ctx.effect()` 返回的原始 disposer。
   */
  effect(
    ctx: Context,
    action: (layer: L) => () => void,
    options: { label: string; notify?: boolean },
  ): () => void {
    // 注册与撤销在同一个 Effect 中完成：撤销最后一个条目时删除空层，并发出一次变更通知。
    const scope = scopeOf(ctx)
    const notify = options.notify ?? true
    const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
      let layer: L
      let created = false
      if (scope === undefined) {
        layer = this.global
      } else {
        const existing = this.scoped.get(scope)
        if (existing === undefined) {
          layer = this.createLayer(scope)
          this.scoped.set(scope, layer)
          created = true
        } else {
          layer = existing
        }
      }

      let undo: () => void
      try {
        undo = action(layer)
      } catch (error) {
        if (scope !== undefined && created && layer.isEmpty()) this.scoped.delete(scope)
        throw error
      }

      yield () => {
        undo()
        if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
        if (notify) this.onChange()
      }
      if (notify) this.onChange()
    }.bind(this), options.label)
    // oxlint-disable-next-line typescript/no-misused-promises -- exact synchronous disposer preserves Cordis effect identity
    return dispose
  }
}
