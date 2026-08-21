import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AttachmentRailLabels } from '../AttachmentRail.tsx'
import type { DropOverlayLabels } from '../DropOverlay.tsx'
import type { ImageLightboxLabels } from '../ImageLightbox.tsx'
import type { MessageImageLabels } from '../MessageImage.tsx'

/**
 * 从 Conversation namespace 解析原图 Lightbox 文案。
 * @param t - Conversation namespace translator。
 * @returns 已翻译的 Lightbox 标签。
 */
export function lightboxLabels(t: TranslateNS<'conversation'>): ImageLightboxLabels {
  return { dialog: t('image.preview'), close: t('image.closePreview') }
}

/**
 * 从 Conversation namespace 解析历史消息图片文案。
 * @param t - Conversation namespace translator。
 * @returns 已翻译的消息图片标签。
 */
export function messageImageLabels(t: TranslateNS<'conversation'>): MessageImageLabels {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: lightboxLabels(t),
  }
}

/**
 * 解析文档级拖放邀请，以及可选的限制说明行。
 * @param t - Conversation namespace translator。
 * @param accepting - Composer 是否可接受拖入文件。
 * @param limits - 可选且已翻译的数量和尺寸值。
 * @returns 已翻译的拖放 Overlay 标签。
 */
export function dropOverlayLabels(
  t: TranslateNS<'conversation'>,
  accepting: boolean,
  limits?: { readonly count: number; readonly size: string },
): DropOverlayLabels {
  if (!accepting) return { title: t('image.dropBlocked') }
  return {
    title: t('image.dropTitle'),
    desc: limits === undefined ? undefined : t('image.dropDesc', limits),
  }
}

/**
 * 从 Conversation namespace 解析草稿图片 Rail 文案。
 * @param t - Conversation namespace translator。
 * @returns 已翻译的附件 Rail 标签。
 */
export function attachmentRailLabels(t: TranslateNS<'conversation'>): AttachmentRailLabels {
  return {
    group: t('image.pending'),
    open: t('image.openOriginal'),
    scrollLeft: t('image.scrollLeft'),
    scrollRight: t('image.scrollRight'),
  }
}
