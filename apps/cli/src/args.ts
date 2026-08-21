/**
 * `dsh` 命令行的 Commander 适配器。
 *
 * 启动器只解析自己拥有的参数：要启动的 profile、额外应用的 patch overlay，以及配置
 * 导出。启动器将**自身 flag 之后的全部内容**原样交给已启动的配置树，由注入的应用插件
 * 解析各自的 flag 并打印自己的 `--help`（参见 `@deepseek-ai/dsh-cmdline`）。因此启动器
 * flag 必须放在前面；本解析器不认识的第一个 token 是内部参数的起点。例如，
 * `dsh --profile tui --resume abc` 启动 tui profile 并传入 `--resume abc`，而
 * `dsh --profile web -h` 打印 web 应用的帮助，而不是启动器帮助。
 *
 * `web` 是 `--profile web` 的固定别名；`plugin` 通过转发给 pnpm 来管理 profile 的
 * 插件依赖。
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError } from 'commander'

/** 启动指定 profile，并把本次调用的内部参数交给它。 */
interface ProfileInvocation {
  mode: 'profile'
  profile: string
  /** 按 argv 顺序在 profile 自有层之后应用的额外 patch-list overlay。 */
  patches: string[]
  /** 启动器自身 flag 之后的全部原始参数，供注入的应用插件解析。 */
  args: string[]
}

/** 打印组合后的 profile 配置树并退出，不启动应用。 */
interface DumpConfigInvocation {
  mode: 'dump-config'
  profile: string
  /** 省略 profile 用户层和 --patch overlay，只打印 bundle 层。 */
  defaultOnly: boolean
  patches: string[]
}

/** 管理 profile 插件：在 profile 目录中把 `args` 转发给 pnpm。 */
interface PluginInvocation {
  mode: 'plugin'
  profile: string
  /** 原样转发的 pnpm 参数。 */
  args: string[]
}

/** 解析后的 `dsh` 调用；帮助、版本和错误会在 {@link parseDshArgs} 内直接退出。 */
export type DshInvocation = ProfileInvocation | DumpConfigInvocation | PluginInvocation

/** 默认命令与 `web` 别名共用的启动器 flag。 */
interface BootOptions {
  patch?: string[]
  dumpConfig?: boolean
  dumpDefaultConfig?: boolean
}

/**
 * 可重复使用的单值收集器，例如 `--patch a.yml --patch b.yml`。这里不能使用变长参数，
 * 否则 `--patch` 会吞掉后续内部参数。
 */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

/** 启动器自己的帮助文本；每个应用分别打印自己的帮助。 */
const HELP_EXAMPLES = `
示例：
  dsh --profile web                          启动 web profile（等同于 dsh web）
  dsh --profile headless "run the tests"     处理一项任务、打印结果并退出
  dsh --profile tui --patch ./extra.yml      启动自定义 profile，并额外应用一层 overlay
  dsh --profile tui --resume <session>       将启动器 flag 之后的参数交给应用
  dsh --profile web --help                   显示 web 应用自己的 flag 与帮助
  dsh plugin --profile tui add <package>     向 tui profile 安装插件
`

/**
 * 根据启动器 flag 和剩余内部参数解析启动或配置导出调用。
 * @param program - 已解析选项的命令，即根命令或 `web` 别名。
 * @param profile - 这些 flag 要启动的 profile。
 * @param options - Commander 收集的启动器 flag。
 * @param args - 按 argv 顺序排列的剩余参数。
 * @returns 解析后的调用。
 */
function resolveBoot(program: Command, profile: string, options: BootOptions, args: string[]): DshInvocation {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch 需要路径')
  if (options.dumpConfig !== true && options.dumpDefaultConfig !== true) {
    return { mode: 'profile', profile, patches, args }
  }
  if (options.dumpConfig === true && options.dumpDefaultConfig === true) {
    program.error('error: --dump-config 与 --dump-default-config 不能同时使用')
  }
  // 配置导出不会启动应用，也不会运行应用命令行提供方，因此无法体现这些 flag 的决策。
  // 若打印的配置树与同一次调用实际启动的配置树不同，就会误导用户。
  if (args.length > 0) {
    program.error(`error: 配置导出不接受应用参数，收到 ${args.map(argument => JSON.stringify(argument)).join(' ')}`)
  }
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && patches.length > 0) {
    program.error('error: --dump-default-config 只打印组合包层，不能与 --patch 同时使用')
  }
  return { mode: 'dump-config', profile, defaultOnly, patches }
}

/**
 * 将 argv 解析为一次调用；遇到帮助、版本或错误时打印信息并退出。
 * @param argv - Node 可执行文件和脚本之后的参数。
 * @param version - `--version` 打印的版本字符串。
 * @returns 解析后的调用。
 */
export function parseDshArgs(argv: readonly string[], version: string): DshInvocation {
  let resolved: DshInvocation | undefined
  // 这里显式标注类型而不依赖推断：下方 action 会回调 `program`，推断会沿调用链形成循环。
  const program: Command = new Command()
  program
    .name('dsh')
    .version(version, '-V, --version', '输出版本号')
    .description('dsh：启动一个 DeepSeek Harness profile；它由插件组合包 patch 层按顺序叠加，并接受用户覆盖配置。')
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    // 启动器 flag 位于最前面，并在第一个未知 token 处结束；从那里开始的全部参数（包括
    // `-h`）都属于已启动的应用。没有 profile 的 `dsh -h` 仍由下方逻辑打印启动器帮助。
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', '传给已启动 profile 应用的参数（参见 dsh --profile <name> --help）')
    .option('--profile <name>', '要启动的 $DSH_HOME/profiles 下 profile')
    .option('--patch <path>', '在 profile 层之后应用的额外 patch 列表 overlay（可重复）', collect)
    .option('--dump-config', '打印组合后的 profile 配置树并退出')
    .option('--dump-default-config', '打印不含用户层和 --patch overlay 的 profile 配置树并退出')
    .action((args: string[], options: BootOptions & { profile?: string }) => {
      // `-h` 通常由应用拥有；裸 `dsh -h` 没有可接收参数的 profile，只能打印启动器帮助。
      if (options.profile === undefined) {
        if (args.some(argument => argument === '-h' || argument === '--help')) program.help()
        program.error('error: 必须提供 --profile <name>')
      }
      const profile = options.profile
      if (profile === '') program.error('error: --profile 需要名称')
      resolved = resolveBoot(program, profile, options, args)
    })

  /** 拒绝在子命令之前提供的父命令选项。 */
  const rejectParentOptions = (command: string): void => {
    const parent = program.opts<BootOptions & { profile?: string }>()
    if (parent.profile !== undefined || parent.patch !== undefined
      || parent.dumpConfig !== undefined || parent.dumpDefaultConfig !== undefined) {
      program.error(`error: ${command} 不能与父命令的 --profile、--patch、--dump-config 或 --dump-default-config 同时使用`)
    }
  }

  const web = program.command('web').description('启动 web profile（--profile web 的别名）；其后可跟 web 应用自己的 flag')
  web
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', '传给 web 应用的参数（参见 dsh web --help）')
    .option('--patch <path>', '在 profile 层之后应用的额外 patch 列表 overlay（可重复）', collect)
    .option('--dump-config', '打印组合后的 web profile 配置树（含用户层与所有 --patch）并退出')
    .option('--dump-default-config', '打印 web profile 的组合包层（不含用户层）并退出')
    .action((args: string[], options: BootOptions) => {
      rejectParentOptions('web')
      resolved = resolveBoot(web, 'web', options, args)
    })

  const plugin = program.command('plugin').description('把剩余参数转发给 profile 目录中的 pnpm，以管理该 profile 的插件')
  plugin
    .requiredOption('--profile <name>', '要管理插件的 profile（首次使用时初始化）')
    .allowUnknownOption()
    .argument('[args...]', '原样转发的 pnpm 参数（add <pkg>、remove <pkg>、why <pkg>……）')
    .action((args: string[], options: { profile: string }) => {
      rejectParentOptions('plugin')
      if (options.profile === '') program.error('error: --profile 需要名称')
      if (args.length === 0) program.error('error: plugin 需要可转发的 pnpm 参数（例如 add <package>）')
      resolved = { mode: 'plugin', profile: options.profile, args }
    })

  try {
    program.parse(argv, { from: 'user' })
  } catch (error) {
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  /* v8 ignore next -- action 必然完成解析，否则 Commander 会抛错 */
  if (resolved === undefined) throw new Error('dsh: no invocation resolved')
  return resolved
}
