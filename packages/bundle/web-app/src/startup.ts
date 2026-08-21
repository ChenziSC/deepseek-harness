/**
 * Web 应用的命令行提供方：解析 `dsh --profile web` 的 flag 组（`--host`、
 * `--port`、`--trusted-host`、`--no-open`）和 `--help` 文本，再通过
 * {@link WEB_STARTUP_SERVICE} 提供不可变取值。普通行会先注入该服务，再从惰性配置读取。
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** 稳定的 Cordis 插件名。 */
export const name = 'web-startup'

/** 解析 flag 前必须就绪的服务。 */
export const inject = ['cmdlineArgs']

/** 本普通插件提供、由 flag 配置行注入的服务。 */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** Web 行从 {@link WEB_STARTUP_SERVICE} 读取的值。 */
export interface WebStartupValues {
  /** 本次调用是否在启动后打开默认浏览器。 */
  openBrowser: boolean
  /** `--host`；本次调用未指定时缺省。 */
  host?: string
  /** `--port`；本次调用未指定时缺省。 */
  port?: number
  /** 显式指定的 `--trusted-host` authority，按参数顺序排列。 */
  trustedHosts: string[]
}

/** Commander 解析后的 Web flag 组。 */
interface WebOptions {
  host?: string
  open: boolean
  port?: string
  trustedHost?: string[]
}

/**
 * 本应用的命令定义，包括 flag、说明和帮助文本。
 * @returns 全新的 program，使同一进程可以多次解析（供测试使用）。
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('提供 DeepSeek Harness 浏览器 UI。')
    .helpOption('-h, --help', '显示此帮助')
    .option('--host <host>', '绑定的 host')
    .option('--no-open', '不要在默认浏览器中打开 Web UI')
    .option('--port <port>', '监听端口；传入 0 让操作系统选择空闲端口')
    .option('--trusted-host <authority...>', '/api 浏览器信任栅栏额外接受的 authority（host 或 host:port；可重复）')
    .addHelpText('after', `
示例：
  dsh --profile web                          使用组合后的 host 与端口提供服务
  dsh --profile web --no-open                提供服务但不打开浏览器
  dsh --profile web --port 8080              改用其他端口提供服务
`)
}

/**
 * 解析 Web 调用，并将其作为普通 Cordis 服务提供。命令 action 发布本次调用指定的 flag；
 * `--host 0.0.0.0` 或非数字 `--port` 属于用法错误，因此拒绝时（以及处理 `--help` 时）
 * 不会提供任何服务。
 * @param ctx - 携带命令行的插件上下文。
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.host === '0.0.0.0') {
      program.error('error: 出于安全考虑，目前有意不支持 --host 0.0.0.0；该地址会向网络暴露远程代码执行能力，请改用 127.0.0.1')
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port 必须是数字，收到 ${JSON.stringify(options.port)}`)
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts: options.trustedHost ?? [],
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
