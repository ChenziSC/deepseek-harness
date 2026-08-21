/**
 * Session 集群调用的 Remote 命名空间。一个概念只用一个参数表示：Session 及其 manager
 * 通过这份生成接口访问 Host。
 *
 * @module @deepseek-ai/dsh-client-runtime/client/sessions/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

/** Session 及其 manager 调用的生成式 Remote 命名空间。 */
export type SessionRemotes = Pick<Context['remote'], 'commands'>
