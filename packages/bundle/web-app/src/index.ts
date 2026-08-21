/**
 * @deepseek-ai/dsh-web-app —— 浏览器界面 Bundle 的运行时胶水插件，以及由
 * `dsh.bundle.patch` manifest 字段声明的 Bundle patch（`cordis.patch.yml`）。本插件负责
 * 浏览器界面胶水：解析已构建的 frontend dist（属于本 Bundle 的 workspace 知识，而非
 * 用户配置），在其上挂载 `frontend-static` fallback owner，注册 harness-source 与
 * web-surface Prompt 段、bash 可见的 Web 运行时变量、URL 输出行和默认浏览器交接。
 * App 命令行值通过 Bundle patch 中的 `webStartup` 服务表达式传入。
 * @module @deepseek-ai/dsh-web-app
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell-env'

/** 稳定的 Cordis 插件名。 */
export const name = 'web-app'

/** 当前 dsh 安装根目录；可从本包源码入口或构建后入口解析。 */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** 绑定相关值解析完毕后放行 Web 行的运行时服务。 */
const WEB_RUNTIME_SERVICE = 'webRuntime'

/** Web 运行时挂载前所需的服务。 */
export const inject = ['webServer']

// 中文：插件配置由组合后的部署设置与每次调用的命令行值组成。openBrowser 控制 Loader
// tree 稳定后的默认浏览器交接，SSH 启动会抑制它；printUrl 控制激活时的 URL 输出；
// surfaceContext 控制模型可见的界面 Prompt 与 DSH_WEB_URL，非 GUI 的 one-shot 层可关闭；
// trustedHosts 保存本次调用显式传入的 authority。下方英文 JSDoc 是配置目录生成来源。
/** Plugin config: composed deployment settings plus per-invocation command-line values. */
export interface Config {
  /** Permit default-browser handoff after the Loader tree settles; an SSH launch suppresses it. */
  openBrowser: boolean
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
  /**
   * Register the model-visible surface context (the `app:web-surface` prompt
   * section and the `DSH_WEB_URL` bash variable). A one-shot non-interactive
   * layer can turn it off when its user is not in the GUI, so the
   * orientation text would be false.
   */
  surfaceContext: boolean
  /** Explicit `--trusted-host` authorities from this invocation. */
  trustedHosts: string[]
}

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
})

/** trust fence 与 URL 展示共用、依赖绑定结果的 Web 值。 */
export interface WebRuntimeValues {
  /** Server 绑定所有接口时一次性采样的 LAN IPv4 literal。 */
  lanAddresses: string[]
  /** LAN literal，后接调用时显式传入的 authority。 */
  trustedHosts: string[]
}

/** 保存此 Web GUI 规范本地 URL 的环境变量。 */
const DSH_WEB_URL = 'DSH_WEB_URL' as const

// 仅用于展示的 webserver schema loopback host 镜像：本地 URL 始终输出该地址。
// 它不是事实来源，schema 才是。
const LOOPBACK_HOST = '127.0.0.1'
/** webserver schema 中表示绑定所有接口的 literal。 */
const ALL_INTERFACES_HOST = '0.0.0.0'

/** 当前进程是否通过 SSH 启动，包括端口转发 Session。 */
function launchedThroughSsh(ctx: Context): boolean {
  const environment = launchEnvironmentOf(ctx)
  return ['SSH_CONNECTION', 'SSH_TTY'].some((name) => {
    const value = environment.getFrom(name, ['process'])?.value
    return value !== undefined && value !== ''
  })
}

const BROWSER_OPENER_MODULE = import.meta.resolve('open')

const BROWSER_OPENER_PROGRAM = `
try {
  const { default: open } = await import(${JSON.stringify(BROWSER_OPENER_MODULE)})
  const launcher = await open(process.argv[1])
  if (process.platform === 'win32') {
    // open 在 PowerShell spawn 时即完成；保持引用，直到该 launcher 把 URL 交给 Windows。
    const code = launcher.exitCode ?? await new Promise((resolve, reject) => {
      function onError(error) {
        launcher.off('close', onClose)
        reject(error)
      }
      function onClose(code) {
        launcher.off('error', onError)
        resolve(code)
      }
      launcher.ref()
      launcher.once('error', onError)
      launcher.once('close', onClose)
    })
    if (code !== 0) throw new Error('browser operating-system launcher exited with code ' + String(code))
  }
  process.exitCode = 0
} catch (error) {
  // 父进程把此次退出转换为手动打开 URL 的警告。
  console.error(error)
  process.exitCode = 1
}
`

/**
 * 根据活动 Server 的绑定配置解析一次 LAN trust 快照。
 *
 * 派生条目是不带端口的 IP literal：DNS rebinding 需要攻击者控制的名称，而 IP literal
 * Host 在任意端口都安全，并且绑定前无法得知操作系统分配的端口。
 * @param bindHost - 活动 webserver 的绑定 host。
 * @param extra - 按参数顺序排列的显式 `--trusted-host` 值。
 * @returns LAN 展示地址和从本次调用派生的 fence authority。
 */
export function resolveLanTrust(bindHost: string, extra: readonly string[]): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

// 该函数生成通过 `dsh web` 创建的 Session 所见 system prompt 段。中文译文：
// 你正通过 webUrl 指向的 DeepSeek Harness Web GUI 与用户交互。用户未指定其他目标而说
// “此页面”“此 GUI”或“此应用”时，指的就是该 GUI。浏览器不会隐式提供 DOM、路由或
// 截图上下文。client-plugin HMR receiver 已启用，但只有同一 checkout 还运行
// `pnpm run dev:web` 重建 bundle 时，client-plugin 修改才能无刷新加载；承诺自动更新前
// 应先确认 watcher。其他修改（apps/web shell 和普通 package）都必须重建受影响的 Web
// artifact，并刷新页面后在现有 URL 验证。启动另一台 server 不会更新当前 GUI。
// apps/web 的 Vite entry 只构建 shell，不是独立应用，因为只有 dsh web 注入
// window.__DSH_BOOT__。除非用户要求，不要启动替代 server；确有需要时，用受管后台 Job
// 并验证准确 URL。webUrl 在运行时插入；英文原文保持不变以维持模型行为。
/** 为通过 `dsh web` 创建的 Session 提供模型可见定位与验收范围。 */
function webSurfacePrompt(webUrl: string): string {
  const updateContract = 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
    + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  return `You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}. `
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + updateContract
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
}

/** 从活动 Web server 解析规范的 loopback URL。 */
function localWebUrl(ctx: Context): string {
  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error('web-app: webServer service missing while resolving Web runtime')
  return `http://${LOOPBACK_HOST}:${String(port)}`
}

/** Dist 位置属于本 bundle 的 workspace 知识：通过 frontend 包 exports 解析，而非配置。 */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  } catch {
    /* v8 ignore next 2 -- reachable only on a checkout without a built dist; the test tree builds it */
    throw new Error('web-app: frontend dist not built; run pnpm run build from the repository root first')
  }
}

/** 启动受维护的平台 opener，且不转发 Harness 凭据。 */
function spawnBrowserLauncher(url: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module',
    '--eval', BROWSER_OPENER_PROGRAM,
    '--', url,
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}

/** 把 URL 交给操作系统的默认浏览器。 */
async function openBrowser(url: string): Promise<void> {
  const launcher = spawnBrowserLauncher(url)
  let launcherStderr = ''
  launcher.stderr?.setEncoding('utf8')
  launcher.stderr?.on('data', (chunk: string) => { launcherStderr += chunk })
  await new Promise<void>((resolve, reject) => {
    function onError(error: Error): void {
      launcher.off('close', onClose)
      reject(error)
    }
    function onClose(code: number | null): void {
      launcher.off('error', onError)
      if (code !== 0) {
        const firstLine = launcherStderr.trim().split(/\r?\n/u)[0]
        const reason = firstLine === undefined || firstLine === ''
          ? `browser launcher exited with code ${String(code)}`
          : firstLine.replace(/^(?:[A-Za-z]*Error):\s*/u, '')
        reject(new Error(reason))
        return
      }
      if (launcherStderr !== '') process.stderr.write(launcherStderr)
      resolve()
    }
    launcher.once('error', onError)
    launcher.once('close', onClose)
  })
}

/** 构建后 dist 与原生浏览器交接的测试钩子；生产环境不会修改。 */
export const internals: {
  resolveDistIndex: () => string
  openBrowser: (url: string) => Promise<void>
} = { resolveDistIndex, openBrowser }

/**
 * 挂载 Web 运行时：dist 服务、界面 Prompt、bash 运行时变量、URL 输出行和默认浏览器交接。
 * @param ctx - 携带 webServer 服务的插件上下文。
 * @param config - 已校验的 {@link Config}。
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts)
  // loopback URL 属于当前 Host。通过 SSH 时，操作者使用本进程无法推导的本地转发地址访问。
  const handoffBrowser = config.openBrowser && !launchedThroughSsh(ctx)
  // 依赖绑定结果的 trust 完成一次采样后，才放行依赖行。
  ctx.provide(WEB_RUNTIME_SERVICE, runtime)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      addHarnessSourceSection(promptCtx, SOURCE_ROOT)
      promptCtx.systemPrompt.section({
        name: 'app:web-surface',
        order: -98,
        text: () => webSurfacePrompt(localWebUrl(promptCtx)),
      })
    })
    ctx.inject(['shellEnv'], (runtimeCtx) => {
      runtimeCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [DSH_WEB_URL]: { description: 'Canonical local URL of the DeepSeek Harness Web GUI serving this session.' },
        },
        resolve: () => ({ [DSH_WEB_URL]: localWebUrl(runtimeCtx) }),
      })
    })
  }
  if (config.printUrl || handoffBrowser) {
    // URL 输出行与浏览器交接都是就绪信号：supervisor 看到该行就会发起 RPC，浏览器打开后
    // 也会立即请求页面。因此，在 `/api` route owner 等同级行仍在挂载时，两者都不能执行。
    // 先等待 Loader 稳定；不带 Loader 的手工构造 tree 已经是完整 tree。
    const announceReady = (): void => {
      const webUrl = localWebUrl(ctx)
      // 复用提供给 `/api` trust fence 的同一份 LAN 快照。
      const lanCandidate = runtime.lanAddresses[0]
      const port = ctx.webServer.port
      if (config.printUrl) {
        console.log(`dsh web: ${webUrl}${lanCandidate === undefined ? '' : ` (LAN: http://${lanCandidate}:${String(port)})`}`)
      }
      if (handoffBrowser) {
        console.log('dsh web: opening the default browser; pass --no-open to disable')
        void internals.openBrowser(webUrl).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          console.error(`web-app: could not open the default browser because ${reason}; visit ${webUrl} manually`)
        })
      }
    }
    // 本行自身可能在同级行失败前激活。App 通过等待其 Loader tree 掌管就绪时机；若 context
    // 为不带 Loader 的手工构造，则立即宣告就绪。
    const settled = ctx.get('loader')?.await()
    if (settled === undefined) announceReady()
    else {
      void settled.then(() => {
        // 启动仍在进行时 tree 可能已被释放（例如提前收到 SIGTERM）。为已停止的 Server
        // 输出 URL 或打开浏览器只会造成误导，而读取已拆除的端口会把正常关闭变成崩溃。
        if (ctx.get('webServer') !== undefined) announceReady()
      // Loader 负责报告启动失败；本行只需保持静默。
      }, () => {})
    }
  }
}
