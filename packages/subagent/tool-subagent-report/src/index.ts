/**
 * child-scoped `report` Tool 及其使用指引，安装到每个可继续进程内子 Agent 的未发布
 * context 中。root、one-shot 子 Agent、远程 Provider 和无 Agent 执行都看不到该注册。
 *
 * @module @deepseek-ai/dsh-tool-subagent-report
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentReportDelivery } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'

// 中文学习说明：报告工具的 description、参数说明和提示词段落都只给子 agent 模型
// 使用，用于规定何时、以什么内容向父级报告；保留英文运行时文本，避免改变委派行为。
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-subagent-report'
// 此贡献只通过 childCtx.tools 和 childCtx.systemPrompt 注册，但显式声明两个服务可让
// Loader 顺序问题在加载时失败，而不是等到下一个子 Agent 实例化时才失败。
export const inject = ['subagents', 'tools', 'systemPrompt']

/** 指引顺序：位于可继续子 Agent 携带的所有逐 Tool 段之后。 */
const REPORT_SECTION_ORDER = 117

// 中文：配置父 Agent 如何调度已接受的报告。默认 `next-step` 会唤醒父 Agent，并在最近的
// 步骤边界进入；`quiet` 添加相同上下文但不唤醒，已停驻的父 Agent 会等待其他唤醒输入。
// 下方英文 JSDoc 是配置目录的生成来源。
/** Config: how accepted reports are scheduled on the parent. */
export interface Config {
  /**
   * Parent scheduling (default `next-step`). `next-step` wakes the parent and
   * enters at its nearest step boundary; `quiet` adds the same context without
   * waking, so a parked parent waits for another waking input.
   */
  reportDelivery?: SubagentReportDelivery
}

export const Config: z<Config> = z.object({
  reportDelivery: z.union(['quiet', 'next-step'] as const).default('next-step'),
})

/**
 * 把 `report` 及其使用指引安装到一个可继续子 Agent 的 scope。两个注册均归该 scope
 * 所有，因此父 Agent 和同级 Agent 都不可见。
 * @param childCtx - 接收 Tool 和指引的 child-scoped context。
 * @param ctx - 用于交付的服务上下文。
 * @param delivery - 已解析的部署调度策略。
 * @returns disposer；报告清理失败前会尝试撤销两个子 Agent 注册。
 */
export function installReportTool(
  childCtx: Context,
  ctx: Context,
  delivery: SubagentReportDelivery,
): () => void {
  // 下方英文会作为可继续子 Agent 的 report Tool 指引发送给模型。中文译文：结束前用
  // report Tool 交付结果，只调用一次并给出自包含答案。启动你的 Agent 虽共享 workspace，
  // 但不会自动获得你的 transcript、Tool 输出或推理，因此仅说“done”没有可用信息。
  // 部分发现会改变父 Agent 下一步时也应提前报告；report 不会结束当前 turn。
  // 运行时原文保持不变，以保护子 Agent 交付协议和快照。
  const disposeSection = childCtx.systemPrompt.section({
    name: 'tool:report',
    order: REPORT_SECTION_ORDER,
    text: 'Deliver your result with the report tool before you finish: call it once with a self-contained '
      + 'answer. The agent that started you shares your workspace but does not automatically receive your '
      + 'transcript, tool output, or reasoning, so a closing remark such as "done" leaves it nothing it can '
      + 'use. Report earlier as well whenever a partial finding changes what that agent should do next; '
      + 'reporting never ends your turn.',
  })
  let disposeTool: () => void
  try {
    disposeTool = childCtx.tools.register(defineTool({
      name: 'report',
      description:
        'Report selected content to the agent that started you. Call this once before you finish, with a '
        + 'self-contained final result, and earlier for progress or findings that change what that agent does '
        + 'next. That agent shares your workspace but does not automatically receive your transcript, tool '
        + 'output, or reasoning, so finishing your work is not itself a result. Reporting does not end your '
        + 'turn or finish your work, and only your direct parent receives it. A failed call may still have '
        + 'arrived, so do not blindly repeat it.',
      parameters: {
        output: {
          type: 'string',
          required: true,
          description: 'Actionable content for your parent; summarize conclusions and reference relevant shared paths.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            messageId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `report accepted by the agent that started you as message ${value.messageId}`,
        }],
      },
      async execute(args, exec) {
        const content: ContentBlock[] = [{ type: 'text', text: args.output }]
        // Scope-local resolution guarantees an Agent. The service still verifies
        // its exact live Activation identity at the authority boundary.
        const messageId = await ctx.subagents.reportFrom(exec.agent as Agent, content, {
          delivery,
          signal: exec.signal,
        })
        return { messageId }
      },
    }))
  } catch (error: unknown) {
    try {
      disposeSection()
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        'failed to register the report tool and roll back its prompt guidance',
      )
    }
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [disposeTool, disposeSection]) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke report tool and prompt registrations')
    }
  }
}

/**
 * Register the continuable-child contribution.
 * @param ctx - context carrying tools, the system prompt, and the subagent service.
 * @param config - deployment scheduling policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Config() applies the schema default at runtime; the schemastery return
  // type keeps the input's optional shape, so assert the resolved one.
  const { reportDelivery } = Config(config) as { reportDelivery: SubagentReportDelivery }
  ctx.subagents.registerContinuableSetup(childCtx =>
    installReportTool(childCtx, ctx, reportDelivery))
}
