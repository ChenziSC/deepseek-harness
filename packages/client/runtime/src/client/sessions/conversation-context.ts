import type { ConversationNode } from './conversation.ts'
import type { ConversationPromptSnapshot } from './request-inspection.ts'

/** 启动新追加式模型上下文的操作。 */
export type ConversationContextOriginKind = 'compaction' | 'rewind' | 'rewrite'

/** 根据界面替换事件重建的一代不可变模型上下文。 */
export interface ConversationContext {
  /** Session 内从零开始的代次；后续追加不会改变。 */
  id: number
  /** 本 session 的上一代；初始上下文不存在。 */
  parentId?: number
  /** 本代产生原因；初始上下文不存在。 */
  origin?: ConversationContextOriginKind
  /** 创建本代的替换事件 seq。 */
  originSeq?: number
  /** 创建本代的替换事件时间，单位 Unix epoch 毫秒。 */
  createdAt?: number
  /** 本代观察到的最新请求头；后续请求头替换前持续继承。 */
  prompt?: ConversationPromptSnapshot
  /** 历史代的最终冻结 Nodes，或尾部当前折叠出的 Nodes。 */
  nodes: readonly ConversationNode[]
}
