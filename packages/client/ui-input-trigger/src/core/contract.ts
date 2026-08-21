/**
 * 冻结的纯核心约定：只描述触发检测与菜单归约，不依赖 React、DOM 或 Cordis。
 * 此处只有类型；实现位于使用这些别名标注的同级模块，服务外壳负责把它们接入 ctx。
 */
import type { InputTriggerCandidate, TokenSpan, TriggerChar, TriggerGuard, TriggerPosition } from '../types.ts'

/** 在光标下检测到的触发词元。 */
export interface TriggerHit {
  readonly trigger: TriggerChar
  /** 触发字符与光标之间的文本，用于实时筛选。 */
  readonly query: string
  /** 仅在 `@file` 词元的引号尚未闭合时为 true。 */
  readonly quoted: boolean
  /** leading 表示去除空白（包括换行）后的草稿以该词元开头。 */
  readonly position: TriggerPosition
  /** 词元区间；draftRev 由调用方注入。 */
  readonly span: TokenSpan
}

/**
 * 在给定保护级别下检测光标处的触发词元。`@` 使用共享的文件引用起始/空白语法；
 * `/` 接受标点边界，但会排除 URL。`user@host` 和 URL 中的 `/` 都不会触发。
 * 光标处没有有效触发器时返回 null。
 */
export type DetectTrigger = (draft: string, caret: number, guard: TriggerGuard) => TriggerHit | null

/** 菜单状态：每个来源对应一组；全部就绪组为空时自动关闭菜单。 */
export interface MenuState {
  readonly open: boolean
  readonly hit: TriggerHit | null
  /** 每次命中的单调递增代次；过期的来源完成结果会被丢弃。 */
  readonly generation: number
  readonly groups: readonly {
    readonly source: string
    /** 候选分段行已经承担全部可见分组标签时为 false。 */
    readonly showGroupTitle?: boolean
    readonly status: 'pending' | 'ready'
    readonly items: readonly InputTriggerCandidate[]
  }[]
  readonly highlight: { readonly source: string; readonly index: number } | null
}

/** 菜单归约事件。来源失败时静默移除分组，只记录日志，不增加错误 UI 层。 */
export type MenuEvent =
  | { readonly type: 'hit'; readonly hit: TriggerHit | null }
  | { readonly type: 'source-settled'; readonly generation: number; readonly source: string; readonly items?: readonly InputTriggerCandidate[] }
  | { readonly type: 'source-failed'; readonly generation: number; readonly source: string }
  | { readonly type: 'move'; readonly dir: 1 | -1 }
  | { readonly type: 'close' }

/** 纯菜单归约器；事件过期或不产生变化时返回原引用。 */
export type MenuReduce = (state: MenuState, ev: MenuEvent) => MenuState

/**
 * 在某个来源的已就绪分组中按名称精确查找；不存在或分组尚未就绪时返回 null。
 */
export type ExactMatch = (groups: MenuState['groups'], source: string, name: string) => InputTriggerCandidate | null
