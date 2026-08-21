import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * 按 Host 界面请求的展示方式渲染官方标记。
 * @param props - Host 提供的标记展示参数。
 * @returns 官方鲸鱼标记。
 */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  return <FishLogo size={size} className={className} />
}

/**
 * 渲染官方名称图稿，不包含独立 Slot 中的标记。
 * @returns 官方名称 Wordmark。
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}
