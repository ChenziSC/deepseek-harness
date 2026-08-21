/**
 * 浏览器平台共享模块。播种、打包 externals 和 Vite alias 都消费此列表，
 * 从而避免模块标识发生偏差。
 * @module @deepseek-ai/dsh-client-web/src/platform
 */

/** shell 共享到冻结模块表中的模块说明符。 */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** Parser 在 shell 启动前预载其 factory 的 client bundle specifier。 */
export const PRELOADED_CLIENT_EXTERNALS = [
  '@deepseek-ai/dsh-client-runtime/client',
] as const

/** 单个平台模块 specifier，也是 seed 表的键。 */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
