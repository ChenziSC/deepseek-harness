/**
 * 调度一个 Assistant Step 中的工具调用。独占调用形成屏障；并行调用进入有上限的滚动池，
 * 并在启动前重新分类。Dispatch 可以重叠执行，但策略、结果与结果上下文仍按模型顺序处理。
 * 取消或调度器内部失败会停止补充任务，并等待已启动调用结束。
 *
 * 取消时为跳过的调用写入合成错误结果，使重放日志保持有效。调度器最终失败时保留已经记录的
 * `tool/call` 事件，但不会伪造结果。
 * @module dsh-agent-loop/tool-calls
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertNever, createToolResultMessage, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER, type ToolExecutionInput, type ToolExecutionMode, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'

/** One tool call after argument parsing, ready to schedule. */
interface PlannedCall {
  block: ToolCallBlock
  exec: ToolExecutionInput
}

/** Settled dispatch awaiting model-order finalization. */
interface Slot {
  exec: ToolRunContext
  result: ToolExecutionResult
  needsPost: boolean
}

/** One scheduler group outcome, including a drained cancellation. */
interface GroupOutcome {
  consumed: number
  aborted: boolean
  /** Whether any committed result carried {@link ToolExecutionResult.concludesTurn}. */
  concluded: boolean
}

/**
 * 按工具当前并发模式调度一个 Assistant Step 中的调用。正常完成或取消时，已启动调用的
 * 结果都按顺序提交。取消会等待已启动调用结束，为未启动调用写入合成结果，并在接收已启动
 * 调用的上下文后返回；驱动器会把这些上下文暂存到下一 Step 的 Inbox。调度器内部失败会
 * 停止新 Dispatch、排空已启动任务，并以首个失败拒绝，不伪造工具结果。当前 AgentLoop
 * 驱动边界提供发起 Agent，并写入每个 {@link ToolExecutionInput.agent}。
 *
 * @param ctx - 拥有工具注册表并携带发起 Agent 的 Loop Context。
 * @param turn - 当前 Turn 编号。
 * @param step - 当前 Step 编号。
 * @param toolCalls - 按模型顺序排列的 Assistant 工具调用。
 * @param signal - 当前 Step 共用的取消信号。
 * @param acceptContext - 接收已提交结果产生的上下文，供下一 Step 边界使用。
 */
export async function executeToolCalls(
  ctx: Context,
  turn: number,
  step: number,
  toolCalls: ToolCallBlock[],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<{ concluded: boolean }> {
  // requireInitiator 把工具调用明确归属到当前 Agent；工具的 Scope、Session 和权限判断
  // 都从这个身份继续解析，而不是依赖某个可能串线的全局“当前会话”变量。
  const agent = ctx.agents.requireInitiator()
  const { session } = agent

  // 每次调用都创建独立输入，因为 tools/execute 包装器可能替换 exec.signal。
  const planned: PlannedCall[] = toolCalls.map(block => ({
    block,
    exec: {
      callId: block.id,
      name: block.name,
      arguments: parseArguments(block.arguments),
      agent,
      signal,
    },
  }))

  let next = 0
  let concluded = false
  while (next < planned.length) {
    // 先提交已完成结果再重新分类，使注册表变更可以影响尚未启动的调用。
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    const first = planned[next]!
    const mode = ctx.tools.executionMode(first.exec).kind
    const group = mode === 'parallel' ? planned.slice(next) : [first]
    const outcome = await runGroup(
      ctx, turn, step, group, mode, signal, acceptContext,
    )
    next += outcome.consumed
    concluded ||= outcome.concluded
    if (outcome.aborted) {
      for (const call of planned.slice(next)) appendSkippedToolCall(session, turn, step, call.block)
      return { concluded }
    }
  }
  return { concluded }
}

/** Parse model arguments, preserving invalid JSON as text and mapping empty input to `{}`. */
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}

/**
 * 运行一个独占屏障或并行池。后续调用在启动前重新分类；若重新分类为独占调用，则先等待
 * 当前并行池排空，再留给调用方的下一屏障处理。结果和上下文按模型顺序提交。取消时停止
 * 启动新调用，排空并提交已启动调用，把它们的上下文加入当前批次，为跳过的调用记录结果，
 * 并返回已取消结果。调度器失败时排空 Dispatch，但不提交合成恢复结果。
 */
async function runGroup(
  ctx: Context,
  turn: number,
  step: number,
  group: PlannedCall[],
  mode: ToolExecutionMode['kind'],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<GroupOutcome> {
  const { session } = ctx.agents.requireInitiator()
  const { maxParallelToolCalls } = ctx.agentLoop.config
  const slots: (Slot | undefined)[] = group.map(() => undefined)
  // 已启动槽位保留 tool/call 的 seq，后续结果事件必须引用它。
  const callSeqs: number[] = group.map(() => -1)
  let nextToStart = 0
  let committed = 0
  let started = 0
  let aborted: boolean = signal.aborted
  let concluded = false
  let schedulerFailure: { error: unknown } | undefined
  const throwSchedulerFailure = (): void => {
    if (schedulerFailure !== undefined) throw schedulerFailure.error
  }

  // committed 只跨过模型顺序中连续且已经完成的槽位。
  const commitReady = async (): Promise<void> => {
    // 并发只覆盖工具主体。最终提交始终从 committed 指针连续向前，较晚完成的调用必须
    // 等待较早调用，因此日志顺序与模型给出的 tool-call 顺序一致。
    while (committed < group.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = group[committed]
      const result = slot.needsPost
        ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
        : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
      appendToolResult(session, turn, step, call!.block, result, callSeqs[committed]!)
      for (const context of result.additionalContexts ?? []) acceptContext(context)
      concluded ||= result.concludesTurn === true
      committed++
    }
  }

  const inFlight = new Map<number, Promise<number>>()

  const startCall = async (index: number): Promise<void> => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
    const call = group[index]!
    callSeqs[index] = appendToolCall(session, turn, step, call.block)
    started++
    const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
    throwSchedulerFailure()
    switch (prepared.kind) {
      case 'dispatch': {
        const promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then(
          (outcome) => {
            slots[index] = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
            return index
          },
          (error: unknown) => {
            schedulerFailure ??= { error }
            return index
          },
        )
        inFlight.set(index, promise)
        break
      }
      case 'post-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: true }
        break
      case 'final-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: false }
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(prepared, 'tool-call scheduler prepare result')
    }
  }

  const fillPool = async (): Promise<void> => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
      // 每次按序提交后重新读取后续调用模式，使注册表变化能够建立新的独占屏障。
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const nextCall = group[nextToStart]!
      if (nextToStart > 0 && mode === 'parallel'
        && ctx.tools.executionMode(nextCall.exec).kind !== 'parallel') break
      await startCall(nextToStart)
      nextToStart++
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // pre-execute 等待期间也可能收到取消信号。
      if (signal.aborted) aborted = true
    }
  }

  // pre-execute 按模型顺序执行并且可能等待，只有 dispatch 和工具主体允许重叠。调度器失败
  // 后停止发起新调用，等待所有已启动调用结束，再把失败交给 Turn 边界处理。
  try {
    await fillPool()
    while (inFlight.size > 0) {
      const settledIndex = await Promise.race(inFlight.values())
      inFlight.delete(settledIndex)
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // 工具运行或按序提交等待期间也可能收到取消信号。

      if (signal.aborted) aborted = true
      await fillPool()
    }
  } catch (error: unknown) {
    schedulerFailure ??= { error }
    await Promise.allSettled(inFlight.values())
    throw schedulerFailure.error
  }

  if (aborted) {
    // 先等待已启动调用和已接收上下文稳定，再为剩余模型调用按序写入合成错误结果，最后
    // 才结束本次 Turn。
    for (const call of group.slice(started)) appendSkippedToolCall(session, turn, step, call.block)
    return { consumed: group.length, aborted: true, concluded }
  }
  /* v8 ignore next -- unreachable: a non-aborted group commits every started call */
  if (committed !== started) throw new Error('tool-call scheduler: uncommitted settled calls')
  return { consumed: started, aborted: false, concluded }
}

/** Append the durable call/result pair for a model call skipped after cancellation. */
function appendSkippedToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): void {
  const callSeq = appendToolCall(session, turn, step, block)
  appendToolResult(session, turn, step, block, {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
  }, callSeq)
}

/** Append a started call and return the event seq that its result must cite. */
function appendToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): number {
  const event = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
  return event.seq
}

/** Append a model-ordered result linked to its call event. */
function appendToolResult(
  session: Session,
  turn: number,
  step: number,
  block: ToolCallBlock,
  result: ToolExecutionResult,
  callSeq: number,
): void {
  const message = createToolResultMessage({
    callId: block.id,
    content: result.content,
    isError: result.isError,
  })
  session.append('tool/result', {
    turn, step,
    message,
    ...result.error?.info ? { error: result.error.info } : {},
    // 保存工具私有的展示数据（例如结果产生时的 diff），使 UI 在重放时能够还原同一张卡片。
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
