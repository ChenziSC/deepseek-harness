/**
 * 默认 Agent 驱动器：处理排队的 Turn 和 Step 边界输入。每次模型请求都从 Session 日志派生。
 * @module dsh-agent-loop/agent
 */

// 学习入口：ReactLoopAgent 只拥有驱动时序。wakeDriver/kick 管理一次驱动占用，turn
// 建立 Turn/Step 事件边界，preStep 领取 inbox 并组装上下文，step 请求模型并派发工具。
// 提示词、工具策略、压缩和重试等行为应由扩展点插件贡献，不应继续堆进这个循环。

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  createAssistantMessage,
  deepFreeze,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import { RuntimeContextProjection } from './runtime-context.ts'
import { executeToolCalls } from './tool-calls.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }

/** 插件生成下一次请求配置前，移除由 Adapter 默认补出的值。 */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/** 驱动一个 Session 依次跨越 Turn 与 Step 边界。 */
export class ReactLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  private readonly runtimeContext: RuntimeContextProjection

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // 唤醒输入不能加入已经取消的活动，因此会启动下一 Turn。必须在插入前决定目标，避免
    // splice 观察器重入 cancel 后又改变这条消息的分类。
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // 维护状态和已取消驱动器无法立即处理唤醒，因此先锁存，待状态收敛时重放。存活驱动器
      // 会自行领取队列；释放状态不会锁存，确保清理无需等待新的模型 Turn。
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // 已报告的失败和取消都在驱动器边界内收口，不再向外形成未处理异常。
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }

  /**
   * 执行一个完整 Turn，并保证日志中始终存在配对的 `turn/start` 与 `turn/end`。
   *
   * 一个 Turn 可以包含多个 Step：模型返回工具调用时，工具结果进入下一 Step；模型已经
   * 结束但此时又收到 `next-step` 输入时，也在当前 Turn 继续处理。正常关闭当前 Turn 后，
   * 如果 Inbox 仍有待下一 Turn 处理的消息，则返回 `true`，让 {@link kick} 立即开启下一
   * Turn。策略拒绝或初始输入为空会直接返回 `false`，停止当前驱动器。
   */
  private async turn(): Promise<boolean> {
    // 步骤 1：确认只有已经取得驱动权的 running Phase 才能进入 Turn。这里保存的 signal
    // 贯穿整个 Turn；取消、Agent 释放和外层生命周期清理最终都会使它进入 aborted 状态。
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()

    // 步骤 2：先建立持久的 Turn 边界，再领取 Inbox。这样即使唤醒消息在领取前被删除、
    // pre-step 插件拒绝执行或后续发生异常，日志中仍能看到这次真实发生过的驱动尝试。
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn

    // turnEnds 为 null 表示当前 Step 结束后仍需要模型继续，例如模型刚发起了工具调用；
    // completed/max-tokens 等非空值表示模型流程已经给出结束原因，但新 next-step 输入仍可能
    // 在真正关闭 Turn 前把它重新带入下一 Step。
    let turnEnds: TurnEndReason | null = null

    // 第一个 Step 使用 next-turn：Inbox.claim 会先取走全部 next-step 消息，再取一条排队的
    // next-turn 消息。后续 Step 改用 next-step，不会把下一条独立用户任务提前并入当前 Turn。
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        // 步骤 3：为下一 Step 领取输入并组装 Prompt。preStep 已经完成三件事：从 Inbox
        // 持久领取消息、组装当前 Scope 的 System Prompt/Tool、运行 agent/pre-step Waterfall。
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })

        // pre-step 的 reject 是可预期的策略阻止，不作为异常上报；Turn 以 blocked 正常收尾，
        // 并直接停止当前驱动器，不进入方法末尾的“自动开启下一 Turn”判断。
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }

        // 上一个 Step 已经产生结束原因，且这次没有领取到新消息，说明当前 Turn 确实可以关闭。
        if (turnEnds && decision.messages.length === 0) break

        // 即使唤醒消息已被移除，或 enter 决策被改写为空，它仍然占用初始 Turn 边界，
        // 但不会创建 Step 或发起模型调用。return 仍会先执行下方 finally，补写 turn/end。
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }

        // 步骤 4：建立 Step 边界，再把本 Step 真正消费的消息写入模型可见 Surface。消息只有
        // 在 pre-step 策略最终接受后才进入历史，尚未领取或被拒绝的 Inbox 项不会污染上下文。
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          // 只有真正进入本 Step 的消息才写入模型可见日志；仍在 Inbox 中等待的消息不会
          // 提前进入上下文，因此 followup、steer 和 inject 的时序能够被准确重放。
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          // max-tokens 具有粘性：任一 Step 达到上限后，后续正常完成的 Step 不能把整个
          // Turn 的结果降级为 completed。
          const stepEnd = await this.step(decision.assembly)
          // 后续 Step 仍可继续处理 Inbox，但不能覆盖已经记录的 max-tokens 结果。
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          // 无论模型请求、工具执行或策略监听器怎样退出，只要 step/start 已写入，就必须写入
          // 配对的 step/end；Session 不变量和恢复逻辑依赖完整边界。
          this.session.append('step/end', { turn, step })
        }

        // 步骤 5：模型流程已经结束且暂时没有 next-step 输入时，先通知 turn-stopping 扩展点。
        // 监听器仍可在这里追加最后一条 next-step 上下文，所以通知后必须再次检查 Inbox。
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break

        // 从第二个 Step 开始只领取 next-step。典型来源是工具结果要求追加的上下文、steer、
        // inject，或者 turn-stopping 监听器刚加入的信息。
        target = 'next-step'
      }
    } catch (error: unknown) {
      // 步骤 6：把退出原因写成可持久化的 TurnEndReason。取消保留明确的 AgentCancelCause；
      // 其他错误区分 LlmError 与未知异常，并通过 throwError 发出 agent/error 后继续抛出。
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // 所有失败都转成结构化结果：LlmError 保留原始字段，其他异常展开成 errorChain 文本，
      // 并使用 UNKNOWN 错误码。
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      // finally 会在 break、return 和 throw 之前执行，因此所有已经写入 turn/start 的路径都会
      // 在离开本方法前写入 turn/end。上方每种退出路径都保证先为 turnEnds 赋值。
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }

    // 步骤 7：只有通过上方正常 break 关闭 Turn 才会到达这里。没有待处理输入时返回 false，
    // kick 的 while 结束并把 Phase 还原为 idle；若仍有 next-turn 输入，则重置每 Turn 的
    // 取消器与 Step 计数，返回 true，在同一次 Driver 占用中立即开启下一 Turn。
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // 新控制器会让旧控制器上的唤醒标记失效；仍在运行的驱动器会自行领取队列。
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(assembly: PromptAssembly): Promise<StepEndReason | null> {
    // 步骤 1：固定本 Step 的 Prompt 与取消信号。一次请求失败后的重试仍属于同一个 Step，
    // 因此沿用这份 assembly；下一个 Step 才会重新执行 preStep 并组装 Prompt。
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    // 步骤 2：构造并发送一次模型请求。这个 while 只负责 request-error 请求重试；工具调用
    // 不在这里递归请求模型，而是返回 null，让 turn() 建立具有完整日志边界的下一个 Step。
    while (true) {
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []

      // 步骤 3：消费 Adapter 的流式输出。每个原始 chunk 立即成为 assistant/chunk 事件，
      // 供 UI、持久化和精确回放使用；BlockAssembler 同时把增量拼成规范 AssistantMessage。
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        for await (const chunk of stream) {
          signal.throwIfAborted()
          chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
          assembler.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        // 取消可能发生在任意两个 chunk 之间。已收到的内容仍提交为 interrupted 消息，并引用
        // 产生它的 chunk；随后把取消交给 Turn 边界统一记录为 aborted。
        if (signal.aborted) {
          const content = assembler.interruptedBlocks()
          if (content.length > 0) {
            this.session.append('assistant/message', {
              turn,
              step,
              message: createAssistantMessage({
                content,
                source: { provider: request.provider, model: request.model },
              }),
              interrupted: true,
              ...assembler.usage === undefined ? {} : { usage: assembler.usage },
            }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
          }
        }
        throw error
      }

      // 步骤 4：处理 Provider 返回的失败终态。插件可通过 agent/request-error 决定是否重试；
      // retry 会在同一 Step 内重新构造请求，其余情况转成 LlmError 交给 Turn 结束逻辑。
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const action = await this.dispatch.waterfall(
          'agent/request-error', {
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
            signal,
          },
          () => Promise.resolve<RequestErrorAction>(undefined),
        )
        signal.throwIfAborted()
        if (action?.kind !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        continue
      }

      // 步骤 5：流正常结束后提交完整 assistant/message。原始 chunk 不进入派生消息历史，
      // 后续模型请求只读取这条规范消息；sourceEventSeqs 保留两者的可追溯关系。
      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
      })
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )

      // max-tokens 是本 Step 的明确终态：保存当前可恢复内容，但不执行其中的工具调用。
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      // 步骤 6：没有工具调用时，当前 Turn 已得到最终回答。存在工具调用时，调度器负责记录
      // call/result，并把 additionalContexts 加入 next-step。工具要求结束 Turn 时返回
      // completed；否则返回 null，由 turn() 开启下一 Step，把工具结果再次交给模型。
      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
      )
      return concluded ? { kind: 'completed' } : null
    }
  }

  /** 组装冻结的模型请求，并绑定到解析其精确模型默认值的 Adapter 注册代。 */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    signal: AbortSignal,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    // 请求不是从一份旁路 messages 状态拼出：消息来自 Session.deriveMessages，模型配置、
    // system 和工具目录则先落为 request/header。日志因此能够重建实际发送给模型的请求。
    const { session } = this

    // Loop 从声明的 Provider/Model 路由开始，只恢复属于这个精确模型的显式推理强度；
    // 后续 Step 会重新解析标记为 Adapter 默认值的配置。
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const reasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // 中间件可以接管未注册路由，但若请求最终落到默认发送流程，仍然必须存在 Adapter。
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()

    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }

    const contextWindow = preparedCall?.context?.contextWindow
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
}
