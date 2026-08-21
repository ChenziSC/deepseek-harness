/** `trajectory` namespace dictionaries (view tab label + toolbar strings). */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { createContext, useContext } from 'react'

/** Dictionary namespace owned by this plugin. */
export const NS = 'trajectory'

/** The trajectory dictionary key set (the source of truth for both locales). */
export type TrajectoryKey =
  | 'view.trajectory'
  | 'toolbar.aria'
  | 'toolbar.duration'
  | 'toolbar.useActualDuration'
  | 'toolbar.useEqualWidth'
  | 'toolbar.actualTime'
  | 'toolbar.turns'
  | 'toolbar.expandTurns'
  | 'toolbar.collapseTurns'
  | 'toolbar.calls'
  | 'toolbar.expandCalls'
  | 'toolbar.collapseCalls'
  | 'toolbar.search'
  | 'toolbar.searchPlaceholder'
  | 'timeline.aria'
  | 'timeline.overviewAria'
  | 'timeline.input'
  | 'timeline.model'
  | 'timeline.tools'
  | 'timeline.noTiming'
  | 'timeline.total'
  | 'timeline.started'
  | 'timeline.phases'
  | 'timeline.loadingEarlier'
  | 'timeline.loadingEarlierAria'
  | 'timeline.loadEarlier'
  | 'timeline.loadEarlierHint'
  | 'table.eventDetails'
  | 'table.closeDetails'
  | 'table.resizeDetails'
  | 'table.resizeDetailsHint'
  | 'table.loadingEarlier'
  | 'table.loadEarlier'
  | 'table.loadingTrajectory'
  | 'table.betweenTurns'
  | 'table.turn'
  | 'table.request'
  | 'table.status'
  | 'table.purpose'
  | 'table.compaction'
  | 'table.provider'
  | 'table.model'
  | 'table.toolCalls'
  | 'table.subtoolCalls'
  | 'table.error'
  | 'table.retry'
  | 'table.retryScheduled'
  | 'table.retryOf'
  | 'table.retryDelay'
  | 'table.result'
  | 'table.compacted'
  | 'table.assistantMessage'
  | 'table.toolCall'
  | 'table.source'
  | 'table.hierarchy'
  | 'table.duration'
  | 'table.tokens'
  | 'table.noSystemPrompt'
  | 'table.failed'
  | 'table.pending'
  | 'table.completed'
  | 'table.notAvailable'
  | 'table.showLocalTime'
  | 'table.showUnixTimestamp'
  | 'table.notRecorded'
  | 'table.stepStartUnavailable'
  | 'table.firstTokenUnavailable'
  | 'table.usageUnavailable'
  | 'table.outputTokensUnavailable'
  | 'table.durationTooShort'
  | 'table.started'
  | 'table.totalDuration'
  | 'table.generation'
  | 'table.throughput'
  | 'table.reasoning'
  | 'table.content'
  | 'table.usageNotReported'
  | 'table.input'
  | 'table.cached'
  | 'table.cacheCreated'
  | 'table.other'
  | 'table.output'
  | 'table.thisRequest'
  | 'table.sessionCumulative'
  | 'table.optionsNotRecorded'
  | 'table.sourceNotRecorded'
  | 'table.toolCallOnly'
  | 'table.noTools'
  | 'table.timingSource'
  | 'table.sessionTimestamps'
  | 'table.sessionTimestampsRunning'
  | 'table.schemaUnavailable'
  | 'table.parameters'
  | 'table.requestOptionsJson'
  | 'table.messageSourceJson'
  | 'table.openToolSummary'
  | 'table.openBlockToolSummary'
  | 'table.openImage'
  | 'table.resultJson'
  | 'table.unknown'
  | 'table.user'
  | 'table.plugin'
  | 'table.goal'
  | 'table.goalRound'
  | 'table.block'
  | 'table.thinking'
  | 'table.toolCallOnlyPlain'
  | 'table.noContent'
  | 'table.noPayloadCaptured'
  | 'table.noResultCaptured'
  | 'table.payloadJson'
  | 'table.parametersJson'
  | 'tab.systemPrompt'
  | 'tab.tools'
  | 'tab.diff'
  | 'tab.summary'
  | 'tab.options'
  | 'tab.usage'
  | 'tab.timing'
  | 'tab.preview'
  | 'tab.rawOutput'
  | 'tab.raw'
  | 'tab.source'
  | 'tab.payload'
  | 'tab.result'
  | 'tab.schema'
  | 'tab.requestTiming'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The trajectory view tab label and toolbar strings. */
    'trajectory': TrajectoryKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<TrajectoryKey, string> = {
  'view.trajectory': '轨迹',
  'toolbar.aria': '轨迹工具栏',
  'toolbar.duration': '耗时',
  'toolbar.useActualDuration': '按实际耗时显示',
  'toolbar.useEqualWidth': '按等宽操作显示',
  'toolbar.actualTime': '实际时间',
  'toolbar.turns': '轮次',
  'toolbar.expandTurns': '展开所有轮次',
  'toolbar.collapseTurns': '收起所有轮次',
  'toolbar.calls': '调用',
  'toolbar.expandCalls': '展开所有调用',
  'toolbar.collapseCalls': '收起所有调用',
  'toolbar.search': '搜索轨迹',
  'toolbar.searchPlaceholder': '搜索',
  'timeline.aria': '轨迹时间线',
  'timeline.overviewAria': '时间线概览；水平拖动可聚焦事件',
  'timeline.input': '输入',
  'timeline.model': '模型',
  'timeline.tools': '工具',
  'timeline.noTiming': '暂无计时数据',
  'timeline.total': '总耗时 {duration}',
  'timeline.started': '开始于 {time}',
  'timeline.phases': 'TTFT {ttft} · 解码 {decoding}',
  'timeline.loadingEarlier': '正在加载更早历史…',
  'timeline.loadingEarlierAria': '正在加载更早历史',
  'timeline.loadEarlier': '加载更早历史',
  'timeline.loadEarlierHint': '点击加载更早历史',
  'table.eventDetails': '事件详情',
  'table.closeDetails': '关闭详情',
  'table.resizeDetails': '调整事件详情宽度',
  'table.resizeDetailsHint': '拖动调整大小；双击恢复默认值。',
  'table.loadingEarlier': '正在加载更早历史…',
  'table.loadEarlier': '加载更早历史',
  'table.loadingTrajectory': '正在加载轨迹…',
  'table.betweenTurns': '轮次之间',
  'table.turn': '轮次 {turn}',
  'table.request': '请求 #{number}',
  'table.status': '状态',
  'table.purpose': '用途',
  'table.compaction': '上下文压缩',
  'table.provider': 'Provider',
  'table.model': '模型',
  'table.toolCalls': '工具调用',
  'table.subtoolCalls': '子工具调用',
  'table.error': '错误',
  'table.retry': '重试',
  'table.retryScheduled': '已安排第 {retry} 次',
  'table.retryOf': '已安排第 {retry} 次，共 {maximum} 次',
  'table.retryDelay': '重试延迟',
  'table.result': '结果',
  'table.compacted': '已压缩',
  'table.assistantMessage': '助手消息',
  'table.toolCall': '工具调用',
  'table.source': '来源',
  'table.hierarchy': '层级',
  'table.duration': '耗时',
  'table.tokens': 'Token',
  'table.noSystemPrompt': '本次请求没有系统提示词',
  'table.failed': '失败',
  'table.pending': '进行中',
  'table.completed': '已完成',
  'table.notAvailable': '不可用',
  'table.showLocalTime': '显示本地时间',
  'table.showUnixTimestamp': '显示 Unix 时间戳',
  'table.notRecorded': '未记录',
  'table.stepStartUnavailable': '步骤开始时间不可用',
  'table.firstTokenUnavailable': '首 token 时间不可用',
  'table.usageUnavailable': '用量不可用',
  'table.outputTokensUnavailable': '输出 token 不可用',
  'table.durationTooShort': '耗时过短',
  'table.started': '开始时间',
  'table.totalDuration': '总耗时',
  'table.generation': '生成耗时',
  'table.throughput': '吞吐量',
  'table.reasoning': '推理',
  'table.content': '正文',
  'table.usageNotReported': 'Provider 未报告用量',
  'table.input': '输入',
  'table.cached': '缓存读取',
  'table.cacheCreated': '缓存写入',
  'table.other': '其他',
  'table.output': '输出',
  'table.thisRequest': '本次请求',
  'table.sessionCumulative': '会话累计',
  'table.optionsNotRecorded': '未记录请求选项',
  'table.sourceNotRecorded': '未记录消息来源',
  'table.toolCallOnly': '（仅工具调用）',
  'table.noTools': '本次请求没有工具',
  'table.timingSource': '计时来源',
  'table.sessionTimestamps': '会话时间戳',
  'table.sessionTimestampsRunning': '会话时间戳（运行中）',
  'table.schemaUnavailable': 'Schema 不可用',
  'table.parameters': '参数',
  'table.requestOptionsJson': '请求选项 JSON',
  'table.messageSourceJson': '消息来源 JSON',
  'table.openToolSummary': '打开工具调用概览',
  'table.openBlockToolSummary': '打开内容块 #{index} 的工具调用概览',
  'table.openImage': '打开图片',
  'table.resultJson': '结果 JSON',
  'table.unknown': '未知',
  'table.user': '用户',
  'table.plugin': '插件',
  'table.goal': '目标',
  'table.goalRound': '目标 · 第 {round} 轮',
  'table.block': '内容块 #{index} {type}',
  'table.thinking': '思考过程',
  'table.toolCallOnlyPlain': '仅工具调用',
  'table.noContent': '无内容',
  'table.noPayloadCaptured': '未捕获载荷',
  'table.noResultCaptured': '未捕获结果',
  'table.payloadJson': '载荷 JSON',
  'table.parametersJson': '{name} 参数 JSON',
  'tab.systemPrompt': '系统提示词',
  'tab.tools': '工具',
  'tab.diff': '差异',
  'tab.summary': '概览',
  'tab.options': '选项',
  'tab.usage': '用量',
  'tab.timing': '计时',
  'tab.preview': '预览',
  'tab.rawOutput': '原始输出',
  'tab.raw': '原文',
  'tab.source': '来源',
  'tab.payload': '载荷',
  'tab.result': '结果',
  'tab.schema': 'Schema',
  'tab.requestTiming': '请求计时',
}

/** English dictionary. */
export const en: Record<TrajectoryKey, string> = {
  'view.trajectory': 'Trajectory',
  'toolbar.aria': 'Trajectory toolbar',
  'toolbar.duration': 'Duration',
  'toolbar.useActualDuration': 'Use actual duration',
  'toolbar.useEqualWidth': 'Use equal-width operations',
  'toolbar.actualTime': 'Actual time',
  'toolbar.turns': 'Turns',
  'toolbar.expandTurns': 'Expand turns',
  'toolbar.collapseTurns': 'Collapse turns',
  'toolbar.calls': 'Calls',
  'toolbar.expandCalls': 'Expand calls',
  'toolbar.collapseCalls': 'Collapse calls',
  'toolbar.search': 'Search trajectory',
  'toolbar.searchPlaceholder': 'Search',
  'timeline.aria': 'Trajectory timeline',
  'timeline.overviewAria': 'Timeline overview; drag horizontally to focus events',
  'timeline.input': 'Input',
  'timeline.model': 'Model',
  'timeline.tools': 'Tools',
  'timeline.noTiming': 'No timing data',
  'timeline.total': 'Total {duration}',
  'timeline.started': 'Started {time}',
  'timeline.phases': 'TTFT {ttft} · Decoding {decoding}',
  'timeline.loadingEarlier': 'Loading earlier history…',
  'timeline.loadingEarlierAria': 'Loading earlier history',
  'timeline.loadEarlier': 'Load earlier history',
  'timeline.loadEarlierHint': 'Click to load earlier history',
  'table.eventDetails': 'Event details',
  'table.closeDetails': 'Close details',
  'table.resizeDetails': 'Resize event details',
  'table.resizeDetailsHint': 'Drag to resize. Double-click to reset.',
  'table.loadingEarlier': 'Loading earlier history…',
  'table.loadEarlier': 'Load earlier history',
  'table.loadingTrajectory': 'Loading trajectory…',
  'table.betweenTurns': 'Between turns',
  'table.turn': 'Turn {turn}',
  'table.request': 'Request #{number}',
  'table.status': 'Status',
  'table.purpose': 'Purpose',
  'table.compaction': 'Compaction',
  'table.provider': 'Provider',
  'table.model': 'Model',
  'table.toolCalls': 'Tool calls',
  'table.subtoolCalls': 'Subtool calls',
  'table.error': 'Error',
  'table.retry': 'Retry',
  'table.retryScheduled': 'Scheduled {retry}',
  'table.retryOf': 'Scheduled {retry} of {maximum}',
  'table.retryDelay': 'Retry delay',
  'table.result': 'Result',
  'table.compacted': 'Compacted',
  'table.assistantMessage': 'Assistant Message',
  'table.toolCall': 'Tool Call',
  'table.source': 'Source',
  'table.hierarchy': 'Hierarchy',
  'table.duration': 'Duration',
  'table.tokens': 'Tokens',
  'table.noSystemPrompt': 'No system prompt in this request',
  'table.failed': 'Failed',
  'table.pending': 'Pending',
  'table.completed': 'Completed',
  'table.notAvailable': 'Not available',
  'table.showLocalTime': 'Show local time',
  'table.showUnixTimestamp': 'Show Unix timestamp',
  'table.notRecorded': 'Not recorded',
  'table.stepStartUnavailable': 'Step start unavailable',
  'table.firstTokenUnavailable': 'First token unavailable',
  'table.usageUnavailable': 'Usage unavailable',
  'table.outputTokensUnavailable': 'Output tokens unavailable',
  'table.durationTooShort': 'Duration too short',
  'table.started': 'Started',
  'table.totalDuration': 'Total duration',
  'table.generation': 'Generation',
  'table.throughput': 'Throughput',
  'table.reasoning': 'Reasoning',
  'table.content': 'Content',
  'table.usageNotReported': 'Usage not reported',
  'table.input': 'Input',
  'table.cached': 'Cached',
  'table.cacheCreated': 'Cache created',
  'table.other': 'Other',
  'table.output': 'Output',
  'table.thisRequest': 'This request',
  'table.sessionCumulative': 'Session cumulative',
  'table.optionsNotRecorded': 'Options not recorded',
  'table.sourceNotRecorded': 'Source not recorded',
  'table.toolCallOnly': '(tool call only)',
  'table.noTools': 'No tools in this request',
  'table.timingSource': 'Timing source',
  'table.sessionTimestamps': 'Session timestamps',
  'table.sessionTimestampsRunning': 'Session timestamps (running)',
  'table.schemaUnavailable': 'Schema unavailable',
  'table.parameters': 'Parameters',
  'table.requestOptionsJson': 'Request options JSON',
  'table.messageSourceJson': 'Message source JSON',
  'table.openToolSummary': 'Open tool call summary',
  'table.openBlockToolSummary': 'Open Block #{index} tool call summary',
  'table.openImage': 'Open image',
  'table.resultJson': 'Result JSON',
  'table.unknown': 'Unknown',
  'table.user': 'User',
  'table.plugin': 'Plugin',
  'table.goal': 'Goal',
  'table.goalRound': 'Goal · Round {round}',
  'table.block': 'Block #{index} {type}',
  'table.thinking': 'Thinking',
  'table.toolCallOnlyPlain': 'Tool call only',
  'table.noContent': 'No content',
  'table.noPayloadCaptured': 'No payload captured',
  'table.noResultCaptured': 'No result captured',
  'table.payloadJson': 'Payload JSON',
  'table.parametersJson': '{name} parameters JSON',
  'tab.systemPrompt': 'System Prompt',
  'tab.tools': 'Tools',
  'tab.diff': 'Diff',
  'tab.summary': 'Summary',
  'tab.options': 'Options',
  'tab.usage': 'Usage',
  'tab.timing': 'Timing',
  'tab.preview': 'Preview',
  'tab.rawOutput': 'Raw Output',
  'tab.raw': 'Raw',
  'tab.source': 'Source',
  'tab.payload': 'Payload',
  'tab.result': 'Result',
  'tab.schema': 'Schema',
  'tab.requestTiming': 'Request Timing',
}

/**
 * English fallback used by standalone trajectory components outside a locale slot.
 * @param key - trajectory namespace key.
 * @param params - optional template interpolation values.
 * @returns translated English copy with known placeholders replaced.
 */
export const translateEnglish: TranslateNS<typeof NS> = (key, params) => {
  const template = en[key as TrajectoryKey]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** Locale seat inherited by nested trajectory detail components. */
export const TrajectoryTranslateContext = createContext<TranslateNS<typeof NS>>(translateEnglish)

/**
 * Read the nearest trajectory locale seat, falling back to English in standalone renders.
 * @returns the locale translator inherited by this detail component.
 */
export function useTrajectoryTranslate(): TranslateNS<typeof NS> {
  return useContext(TrajectoryTranslateContext)
}
