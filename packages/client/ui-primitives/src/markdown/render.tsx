/**
 * Direct mdast→React markdown renderer. Replaces the react-markdown /
 * remark-rehype pipeline with one switch over parsed nodes so streaming can
 * cache frozen blocks as React elements; the rendered DOM is pinned
 * byte-for-byte by `tests/fixtures/markdown-dom` and must not drift.
 *
 * Untrusted-output policy (unchanged from the replaced pipeline): link and
 * image destinations pass a protocol allowlist, images additionally require
 * absolute HTTP(S), raw HTML renders as literal text (no HTML enters the
 * DOM), and KaTeX runs without trusted commands. Fragment-anchor URLs fail
 * the allowlist, so footnote references and back-references render as plain
 * text rather than in-page links.
 *
 * Merge-extensible node unions fall through the documented default (render
 * nothing) rather than ending in assertNever: grammars registered elsewhere
 * may add node types this renderer has no mapping for.
 */

import { Fragment, createElement } from 'react'
import type { Key, ReactNode } from 'react'
import clsx from 'clsx'
import type * as Md from 'mdast'
import type {} from 'mdast-util-math'
import { normalizeUri } from 'micromark-util-sanitize-uri'
import { CodeBlock } from './CodeBlock.tsx'
import { renderTexToReact } from './katex.tsx'
import type { PositionedBlock } from './incremental.ts'
import css from './MarkdownText.module.css'

/** Copy-button labels forwarded to fence CodeBlocks (this package is cordis-free, so copy arrives via props). */
export interface MarkdownCodeLabels {
  /** Copy-button idle label. */
  copyLabel?: string | undefined
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel?: string | undefined
}

function sanitizeUrl(url: string): string {
  try {
    switch (new URL(url).protocol) {
      case 'http:':
      case 'https:':
      case 'mailto:':
        return url
      default:
        return ''
    }
  } catch {
    // Relative and otherwise unparsable destinations are disallowed alongside
    // disallowed protocols; new URL() has no other failure mode for strings.
    return ''
  }
}

function remoteImageUrl(url: string): string | undefined {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    // Same single failure mode as above: not an absolute URL.
    return undefined
  }
}

/** Link/image reference targets collected from a document (first definition per identifier wins, as in CommonMark). */
export interface ReferenceTargets {
  /** Link/image definitions keyed by upper-cased identifier. */
  definitions: Map<string, Md.Definition>
  /** Footnote definitions keyed by upper-cased identifier. */
  footnotes: Map<string, Md.FootnoteDefinition>
}

/**
 * Create an empty {@link ReferenceTargets}.
 * @returns Fresh empty maps.
 */
export function createReferenceTargets(): ReferenceTargets {
  return { definitions: new Map(), footnotes: new Map() }
}

/**
 * Record every definition and footnote definition under `nodes` into
 * `targets`, depth-first, keeping the first definition per identifier.
 * @param nodes - Subtrees to walk (top-level blocks or any nested children).
 * @param targets - Accumulator, typically shared across incremental segments.
 */
export function collectReferenceTargets(
  nodes: readonly Md.RootContent[],
  targets: ReferenceTargets,
): void {
  for (const node of nodes) {
    if (node.type === 'definition') {
      const id = node.identifier.toUpperCase()
      if (!targets.definitions.has(id)) targets.definitions.set(id, node)
    } else if (node.type === 'footnoteDefinition') {
      const id = node.identifier.toUpperCase()
      if (!targets.footnotes.has(id)) targets.footnotes.set(id, node)
    }
    if ('children' in node) collectReferenceTargets(node.children, targets)
  }
}

/**
 * 行内代码的文件提及能力：拥有者使用自身真实文件词表，把作者写下的词元解析为
 * 所指文件；渲染器绝不猜测看起来像路径的内容。
 */
export interface MarkdownFileMentions {
  /**
   * 解析一个行内代码词元。
   * @param value - 作者原样写下的词元。
   * @returns 带无障碍标签和完整路径标题的打开器；词元不指向已知文件时为
   * undefined，此时保持为不可交互代码。
   */
  resolve(value: string): { open: () => void; label: string; title: string } | undefined
}

/**
 * 一次渲染 pass 的状态：不可变选项和目标，以及引用渲染时按文档顺序累积的脚注编号。
 */
export interface MarkdownRenderContext {
  /** 流式分支：围栏按纯文本渲染，TeX 保持字面形式。 */
  readonly streaming: boolean
  /** 本地化的围栏复制按钮标签。 */
  readonly codeLabels: MarkdownCodeLabels | undefined
  /** 是否位于 blockquote 子级内；其中表格始终填满引用宽度。 */
  readonly inBlockquote?: boolean
  /** 行内代码文件提及；没有打开器词表时缺失。 */
  readonly fileMentions: MarkdownFileMentions | undefined
  /** 是否位于 anchor 子级内；其中不得嵌套可交互提及。 */
  readonly inLink?: boolean
  /** 本次 pass 可见的引用目标。 */
  readonly targets: ReferenceTargets
  /** 按首次引用顺序排列的脚注标识；脚注编号是其从 1 开始的索引。 */
  readonly footnoteOrder: string[]
  /** 每个标识已渲染的引用数，用于决定章节反向引用数量。 */
  readonly footnoteCounts: Map<string, number>
}

/**
 * 渲染顶层块。不产生内容的节点（定义、未映射类型）会被丢弃，而不是保留 null
 * 占位，以匹配被替换流水线的子列表，使分隔换行位置完全一致。
 * @param blocks - 带流式稳定渲染键的块。
 * @param context - 本次 pass 状态；脚注编号按文档顺序变更。
 * @returns 每个已渲染块对应一个 React 节点。
 */
export function renderBlocks(
  blocks: readonly PositionedBlock[],
  context: MarkdownRenderContext,
): ReactNode[] {
  return blocks
    .map(block => renderNode(block.node, block.key, context))
    .filter(element => element !== null)
}

/**
 * 在块级子项间交错插入被替换流水线曾生成的换行文本节点。它们在元素之间不可见，
 * 但会与相邻字面 raw-HTML 文本合并；DOM 等价 fixture 固定了这一行为。
 * @param elements - 已丢弃空渲染结果的块级子项。
 * @param edges - 是否同时生成首尾换行，即 hast 的宽松包装。
 * @returns 交错后的子项。
 */
export function wrapBlockChildren(elements: readonly ReactNode[], edges: boolean): ReactNode[] {
  const wrapped: ReactNode[] = []
  for (const element of elements) {
    if (edges || wrapped.length > 0) wrapped.push('\n')
    wrapped.push(element)
  }
  if (edges && elements.length > 0) wrapped.push('\n')
  return wrapped
}

/**
 * 为必须区分段落与其他块的父级渲染的块子项。紧凑列表项会解包段落；脚注正文则把
 * 反向引用放进末尾段落。
 */
type BlockEntry = { paragraph: ReactNode[] } | { element: ReactNode }

/** 把容器子项渲染为 {@link BlockEntry} 值，并丢弃空渲染结果。 */
function renderBlockEntries(
  blocks: readonly Md.RootContent[],
  context: MarkdownRenderContext,
): BlockEntry[] {
  const entries: BlockEntry[] = []
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'paragraph') {
      entries.push({ paragraph: renderChildren(block.children, context) })
    } else {
      const element = renderNode(block, index, context)
      if (element !== null) entries.push({ element })
    }
  }
  return entries
}

function renderChildren(
  nodes: readonly Md.RootContent[],
  context: MarkdownRenderContext,
): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, index, context))
}

function renderNode(node: Md.RootContent, key: Key, context: MarkdownRenderContext): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value
    case 'paragraph':
      return <p key={key}>{renderChildren(node.children, context)}</p>
    case 'heading':
      return createElement(`h${node.depth}`, { key }, ...renderChildren(node.children, context))
    case 'blockquote':
      return (
        <blockquote key={key}>
          {wrapBlockChildren(
            renderChildren(node.children, { ...context, inBlockquote: true }).filter(child => child !== null),
            true,
          )}
        </blockquote>
      )
    case 'thematicBreak':
      return <hr key={key} />
    case 'break':
      // 被替换流水线会在每个 <br> 后生成一个换行文本节点。
      return <Fragment key={key}><br />{'\n'}</Fragment>
    case 'strong':
      return <strong key={key}>{renderChildren(node.children, context)}</strong>
    case 'emphasis':
      return <em key={key}>{renderChildren(node.children, context)}</em>
    case 'delete':
      return <del key={key}>{renderChildren(node.children, context)}</del>
    case 'inlineCode': {
      // 与 mdast-util-to-hast 保持等价：行内代码把换行渲染为空格。
      const value = node.value.replace(/\r?\n|\r/g, ' ')
      // 完全由绝对 HTTP(S) URL 构成的行内代码词元会保留代码外观，并获得与链接相同
      // 的安全外部 anchor；命令、部分 URL 和其他协议保持不可交互。该值是作者文本，
      // 不是已解析目标，因此不执行 normalizeUri，端口、路径和查询均原样渲染。
      const href = inlineCodeHttpUrl(value)
      if (href !== undefined) return <code key={key}>{renderSafeLink(href, [value], 'link')}</code>
      // 拥有者文件提及词表识别出的词元会打开对应文件；由解析器而非本渲染器决定
      // 什么名称表示文件。在 anchor 内词元保持不可交互，因为其中不能嵌套按钮。
      const mention = context.inLink === true ? undefined : context.fileMentions?.resolve(value)
      if (mention !== undefined) {
        return (
          <code key={key}>
            <button
              type="button"
              className={css.fileMention}
              title={mention.title}
              aria-label={mention.label}
              onClick={mention.open}
            >
              {value}
            </button>
          </code>
        )
      }
      return <code key={key}>{value}</code>
    }
    case 'html':
      // 流水线不接入 HTML 解析器：raw HTML 保持字面文本。
      return node.value
    case 'code':
      return renderCode(node, key, context)
    case 'math':
      return <Fragment key={key}>{renderTexToReact(node.value, true)}</Fragment>
    case 'inlineMath':
      return <Fragment key={key}>{renderTexToReact(node.value, false)}</Fragment>
    case 'list':
      return renderList(node, key, context)
    case 'listItem':
      // 仅手工构造的树能到达；语法会把 item 放在 list 内。
      return renderListItem(node, listItemLoose(node), key, context)
    case 'table':
      return renderTable(node, key, context)
    case 'link':
      return renderAnchor(node.url, renderChildren(node.children, { ...context, inLink: true }), key)
    case 'linkReference':
      return renderLinkReference(node, key, context)
    case 'image':
      return renderImage(node.url, node.alt ?? '', key)
    case 'imageReference':
      return renderImageReference(node, key, context)
    case 'footnoteReference':
      return renderFootnoteReference(node, key, context)
    case 'definition':
    case 'footnoteDefinition':
      // 目标在其他位置渲染：定义就地解析引用，脚注正文渲染在末尾章节。
      return null
    default:
      // merge-extensible 联合的明确默认分支：没有映射的节点类型（表格外的
      // tableRow/tableCell、frontmatter、未来语法贡献）不渲染任何内容。
      return null
  }
}

function renderCode(node: Md.Code, key: Key, context: MarkdownRenderContext): ReactNode {
  const language = node.lang ?? undefined
  if (node.value === '') {
    // 保持等价：被替换流水线为空围栏保留原生 <pre>。
    return (
      <pre key={key}>
        <code className={language === undefined ? undefined : `language-${language}`} />
      </pre>
    )
  }
  // 被替换流水线通过 /language-([\w-]+)/ 从 hast class 恢复语法 ID，遇到首个
  // 非单词字符时截断。
  const lang = language === undefined ? undefined : /^[\w-]+/.exec(language)?.[0]
  if (!context.streaming && lang === 'math') {
    // ```math 围栏结算后渲染为 display TeX，与 rehype-katex 等价；其文本提取会
    // 看到代码块尾随换行。
    return <Fragment key={key}>{renderTexToReact(`${node.value}\n`, true)}</Fragment>
  }
  return (
    <CodeBlock
      key={key}
      // 被替换 hast 流水线会追加一个合成换行，由 CodeBlock 的展示裁剪移除；若传入
      // 裸值，裁剪反而会吃掉围栏内部真实的尾随空行。
      code={`${node.value}\n`}
      lang={context.streaming ? undefined : lang}
      copyLabel={context.codeLabels?.copyLabel}
      copiedLabel={context.codeLabels?.copiedLabel}
    />
  )
}

/** 列表自身或任一条目 spread 时为宽松列表；此时每个条目都保留段落。 */
function listLoose(list: Md.List): boolean {
  return (list.spread ?? false) || list.children.some(listItemLoose)
}

function listItemLoose(item: Md.ListItem): boolean {
  return item.spread ?? item.children.length > 1
}

function renderList(node: Md.List, key: Key, context: MarkdownRenderContext): ReactNode {
  const loose = listLoose(node)
  const properties: { start?: number; className?: string } = {}
  if (typeof node.start === 'number' && node.start !== 1) properties.start = node.start
  if (node.children.some(item => typeof item.checked === 'boolean')) {
    properties.className = 'contains-task-list'
  }
  return createElement(
    node.ordered === true ? 'ol' : 'ul',
    { key, ...properties },
    ...node.children.map((item, index) => renderListItem(item, loose, index, context)),
  )
}

function renderListItem(
  item: Md.ListItem,
  loose: boolean,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const entries = renderBlockEntries(item.children, context)
  const task = typeof item.checked === 'boolean'
  if (task) {
    const checkbox = <input key="task-checkbox" type="checkbox" checked={item.checked === true} disabled />
    const head = entries[0]
    if (head !== undefined && 'paragraph' in head) {
      head.paragraph = head.paragraph.length > 0 ? [checkbox, ' ', ...head.paragraph] : [checkbox]
    } else {
      entries.unshift({ paragraph: [checkbox] })
    }
  }
  // 换行位置和紧凑段落解包与 mdast-util-to-hast 的 list-item 处理器一致：除紧凑
  // 首段外，每个子项前都有换行；末项非段落时在其后换行，宽松列表则所有末项后换行。
  const parts: ReactNode[] = []
  for (const [index, entry] of entries.entries()) {
    const isParagraph = 'paragraph' in entry
    if (loose || index !== 0 || !isParagraph) parts.push('\n')
    if (!isParagraph) parts.push(entry.element)
    else if (loose) parts.push(<p key={`p-${index}`}>{entry.paragraph}</p>)
    else parts.push(<Fragment key={`p-${index}`}>{entry.paragraph}</Fragment>)
  }
  const tail = entries[entries.length - 1]
  if (tail !== undefined && (loose || !('paragraph' in tail))) parts.push('\n')
  return (
    <li key={key} className={task ? 'task-list-item' : undefined}>
      {parts}
    </li>
  )
}

function renderTable(node: Md.Table, key: Key, context: MarkdownRenderContext): ReactNode {
  const align = node.align ?? null
  const [headRow, ...bodyRows] = node.children
  const columns = align === null ? headRow?.children.length ?? 0 : align.length
  // 四列及以上按对比矩阵阅读：块保持表格自然宽度，并暴露稳定 `md-table-wide` hook，
  // 让承载布局（聊天转录）可把它拓宽到消息列之外。更窄的表格以及 blockquote 内
  // 任意表格则填满列并换行，与 deepsuite chat TableWrapper 等价。
  const wide = columns >= 4 && context.inBlockquote !== true
  return (
    // 宽表格静止时使用 overflow-x hidden，滚动条由 MarkdownText.module.css 在悬停时
    // 显示；这会取消 Chromium 对滚动容器的隐式可聚焦性。显式 tabindex 保持键盘
    // 可达，:focus-visible 则恢复滚动。
    <div
      key={key}
      className={clsx(css.tableScroll, wide ? 'md-table-wide' : css.tableFill)}
      tabIndex={wide ? 0 : undefined}
    >
      <table>
        {headRow !== undefined && <thead>{renderTableRow(headRow, 'th', align, 0, context)}</thead>}
        {bodyRows.length > 0 && (
          <tbody>
            {bodyRows.map((row, index) => renderTableRow(row, 'td', align, index + 1, context))}
          </tbody>
        )}
      </table>
    </div>
  )
}

function renderTableRow(
  row: Md.TableRow,
  cellTag: 'th' | 'td',
  align: readonly Md.AlignType[] | null,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  // 存在列对齐信息时，每行严格按每列渲染一个单元格，并补齐或截断行，保持与
  // mdast-util-to-hast 等价。
  const length = align === null ? row.children.length : align.length
  const cells: ReactNode[] = []
  for (let index = 0; index < length; index++) {
    const cell = row.children[index]
    const alignValue = align?.[index]
    cells.push(createElement(
      cellTag,
      // hast-util-to-jsx-runtime 默认 tableCellAlignToStyle 会把已弃用 align 属性
      // 转为内联样式；这里保持相同 DOM。
      { key: index, style: alignValue == null ? undefined : { textAlign: alignValue } },
      ...(cell === undefined ? [] : renderChildren(cell.children, context)),
    ))
  }
  return <tr key={key}>{cells}</tr>
}

/** 为作者已写下的 href 创建 anchor：允许列表内才包装；外部链接带安全属性。 */
function renderSafeLink(href: string, children: ReactNode[], key: Key): ReactNode {
  const safeHref = sanitizeUrl(href)
  if (safeHref === '') return <Fragment key={key}>{children}</Fragment>
  const external = ['http:', 'https:'].includes(new URL(safeHref).protocol)
  return (
    <a
      key={key}
      href={safeHref}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  )
}

/** Anchor over a parsed markdown destination, which hast normalized before the allowlist saw it. */
function renderAnchor(url: string, children: ReactNode[], key: Key): ReactNode {
  return renderSafeLink(normalizeUri(url), children, key)
}

/**
 * The complete inline-code value when it is exactly an absolute HTTP(S) URL
 * (no surrounding whitespace); anything else stays inert code.
 */
function inlineCodeHttpUrl(value: string): string | undefined {
  if (value.trim() !== value) return undefined
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' ? value : undefined
  } catch {
    // Not an absolute URL at all — the only way new URL() rejects a string.
    return undefined
  }
}

function renderImage(url: string, alt: string, key: Key): ReactNode {
  const imageSrc = remoteImageUrl(sanitizeUrl(normalizeUri(url)))
  if (imageSrc === undefined) {
    return <span key={key} className={css.imageAlt}>{alt}</span>
  }
  return (
    <img
      key={key}
      className={css.image}
      src={imageSrc}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  )
}

/** The bracketed source text a reference reverts to when its definition is missing. */
function referenceSuffix(node: Md.LinkReference | Md.ImageReference): string {
  if (node.referenceType === 'collapsed') return '][]'
  if (node.referenceType === 'full') return `][${node.label ?? node.identifier}]`
  return ']'
}

function renderLinkReference(
  node: Md.LinkReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const definition = context.targets.definitions.get(node.identifier.toUpperCase())
  if (definition === undefined) {
    // The grammar only emits references whose definitions exist somewhere in
    // the same parse, but incremental segments and hand-built trees may still
    // present unresolved ones: revert to the bracketed source text — which is
    // not an anchor, so mentions inside it stay live.
    return <Fragment key={key}>{'['}{renderChildren(node.children, context)}{referenceSuffix(node)}</Fragment>
  }
  return renderAnchor(definition.url, renderChildren(node.children, { ...context, inLink: true }), key)
}

function renderImageReference(
  node: Md.ImageReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const definition = context.targets.definitions.get(node.identifier.toUpperCase())
  if (definition === undefined) return `![${node.alt ?? ''}${referenceSuffix(node)}`
  return renderImage(definition.url, node.alt ?? '', key)
}

function renderFootnoteReference(
  node: Md.FootnoteReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const id = node.identifier.toUpperCase()
  const seen = context.footnoteCounts.get(id)
  if (seen === undefined) context.footnoteOrder.push(id)
  context.footnoteCounts.set(id, (seen ?? 0) + 1)
  // The in-page anchor fails the protocol allowlist, so only the numbered
  // superscript renders (matching the replaced pipeline's unwrapped link).
  return <sup key={key}>{String(context.footnoteOrder.indexOf(id) + 1)}</sup>
}

/**
 * Render the trailing footnote section for every footnote referenced during
 * the pass, in first-reference order, with one plain-text back-reference
 * marker per rendered reference.
 * @param context - The pass state after all blocks rendered.
 * @returns The section, or null when no referenced footnote has a definition.
 */
export function renderFootnoteSection(context: MarkdownRenderContext): ReactNode | null {
  const items: ReactNode[] = []
  for (const id of context.footnoteOrder) {
    const definition = context.targets.footnotes.get(id)
    if (definition === undefined) continue
    const count = context.footnoteCounts.get(id) ?? 0
    const backrefs: ReactNode[] = []
    for (let reference = 1; reference <= count; reference++) {
      if (backrefs.length > 0) backrefs.push(' ')
      backrefs.push('↩')
      if (reference > 1) backrefs.push(<sup key={`re-${reference}`}>{String(reference)}</sup>)
    }
    const entries = renderBlockEntries(definition.children, context)
    const tail = entries[entries.length - 1]
    const body: ReactNode[] = entries.map((entry, index) => (
      'paragraph' in entry
        ? (
          <p key={`p-${index}`}>
            {entry.paragraph}
            {entry === tail && <>{' '}{backrefs}</>}
          </p>
        )
        : entry.element
    ))
    // Without a trailing paragraph the back-references join the block list
    // itself (and pick up the wrap newlines), as in the replaced pipeline.
    if (tail === undefined || !('paragraph' in tail)) body.push(...backrefs)
    items.push(
      <li key={id} id={`user-content-fn-${normalizeUri(id.toLowerCase())}`}>
        {wrapBlockChildren(body, true)}
      </li>,
    )
  }
  if (items.length === 0) return null
  return (
    <section key="footnotes" data-footnotes className="footnotes">
      <h2 id="footnote-label" className="sr-only">Footnotes</h2>
      <ol>{items}</ol>
    </section>
  )
}
