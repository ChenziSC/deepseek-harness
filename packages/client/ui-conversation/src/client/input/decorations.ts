/**
 * 草稿装饰的纯核心：引用根据实例区间渲染；认领词元在镜像层高亮，认领提示显示为
 * 幽灵文本。不依赖 React；骨架层负责渲染这些指令，测试可直接驱动此模块。
 */
import type { InputState } from './contract.ts'

/** 认领词元的高亮区间；前缀监视成立时始终位于草稿开头。 */
export interface TokenRange {
  readonly start: number
  readonly end: number
}

/** 一条结构化行内引用渲染指令。 */
export interface ChipRender {
  /** 稳定渲染键；同标签胶囊仍彼此独立。 */
  readonly occurrenceId: number
  /** 展示文本在草稿中的偏移量。 */
  readonly offset: number
  /** 展示文本在草稿中的长度。 */
  readonly length: number
  /** 精确的行内文本；布局由其原生字形度量决定。 */
  readonly text: string
  readonly label: string
  /** 标签旁的可选领域图标。 */
  readonly appearance?: 'session' | 'file' | 'folder'
  /** 拥有者解析失败的样式位。 */
  readonly invalid: boolean
}

/**
 * 一个纯文本引用区间（决策见
 * .agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md）：
 * 名称存在于触发器词典中的 `/name` 或 `@name` 词元。它是纯派生结果；把文本
 * 编辑到不再匹配后，下一次扫描会直接移除该区间。
 */
export interface TextRefRange {
  readonly start: number
  readonly end: number
  readonly trigger: '/' | '@'
  /** 语法可识别纯文本引用的可选图标领域。 */
  readonly appearance?: 'folder'
}

/** 装饰结果：认领词元区间、胶囊指令、文本引用区间和幽灵提示。 */
export interface DraftDecorations {
  /** claimed/submitting 且前缀监视成立时的认领词元区间，否则为 null。 */
  readonly token: TokenRange | null
  /** 按草稿顺序排列的胶囊渲染指令；实例表已按偏移量排序。 */
  readonly chips: readonly ChipRender[]
  /** 扫描派生的词典词元和语法可识别文件夹区间。 */
  readonly textRefs: readonly TextRefRange[]
  /** 认领参数为空时显示的幽灵提示，否则为 null。 */
  readonly hint: string | null
}

/** 词元匹配器：行首或空白后的触发字符，再接近似单词的名称，绝不跨越换行。 */
const TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g
const FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g

/**
 * 使用热词典扫描草稿中的纯文本引用词元。词边界规则：触发字符必须位于草稿开头
 * 或空白之后（'x/name' 永不匹配），名称必须是词典中的精确成员。
 * @param draft - 草稿文本。
 * @param lexicon - 每个触发字符对应的名称列表；缺少触发字符时不扫描。
 * @returns 按草稿顺序排列的匹配区间。
 */
export function scanTextRefs(
  draft: string, lexicon: ReadonlyMap<'/' | '@', readonly string[]>,
): TextRefRange[] {
  if (draft === '') return []
  const out: TextRefRange[] = []
  if (lexicon.size > 0) {
    TEXT_REF_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TEXT_REF_RE.exec(draft)) !== null) {
      const trigger = m[2] as '/' | '@'
      const name = m[3] ?? ''
      if (lexicon.get(trigger)?.includes(name)) {
        const start = m.index + (m[1]?.length ?? 0)
        out.push({ start, end: start + 1 + name.length, trigger })
      }
    }
  }
  FOLDER_REF_RE.lastIndex = 0
  let folder: RegExpExecArray | null
  while ((folder = FOLDER_REF_RE.exec(draft)) !== null) {
    const token = folder[2] ?? ''
    const start = folder.index + (folder[1]?.length ?? 0)
    const end = start + token.length
    if (!out.some(range => range.start < end && range.end > start)) {
      out.push({ start, end, trigger: '@', appearance: 'folder' })
    }
  }
  return out.sort((left, right) => left.start - right.start)
}

/** 空词典；默认不产生文本引用装饰，并保持旧调用点行为不变。 */
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

/**
 * 从输入状态派生镜像层装饰。
 * @param state - 已发布的输入状态。
 * @param lexicon - 可选的每触发字符引用词典，用于纯文本引用扫描。
 * @returns 词元区间、胶囊指令、文本引用区间和幽灵提示。
 */
export function deriveDecorations(
  state: InputState, lexicon: ReadonlyMap<'/' | '@', readonly string[]> = EMPTY_LEXICON,
): DraftDecorations {
  const { draft, claim, phase, occurrences } = state
  const claimActive = (phase === 'claimed' || phase === 'submitting')
    && claim !== undefined && draft.startsWith(claim.token)
  const token: TokenRange | null = claimActive ? { start: 0, end: claim.token.length } : null
  const chips = occurrences.map(o => ({
    occurrenceId: o.occurrenceId,
    offset: o.offset,
    length: o.length,
    text: draft.slice(o.offset, o.offset + o.length),
    label: o.label,
    ...o.appearance === undefined ? {} : { appearance: o.appearance },
    invalid: o.invalid === true,
  }))
  const hint = claimActive && claim.hint !== undefined && draft.slice(claim.token.length).trim() === ''
    ? claim.hint
    : null
  return { token, chips, textRefs: scanTextRefs(draft, lexicon), hint }
}
