/**
 * 一次性应用的命令行提供方：解析任务位置参数与 `--help`，然后发布
 * {@link HEADLESS_STARTUP_SERVICE}。runner 是普通消费者，其惰性配置会等待该服务。
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** 稳定的 Cordis 插件名。 */
export const name = 'headless-startup'

/** 解析任务前必须就绪的服务。 */
export const inject = ['cmdlineArgs']

/** 本插件提供、由一次性 runner 注入的服务。 */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** runner 行从 {@link HEADLESS_STARTUP_SERVICE} 读取的值。 */
export interface HeadlessStartupValues {
  /** 本次调用要求执行的任务文本。 */
  task: string
}

/**
 * 本应用的命令定义，包括任务位置参数、说明和帮助文本。
 * @returns 全新的 program，使同一进程可以多次解析（供测试使用）。
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('处理一项任务，打印 assistant 的最终消息，然后退出。')
    .helpOption('-h, --help', '显示此帮助')
    .argument('[task...]', '任务文本；多个词会用空格连接')
    .addHelpText('after', `
示例：
  dsh --profile headless "run the tests"     处理一项任务并退出
`)
}

/**
 * 解析一次性任务，并将其作为普通 Cordis 服务提供。命令 action 发布任务；缺失或仅含
 * 空白的任务属于用法错误，因此拒绝时（以及处理 `--help` 时）不会提供任何服务。
 * @param ctx - 携带命令行的插件上下文。
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  program.action(() => {
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: 必须提供任务，例如：dsh --profile headless "run the tests"')
    ctx.provide(HEADLESS_STARTUP_SERVICE, { task } satisfies HeadlessStartupValues)
  })
  parseCmdline(ctx, program)
}
