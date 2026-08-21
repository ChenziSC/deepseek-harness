// AssistantMarkdown 按顺序渲染助手块：Markdown 文本正文、Figma Think 摘要行形式的
// reasoning（展开后为缩进灰色文本），以及其他块的 JSON fallback。工具调用头不在
// 此处渲染；聊天视图通过 keyed toolview Slot 把它们分组为工具行，即 Figma
// step-summary 流程。已完成节点和流式 partial 共享此组件；轮次级加载点位于聊天
// 视图 tail，而非这里。已完成内容（text）节点在轮次结束后追加 IconActions；轮次中
// 叙述和仍运行时省略 `time`。只有节点同时是已完成轮次的转录尾部时才启用 branch
// 操作。Think/只有工具头的节点不带外观。

import { Fragment, memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import { ReasoningRow } from './ReasoningRow.tsx'
import css from './AssistantMarkdown.module.css'

export interface AssistantMarkdownProps {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  /** 已中止轮次的冻结 partial，附带 stopped 标记渲染。 */
  interrupted?: boolean | undefined
  /** 通过附件 Slot 渲染连续图片块。 */
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  /** 为本助手结束轮次解析出的正文文件提及。 */
  mentions?: MarkdownFileMentions | undefined
  /** 所属视图的 locale 座位，以普通 prop 向下传递。 */
  t: ChatViewSlotProps['t']
}

/** 以 Think 变体摘要行渲染 reasoning 块（Figma 39:28304）。 */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks, streaming, interrupted, renderMessageImages, mentions, t,
}: AssistantMarkdownProps) {
  // 每个 locale 修订内保持稳定，切换语言时 t 身份才变化；若每次渲染创建新对象，
  // 每个流式 chunk 都会重建 MarkdownText 组件表。
  const codeLabels = useMemo(() => ({ copyLabel: t('copy'), copiedLabel: t('copied') }), [t])
  const last = blocks.length - 1
  // 工具调用头在聊天视图分组 pass 中渲染为工具行，因此只有这些头或为空的节点会在
  // 工具组间画出空 root；没有可见内容时跳过外壳。
  const hasVisible = streaming
    || interrupted === true
    || blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null
  const rendered: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        rendered.push(
          <MarkdownText
            key={i}
            text={block.text}
            streaming={streaming}
            codeLabels={codeLabels}
            fileMentions={mentions}
          />,
        )
        break
      case 'reasoning':
        rendered.push(<ReasoningRow key={i} text={block.text} running={streaming && i === last} t={t} />)
        break
      case 'image': {
        // 连续图片块共享一个画廊，使多张图片按行平铺，而不是各自创建单图分组。
        // 键使用分组首块索引；流式追加扩展分组时只增长 `images`，不会因键移动而
        // 重新挂载画廊。
        const start = i
        const group = [block]
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          i += 1
        }
        rendered.push(
          <Fragment key={start}>
            {renderMessageImages({
              images: group.map(({ attachment }) => ({ attachment })),
              align: 'start',
            })}
          </Fragment>,
        )
        break
      }
      // 由 ChatView 分组为工具行；上方 hasVisible 会跳过空外壳。
      case 'tool-call':
        break
      default:
        rendered.push(
          <JsonBlock
            key={i}
            label={t('message.unknownBlock')}
            payload={block.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />,
        )
    }
  }
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {rendered}
        {interrupted && <span className={css.stopped}>{t('message.stopped')}</span>}
      </div>
    </div>
  )
})
