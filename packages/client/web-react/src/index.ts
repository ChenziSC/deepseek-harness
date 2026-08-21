/** 不依赖具体框架的 slot 与快照约定所对应的 React 绑定。 */
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

export { bindSnapshotSelector } from './bind.ts'

/**
 * 基于会话对话快照的选择器钩子。在这个依赖反转包中默认保持宽类型 `object`；
 * runtime 在其导出位置一次性收窄为 `UseSession<ConversationSnapshot>`，快照类型
 * 不会反向流入 web-react。
 */
export type UseSession<Snap extends object = object> = SnapshotSelectorHook<Snap>

export type {
  ChainRenderOpts, HostObservable, RenderOpts, SessionProvideInfo, SnapshotSelectorHook,
  SlotRenderer, SlotRendererHost, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'
export { SlotOwnershipError, StaleAuthorizationError } from '@deepseek-ai/dsh-client-ui-slots'
export { createSlotRenderer } from './scoped-slots.tsx'

export { SessionProvider, SlotAssemblyError, type SessionProviderProps } from './session-provider.tsx'

export { useInvoke } from './use-invoke.ts'
