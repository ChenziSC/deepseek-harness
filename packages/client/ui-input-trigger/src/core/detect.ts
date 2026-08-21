/**
 * 触发检测的纯核心。它从光标位置反向扫描当前保护级别下有效的触发字符，
 * 并应用词边界规则；不依赖 React、DOM 或 Cordis。
 */
import { activeAtToken } from '@deepseek-ai/dsh-file-reference/grammar'
import type { TriggerChar } from '../types.ts'
import type { DetectTrigger } from './contract.ts'

const WORD_CHAR = /[\p{L}\p{N}_]/u
const WHITESPACE = /\s/u

/**
 * 词边界规则：触发字符只能出现在草稿开头、空白（包括换行）之后或标点之后。
 * 另有两个 URL 例外，确保 URL 内的 '/' 不生效（均由测试固定）：一是 ':' 前
 * 还有非空白字符时紧随其后的 '/'（协议分隔符，如 `https:/…`），二是直接跟在
 * 另一个 '/' 后的 '/'（`//` 的第二个斜杠）。
 */
function boundaryOk(draft: string, index: number, char: TriggerChar): boolean {
  if (index === 0) return true
  const prev = draft.charAt(index - 1)
  if (WHITESPACE.test(prev)) return true
  if (WORD_CHAR.test(prev)) return false
  if (char === '/') {
    if (prev === '/') return false
    if (prev === ':' && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false
  }
  return true
}

/**
 * 检测光标处的触发词元。`@` 首先使用共享语法，包括可跨越空白、尚未闭合引号
 * 的词元。斜杠检测向左扫描到首个空白；不满足词边界的斜杠会被视为普通词元字符，
 * 并继续扫描（用于 URL 斜杠）。保护级别：plain 表示两种字符均有效；claimed
 * 完全禁用 '/' 而保留 '@'；frozen 表示全部禁用。
 *
 * @param draft - 完整草稿文本。
 * @param caret - 光标在 `draft` 中的偏移量。
 * @param guard - 根据输入阶段推导出的可用级别。
 * @returns 命中结果，其中 `query` 是触发字符到光标之间的切片，`span` 为
 * `{start: triggerIndex, end: caret}`；`span.draftRev` 暂以 `0` 占位，调用外壳
 * 会写入真实修订号。光标处没有有效触发器时返回 null。
 */
export const detectTrigger: DetectTrigger = (draft, caret, guard) => {
  if (guard.tier === 'frozen') return null
  const at = activeAtToken(draft, caret)
  if (at !== undefined) {
    const start = caret - at.prefix.length
    return {
      trigger: '@',
      query: at.query,
      quoted: at.quoted,
      position: draft.search(/\S/) === start ? 'leading' : 'inline',
      span: { start, end: caret, draftRev: 0 },
    }
  }
  for (let i = caret - 1; i >= 0; i--) {
    const ch = draft.charAt(i)
    if (WHITESPACE.test(ch)) return null
    if (ch !== '/') continue
    if (guard.tier === 'claimed') continue
    if (!boundaryOk(draft, i, ch)) continue
    return {
      trigger: ch,
      query: draft.slice(i + 1, caret),
      quoted: false,
      position: draft.search(/\S/) === i ? 'leading' : 'inline',
      span: { start: i, end: caret, draftRev: 0 },
    }
  }
  return null
}
