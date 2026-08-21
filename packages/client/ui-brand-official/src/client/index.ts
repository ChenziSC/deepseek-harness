/** 通用浏览器 Brand Slot 的 DeepSeek Harness 官方占位组件。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { OfficialBrandMark, OfficialBrandName } from './Brand.tsx'

/** 必需服务：UI Slot 注册表。 */
export const inject = ['slots']

/**
 * 以一个可感知声明的注册集合填充所有随附 Brand Slot。
 * @param ctx - Client 根 Context。
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, OfficialBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, OfficialBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, OfficialBrandMark)
      })))
}
