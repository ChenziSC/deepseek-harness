/**
 * 浏览器平台共享模块。播种、打包 externals 和 Vite alias 都消费此列表，
 * 从而避免模块标识发生偏差。
 * @module @deepseek-ai/dsh-client-web/src/platform
 */

/** shell 共享到冻结模块表中的模块说明符。 */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** 单个平台模块说明符，也是播种表的键。 */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
