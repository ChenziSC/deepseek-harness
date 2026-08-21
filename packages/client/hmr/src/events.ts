/**
 * `/plugins/events` 开发环境 SSE 通道的传输协议，是本包两端的唯一类型来源。帧仍会
 * 跨越传输边界：浏览器端在 JSON 解析点校验它们。共享类型只用于防止两端定义漂移，
 * 不能取代解析。
 */

import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** 一帧 SSE：连接时的完整图，或一次 bundle 重建通知。 */
export type PluginsEventFrame =
  | { type: 'graph'; graph: WebBootGraph }
  | { type: 'rebuilt'; id: string; rev: string }

/** 推送 graph/rebuilt 帧的系统 SSE 端点；属于传输协议常量。 */
export const EVENTS_ENDPOINT = '/plugins/events'
