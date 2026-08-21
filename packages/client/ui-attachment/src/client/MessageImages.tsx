import type { MessageImagesProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ImageGallery } from '../MessageImage.tsx'
import { messageImageLabels } from './labels.ts'

/** 历史消息图片 Slot 条目。 */
export function MessageImages({ images, loadImage, align, t }: MessageImagesProps) {
  return <ImageGallery images={images} load={loadImage} align={align} labels={messageImageLabels(t)} />
}
