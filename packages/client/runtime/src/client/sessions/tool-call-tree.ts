import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tools/types'
import type {
  ConversationNode, RunningToolCall, ToolCallBlock, ToolResultNode,
} from './conversation.ts'

interface ProjectedBlock {
  source: ToolCallBlock
  children: readonly ToolCallBlock[]
  value: ToolCallBlock
}

/** 所有递归 Tool 调用消费者共用的固定传输安全深度上限。 */
export const MAX_TOOL_CALL_TREE_DEPTH = 256

function sameReferences<T>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  return left.length === right.length
    && left.every((block, index) => block === right[index])
}

/**
 * 负责 Code Dispatch 配对，并把私有父级索引投影为对话快照公开的递归 Tool 调用结构。
 */
export class ToolCallTree {
  private readonly childrenByParent = new Map<string, readonly ToolCallBlock[]>()
  private readonly depthByCall = new Map<string, number>()
  private readonly projectedByCall = new Map<string, ProjectedBlock>()
  private revision = 0
  private nodesCache: {
    source: readonly ConversationNode[]
    revision: number
    value: readonly ConversationNode[]
  } | null = null
  private runningCache: {
    source: readonly RunningToolCall[]
    revision: number
    value: readonly RunningToolCall[]
  } | null = null

  /** 重放新窗口前清除所有由事件得出的子调用。 */
  reset(): void {
    this.childrenByParent.clear()
    this.depthByCall.clear()
    this.projectedByCall.clear()
    this.revision++
  }

  /**
   * 事件属于 Code Dispatch 生命周期时将其折叠。
   * @param event - 当前实时或历史窗口中的 Session 事件。
   * @returns 该事件是否作为子调用生命周期事件被消费。
   */
  apply(event: SessionEvent): boolean {
    if (event.type === 'tool/code-dispatch-start') {
      const data = event.data
      const running: RunningToolCall = {
        callId: data.subCallId,
        name: data.name,
        argsRaw: JSON.stringify(data.arguments),
        turn: 0,
        step: 0,
        time: event.time,
        callView: null,
        subCalls: [],
      }
      const siblings = this.childrenByParent.get(data.parentCallId) ?? []
      if (!this.acceptEdge(data.parentCallId, data.subCallId)) return true
      this.childrenByParent.set(data.parentCallId, [...siblings, running])
      this.revision++
      return true
    }
    if (event.type !== 'tool/code-dispatch') return false
    const data = event.data
    const siblings = this.childrenByParent.get(data.parentCallId) ?? []
    const at = siblings.findIndex(sub => sub.callId === data.subCallId)
    if (at === -1 && !this.acceptEdge(data.parentCallId, data.subCallId)) return true
    const started = at === -1 ? undefined : siblings[at]
    const settled: ToolResultNode = {
      kind: 'tool-result',
      seq: event.seq,
      time: event.time,
      callId: data.subCallId,
      call: { name: data.name, argsRaw: JSON.stringify(data.arguments) },
      callTime: started?.time ?? null,
      content: data.content,
      isError: data.isError,
      callView: null,
      resultView: null,
      subCalls: [],
    }
    this.childrenByParent.set(
      data.parentCallId,
      at === -1
        ? [...siblings, settled]
        : siblings.map((sub, index) => index === at ? settled : sub),
    )
    this.revision++
    return true
  }

  /**
   * 为 Node 列表中所有已完成根节点附加递归投影的子节点。
   * @param nodes - 缓存稳定的基础对话 Nodes。
   * @returns 没有根变化时返回原列表，否则返回结构共享的新列表。
   */
  projectNodes(nodes: readonly ConversationNode[]): readonly ConversationNode[] {
    if (this.nodesCache?.source === nodes && this.nodesCache.revision === this.revision) {
      return this.nodesCache.value
    }
    const projected = nodes.map((node): ConversationNode => {
      if (node.kind !== 'tool-result') return node
      return this.projectBlock(node) as ToolResultNode
    })
    const value = sameReferences(nodes, projected) ? nodes : projected
    this.nodesCache = { source: nodes, revision: this.revision, value }
    return value
  }

  /**
   * 为所有运行中根调用附加递归投影的子节点。
   * @param calls - 缓存稳定的基础运行中调用。
   * @returns 没有根变化时返回原列表，否则返回结构共享的新列表。
   */
  projectRunningCalls(calls: readonly RunningToolCall[]): readonly RunningToolCall[] {
    if (this.runningCache?.source === calls && this.runningCache.revision === this.revision) {
      return this.runningCache.value
    }
    const projected = calls.map(call => this.projectBlock(call) as RunningToolCall)
    const value = sameReferences(calls, projected) ? calls : projected
    this.runningCache = { source: calls, revision: this.revision, value }
    return value
  }

  private projectBlock(block: ToolCallBlock): ToolCallBlock {
    const children = this.childrenByParent.get(block.callId) ?? block.subCalls
    const projectedChildren = children.map(child => this.projectBlock(child))
    const childValue = sameReferences(children, projectedChildren)
      ? children
      : projectedChildren
    const cached = this.projectedByCall.get(block.callId)
    if (cached?.source === block && sameReferences(cached.children, childValue)) {
      return cached.value
    }
    const value: ToolCallBlock = block.subCalls === childValue
      ? block
      : { ...block, subCalls: childValue }
    this.projectedByCall.set(block.callId, {
      source: block,
      children: childValue,
      value,
    })
    return value
  }

  /**
   * 仅当所有递归消费者都能安全遍历时接受依赖边。Host 生成的 ID 会排除循环，当前
   * binding 也只生成一层；格式错误的传输/历史边会被消费，但不会隐藏 session 其余内容。
   */
  private acceptEdge(parentCallId: string, subCallId: string): boolean {
    if (this.wouldCreateCycle(parentCallId, subCallId)) return false
    const pending = [{
      callId: subCallId,
      depth: (this.depthByCall.get(parentCallId) ?? 1) + 1,
    }]
    const updates = new Map<string, number>()
    for (const candidate of pending) {
      const knownDepth = updates.get(candidate.callId)
        ?? this.depthByCall.get(candidate.callId)
        ?? 1
      if (candidate.depth <= knownDepth) continue
      if (candidate.depth > MAX_TOOL_CALL_TREE_DEPTH) return false
      updates.set(candidate.callId, candidate.depth)
      for (const child of this.childrenByParent.get(candidate.callId) ?? []) {
        pending.push({ callId: child.callId, depth: candidate.depth + 1 })
      }
    }
    for (const [callId, depth] of updates) this.depthByCall.set(callId, depth)
    return true
  }

  private wouldCreateCycle(parentCallId: string, subCallId: string): boolean {
    if (parentCallId === subCallId) return true
    const pending = [subCallId]
    const visited = new Set(pending)
    for (const callId of pending) {
      for (const child of this.childrenByParent.get(callId) ?? []) {
        if (child.callId === parentCallId) return true
        if (visited.has(child.callId)) continue
        visited.add(child.callId)
        pending.push(child.callId)
      }
    }
    return false
  }
}
