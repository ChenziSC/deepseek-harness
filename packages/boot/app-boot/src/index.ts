/**
 * 应用入口（`dsh`、`dsh-acp-demo`）共用的启动装配：加载被 Git 忽略的 `.env`，安装
 * Loader 失败守卫，以兼容快照的方式解析配置路径，从 Harness Home（`~/.dsh`）加载
 * 可选用户 Patch，并把路径解析器暴露给配置表达式。最后驱动 Cordis Loader 挂载叶子
 * `cordis.yml`，直到整棵插件树稳定。
 * @module @deepseek-ai/dsh-app-boot
 */

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { Context, type FiberState } from '@deepseek-ai/cordis'
import Loader, { type Entry, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createLaunchEnvironmentSnapshot, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/cordis-plugin-hmr'
// 仅导入类型副作用，使 ctx.get('systemPrompt') 能解析到对应 Service 类型。
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver available to Loader `!!js` config expressions. */
    dshHomePath?: typeof dshHomePath
  }
}

export {
  composeEntries,
  DEFAULT_PROFILE_BUNDLES,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  PROFILES_DIR,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type DshBundleManifest,
  type DshManifestSection,
  type DshProfileManifest,
  type Profile,
  type ProfileLayer,
  type ProfileManifest,
} from './profile.ts'

/**
 * Resolve the config to boot. Replay swaps a `cordis.yml` basename for
 * `cordis.snapshot.yml` in the same directory; every other mode keeps the path.
 * @param configPath - the requested config path (absolute, or relative to `cwd`).
 * @param snapshotMode - the bin's `$DSH_SNAPSHOT` value; only `'replay'` swaps the
 *   basename.
 * @param cwd - the base a relative `configPath` resolves against.
 * @returns the absolute path of the config to boot.
 */
export function resolveConfigPath(
  configPath: string, snapshotMode: string | undefined, cwd: string = process.cwd(),
): string {
  const absolute = resolve(cwd, configPath)
  if (snapshotMode !== 'replay') return absolute
  const dir = dirname(absolute)
  const replayName = basename(absolute).replace(/cordis\.ya?ml$/, 'cordis.snapshot.yml')
  return resolve(dir, replayName)
}

/**
 * Load the optional gitignored `.env` from `dir`. Missing files fall back to the
 * ambient environment; other read failures are reported through `warn`.
 * @param binName - the diagnostic prefix on the warn line.
 * @param dir - the directory whose `.env` to load.
 * @param warn - sink for the one-line misconfiguration diagnostic.
 */
export function loadEnv(
  binName: string, dir: string = process.cwd(),
  warn: (line: string) => void = line => void process.stderr.write(line),
): void {
  try {
    process.loadEnvFile(resolve(dir, '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      warn(`${binName}: failed to load .env: ${String(error)}\n`)
    }
    // 没有 .env（ENOENT）属于正常情况，此时只使用进程环境变量。
  }
}

/** Exact names no discovered file may set. */
const BOOTSTRAP_NAMES = new Set([
  // 进程启动与模块解析相关变量。
  'PATH', 'HOME', 'USERPROFILE', 'SHELL',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  // 解释器启动 Hook。
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
  'PERL5OPT', 'PERL5LIB', 'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'RUBYLIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'PYTHONHOME',
  // 版本控制 Hook、配置重定向以及外部命令选择器。
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR',
  'GIT_ASKPASS', 'SSH_ASKPASS',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
  'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
  // 网络地址与信任配置。
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
])

/** Name prefixes no discovered file may set. */
const BOOTSTRAP_PREFIXES = ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']

/**
 * Whether a variable may come only from the inherited process environment
 * because it changes process, runtime, VCS, or network bootstrap.
 * @param name - the variable name.
 * @returns true when only the inherited environment may supply it.
 */
function isBootstrapOnly(name: string): boolean {
  const upper = name.toUpperCase()
  return BOOTSTRAP_NAMES.has(upper) || BOOTSTRAP_PREFIXES.some(prefix => upper.startsWith(prefix))
}

/**
 * Parse one directory's `.env` without applying it, rejecting bootstrap-only
 * names before any value is materialized.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param dir - the directory whose `.env` to read.
 * @param warn - sink for the one-line unreadable-file diagnostic.
 * @returns the parsed entries, or `undefined` when the file is absent or unreadable.
 * @throws when the file declares a name {@link isBootstrapOnly} rejects.
 */
function readEnvLayer(
  binName: string, dir: string, warn: (line: string) => void,
): { path: string; values: Record<string, string> } | undefined {
  const path = resolve(dir, '.env')
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      warn(`${binName}: failed to load .env: ${String(error)}\n`)
    }
    // 没有 .env（ENOENT）属于正常情况，此时只使用进程环境变量。
    return undefined
  }
  // 只解析一次，保证校验与最终物化使用完全相同的条目。
  const values = parseEnv(content) as Record<string, string>
  for (const name of Object.keys(values)) {
    if (!isBootstrapOnly(name)) continue
    throw new Error(
      `${binName}: ${path} sets "${name}", which only the launching environment may set`
      + ' (it decides how this process starts, where its code and instructions load from, or how it'
      + ` reaches the network); export ${name} instead of putting it in a .env file`,
    )
  }
  return { path, values }
}

/**
 * Load the product CLI's inherited > invoking-directory `.env` > Harness-home
 * `.env` snapshot. The Harness home resolves before either file; both files
 * are checked before either is applied, and accepted values are materialized
 * without replacing inherited ones. The snapshot preserves which layer supplied each value.
 * @param binName - the diagnostic prefix on the diagnostics.
 * @param cwd - the invoking directory whose `.env` is the project layer.
 * @param warn - sink for the one-line misconfiguration diagnostics.
 * @returns this run's frozen environment snapshot.
 * @throws when either file declares a bootstrap-only variable.
 */
export function loadLayeredEnv(
  binName: string, cwd: string = process.cwd(),
  warn: (line: string) => void = line => void process.stderr.write(line),
): LaunchEnvironmentSnapshot {
  const home = resolveDshHome()
  const inherited = { ...process.env } as Record<string, string>
  // 先解析两层再应用；任一层被拒绝时，不能留下只应用了另一份文件的状态。
  const project = readEnvLayer(binName, cwd, warn)
  const user = home === resolve(cwd) ? undefined : readEnvLayer(binName, home, warn)
  // 应用已校验值，但不覆盖优先级更高来源中的同名变量。
  for (const layer of [project, user]) {
    if (layer === undefined) continue
    for (const [name, value] of Object.entries(layer.values)) {
      if (process.env[name] === undefined) process.env[name] = value
    }
  }
  return createLaunchEnvironmentSnapshot([
    { source: 'process', values: inherited },
    ...project === undefined ? [] : [{ source: 'project-env' as const, path: project.path, values: project.values }],
    ...user === undefined ? [] : [{ source: 'user-env' as const, path: user.path, values: user.values }],
  ])
}

const bootstrapIncludes = new WeakMap<Context, Entry>()

// 从 Include 本身导入它使用的 YAML 方言：!!js 标量会成为表达式节点，Loader 再根据每个
// 条目依赖就绪后的 Context 求值。Patch 解析、配置输出和实际挂载因此不会采用不同语义；
// 用户 Patch 也共享该方言，所以可以引用 process.env。
const userPatchesSchema = entryListSchema

/** Options for live user patch-layer reconciliation. */
export interface UserPatchWatchOptions {
  /** Diagnostic prefix used by {@link loadOptionalPatches}. */
  binName: string
  /** Absolute path of the watched patch file (a profile's `cordis.patch.yml`). */
  filename: string
  /**
   * Compose the full patch list for a fresh user-layer generation —
   * the same composition the app booted with, so a reload can interleave the
   * new user patches between app-owned layers (bundle layers below,
   * overlays above). Identity when omitted: the user layer
   * is the whole patch list.
   */
  compose?: (userPatches: PatchOptions[]) => PatchOptions[]
}

/**
 * Watch the user patch layer through Cordis HMR and transactionally reapply it to the boot include.
 * @param ctx - settled app context containing the root Include and an active HMR service.
 * @param options - diagnostic, file, and patch-composition inputs.
 * @returns an asynchronous disposer after the exact-path watcher is ready.
 * @throws when HMR or the root Include is absent, watcher setup fails, or initial path resolution fails.
 */
export async function watchUserPatches(
  ctx: Context,
  options: UserPatchWatchOptions,
): Promise<() => Promise<void>> {
  const { binName, filename, compose = (patches: PatchOptions[]) => patches } = options
  const hmr = ctx.get('hmr')
  if (hmr === undefined) throw new Error(`${binName}: user patch-layer watching requires the Cordis HMR service`)
  const entry = bootstrapIncludes.get(ctx)
  if (entry === undefined) throw new Error(`${binName}: user patch-layer watching requires the root Include entry`)
  const register = hmr.registerConfig(filename, async () => {
    // 每次刷新都重新读取 Include 中非 Patch 的选项。即使未来有写入方在两次刷新之间修改
    // 根 Include 的其他选项，用户层热更新也不能把它们静默恢复为旧值。
    const { patches: _previousPatches, ...includeConfig } = entry.options.config as Include.Config
    const userPatches = loadOptionalPatches(binName, filename) ?? []
    const patches = compose(userPatches)
    await entry.update({
      config: {
        ...includeConfig,
        patches,
      },
    })
  })
  try {
    return await register
  } catch (error) {
    // watcher 尚在打开时，交互界面就可能释放整棵树，导致 HMR Effect 注册返回
    // INACTIVE_EFFECT。这表示应用按要求退出，不是监听失败，因此返回空 disposer 而不崩溃。
    if ((error as { code?: string } | null)?.code === 'INACTIVE_EFFECT') return async () => {}
    throw error
  }
}

/**
 * Load an optional patch-list file: a top-level YAML array of loader patch
 * entries (`@deepseek-ai/cordis-plugin-include`'s `PatchOptions`): id-targeted config
 * overrides and `insert` lists, with `!!js` expressions allowed. A missing
 * file means "no layer"; an unreadable, unparsable, or non-array file throws —
 * a present patch file that cannot apply is a misconfiguration and must fail
 * loud at boot, never be silently skipped.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - absolute path of the patch file.
 * @returns the parsed patches, or `undefined` when the file does not exist.
 */
export function loadOptionalPatches(binName: string, file: string): PatchOptions[] | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw new Error(`${binName}: failed to read patches ${file}: ${String(error)}`)
  }
  return parsePatchList(binName, file, content, 'patches')
}

/**
 * Load a required overlay patch list: a bundle's `cordis.patch.yml` or a
 * `--patch <path>` overlay. Same file format as {@link loadOptionalPatches},
 * but a missing file throws, because the caller named this file — its absence
 * is a misconfiguration, not "no overlay".
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - absolute path of the overlay file.
 * @returns the parsed patch list.
 */
export function loadOverlayPatches(binName: string, file: string): PatchOptions[] {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read overlay ${file}: ${String(error)}`)
  }
  return parsePatchList(binName, file, content, 'overlay')
}
/**
 * Parse one loader patch list: a top-level YAML array of
 * `@deepseek-ai/cordis-plugin-include` `PatchOptions` (id-targeted config overrides and
 * `insert` lists, `!!js` expressions allowed). Every invalid field or value throws,
 * because a patch file that cannot be applied at all is a misconfiguration; a
 * single patch whose target row is absent stays a per-entry Loader warning, so
 * one overlay shared across surfaces does not have to match every tree.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - the source path, quoted in errors.
 * @param content - the file's text.
 * @param label - what to call this list in errors (`patches`, `overlay`).
 * @returns the parsed patch list.
 */
function parsePatchList(
  binName: string, file: string, content: string, label: string,
): PatchOptions[] {
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: userPatchesSchema })
  } catch (error) {
    throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`)
  }
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`)
    }
  })
  return parsed as PatchOptions[]
}

/** One overlay patch list with the source label printed in dump comments. */
export interface ConfigDumpLayer {
  /** Source name shown in dump comments (a file basename or path). */
  label: string
  /** The layer's patches, from {@link loadOverlayPatches} / {@link loadOptionalPatches}. */
  patches: PatchOptions[]
}

/**
 * Compose the effective entry list exactly as `boot()` would mount it: parse
 * the base config file with the include's entry-list dialect, apply every
 * layer's patches as ONE flattened list through the include's own patch
 * algorithm (`applyEntryPatches`) — the same single call `boot()` makes, so
 * even patch-visibility corner cases (a later layer targeting a group child a
 * plain config replacement introduced, which the single-pass id index never
 * sees) compose identically — then render the result as YAML in the same
 * dialect (`!!js` expressions print verbatim, unevaluated).
 *
 * Every run of rows from the same file and patch layers is preceded by a `# ==` comment
 * naming the file that contributed the rows and any layers that patched them,
 * so the output stays a loadable YAML document while showing which section
 * comes from which file. The file and patch labels are derived from single-call prefix
 * snapshots (base + layers 1..k), diffed positionally: the patch algorithm
 * only rewrites rows in place or appends, so a top-level index identifies one
 * row across snapshots, and a layer whose addition changes the row (config
 * replacement, disable, group insert) is listed as having patched it.
 *
 * A patch that matches no row is reported through `warn` with its layer
 * label, mirroring the Loader's boot-time warning. Earlier layers' patches
 * see an identical preceding state in every snapshot that includes them, so
 * each snapshot's warning list extends the previous one and the new tail
 * belongs to the added layer.
 * @param binName - the diagnostic prefix on read/parse errors.
 * @param absoluteConfigPath - the base config file `boot()` would include.
 * @param layers - overlay layers in application order (later wins).
 * @param warn - sink for skipped-patch diagnostics; defaults to stderr.
 * @returns the composed entry list rendered as a YAML document with
 * source comment separators.
 */
export function renderConfigDump(
  binName: string,
  absoluteConfigPath: string,
  layers: ConfigDumpLayer[],
  warn: (line: string) => void = line => void process.stderr.write(`${line}\n`),
): string {
  let content: string
  try {
    content = readFileSync(absoluteConfigPath, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read config ${absoluteConfigPath}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`${binName}: failed to parse config ${absoluteConfigPath}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${binName}: config ${absoluteConfigPath} must be a top-level YAML array of entries`)
  }
  const baseLabel = basename(absoluteConfigPath)
  // YAML 解析得到无类型行；Include 会在挂载时校验每个条目，而 dump 只输出文件现有内容。
  // 因此这里把同一份 boot() 输入文件按 EntryOptions 结构读取。
  const base = parsed as Parameters<typeof applyEntryPatches>[0]
  // snapshot_k 表示将第 1 到 k 层用 boot 对该前缀使用的相同参数应用一次并展开；最终的
  // snapshot_N 就是实际挂载组合。每次调用都克隆 Patch：applyEntryPatches 会复制条目列表，
  // 但 insert 行仍按引用来自 Patch。若多个快照共享 Patch 对象，后一个快照的原地修改会
  // 污染前一个快照结果。
  const snapshot = (count: number, warnings: string[]): ReturnType<typeof applyEntryPatches> => {
    const flattened = structuredClone(layers.slice(0, count).flatMap(layer => layer.patches))
    return applyEntryPatches(base, flattened, (message: string, ...args: unknown[]) => {
      // Include 使用 Cordis 的 printf 风格日志（%C 表示代码）；dump 没有 Logger，因此
      // 在这里直接替换成普通文本。
      let index = 0
      warnings.push(message.replace(/%C/g, () => JSON.stringify(args[index++])))
    })
  }
  let previous = base
  let previousWarnings: string[] = []
  const provenance: { origin: string; patchedBy: string[] }[] = base.map(() => ({ origin: baseLabel, patchedBy: [] }))
  let composed = base
  for (let count = 1; count <= layers.length; count += 1) {
    const layer = layers[count - 1]
    /* v8 ignore next -- count iterates 1..length, so the slot exists */
    if (layer === undefined) continue
    const warnings: string[] = []
    composed = snapshot(count, warnings)
    for (const line of warnings.slice(previousWarnings.length)) {
      warn(`${binName}: [${layer.label}] ${line}`)
    }
    const before = previous.map(entry => JSON.stringify(entry))
    for (let index = 0; index < composed.length; index += 1) {
      if (index >= before.length) provenance.push({ origin: layer.label, patchedBy: [] })
      else if (JSON.stringify(composed[index]) !== before[index]) provenance[index]?.patchedBy.push(layer.label)
    }
    previous = composed
    previousWarnings = warnings
  }
  return groupedDump(composed, provenance)
}

/** Render the composed rows grouped under one source-and-patches comment per contiguous run. */
function groupedDump(
  composed: readonly unknown[],
  provenance: readonly { origin: string; patchedBy: string[] }[],
): string {
  const lines: string[] = []
  let currentLabel: string | undefined
  let group: unknown[] = []
  const flush = (): void => {
    if (currentLabel === undefined || group.length === 0) return
    lines.push(`# == ${currentLabel}`)
    lines.push(yaml.dump(group, { schema: entryListSchema, noRefs: true }).trimEnd())
    group = []
  }
  for (let index = 0; index < composed.length; index += 1) {
    const record = provenance[index]
    /* v8 ignore next -- this array is index-aligned with composed by construction */
    if (record === undefined) continue
    const label = record.patchedBy.length === 0
      ? record.origin
      : `${record.origin}, patched by ${record.patchedBy.join(', ')}`
    if (label !== currentLabel) {
      flush()
      currentLabel = label
    }
    group.push(composed[index])
  }
  flush()
  return lines.join('\n') + '\n'
}

/**
 * Mount and remember the exact root Include entry used by app boot and user patch-layer HMR.
 * @param ctx - context carrying an initialized Loader service.
 * @param absoluteConfigPath - absolute YAML or JSON configuration path.
 * @param patches - initial app and user patches, applied in order.
 * @param bareModuleBaseUrl - optional installed-host base for bare package
 * names; relative names continue to resolve beside the configuration file.
 * @returns the created root Include entry, or `undefined` when a surface
 * disposed the whole tree (taking the Loader service with it) while the
 * transactional create was still settling entry lifecycle.
 */
export async function mountRootInclude(
  ctx: Context,
  absoluteConfigPath: string,
  patches: readonly PatchOptions[] = [],
  bareModuleBaseUrl?: string,
): Promise<Entry | undefined> {
  ctx.loader.builtins.include = bareModuleBaseUrl === undefined
    ? Include
    : class HostResolvedRootInclude extends Include {
      override import(name: string, getOuterStack?: () => string[]): unknown {
        const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
        if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(specifier, getOuterStack)
        const internal = this.ctx.loader.internal
        /* v8 ignore next -- Node supplies the internal loader; this preserves the
           original diagnostic for hypothetical embedders without it. */
        if (internal === undefined) return super.import(specifier, getOuterStack)
        return internal.import(specifier, bareModuleBaseUrl, {})
      }
    }
  // 同时提供 cordis:group：配置通过 group 行让 Provider 和 Consumer 共享一个 isolate
  // 区域；位于当前 Workspace 外的 Agent Preset 无法按包名解析 cordis-plugin-group。
  // 两个内置插件都通过宿主模块管线加载，不依赖被 Include 树自身的模块解析能力。
  ctx.loader.builtins.group = Group
  // 固定 id：Bootstrap Include 属于应用装配代码而非普通配置行，它的 id 会出现在 Loader
  // 失败链中；随机 id 会让不同运行和快照夹具中的启动诊断不稳定。
  const includeConfig: Include.Config = {
    path: pathToFileURL(absoluteConfigPath).href,
    ...patches.length > 0 ? { patches: [...patches] } : {},
  }
  const rootInclude: EntryOptions = {
    id: 'include',
    name: 'cordis:include',
    config: includeConfig,
  }
  const includeId = await ctx.loader.create(rootInclude)
  const loader = ctx.get('loader')
  if (loader === undefined) return undefined
  const entry = loader.resolve(includeId)
  bootstrapIncludes.set(ctx, entry)
  return entry
}

/**
 * The slice of `process` {@link installFailLoud} needs — injectable so tests
 * exercise the handler without registering on (or exiting) the real process.
 */
export interface FailLoudProcess {
  on(event: 'unhandledRejection', handler: (err: unknown) => void): unknown
  off(event: 'unhandledRejection', handler: (err: unknown) => void): unknown
  stderr: { write(chunk: string): unknown }
  /**
   * Terminate the process. Callers treat this as the end of the run, as
   * `process.exit` is; a fake that returns lets the caller continue, which only
   * a test observes.
   */
  exit(code: number): void
}

// Loader rc.5 在 Fiber 失败后会派生并丢弃一个 rejected Promise。把已经并入启动诊断的
// 原始原因保留到下一个进程 rejection 检查点，使进程守卫能将它们合并而不是重复报告。
const assembledActivationRejections = new Map<unknown, number>()

function retainAssembledRejection(reason: unknown): void {
  assembledActivationRejections.set(reason, (assembledActivationRejections.get(reason) ?? 0) + 1)
}

function releaseAssembledRejection(reason: unknown): void {
  const count = assembledActivationRejections.get(reason)
  if (count === undefined || count === 1) {
    assembledActivationRejections.delete(reason)
  } else {
    assembledActivationRejections.set(reason, count - 1)
  }
}

async function observeLoaderRejectionCheckpoint(reasons: readonly unknown[]): Promise<void> {
  for (const reason of reasons) retainAssembledRejection(reason)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally {
    for (const reason of reasons) releaseAssembledRejection(reason)
  }
}

/**
 * How long {@link installFailLoud} waits for its `release` hook before exiting
 * anyway. A wedged disposer must delay the fatal exit, never cancel it.
 */
export const FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000

/**
 * Install before boot to turn a late unhandled plugin-init rejection into one
 * labelled stderr diagnostic and `exit(1)`. A rejection already included by
 * {@link assertEntriesActivated} is ignored during its process checkpoint;
 * every other rejection remains fatal. Stdout remains untouched for ACP; the
 * returned function removes the handler.
 *
 * The Loader mounts entries concurrently, so a surface that owns the terminal
 * can already hold it when a sibling entry rejects. Exiting straight from the
 * handler would strand raw mode, bracketed paste, and the keyboard protocol on
 * the user's shell, and leave an in-flight terminal query's reply to land as
 * literal text at the next prompt. `release` is the terminal owner's chance to
 * hand it back; it is awaited under {@link FAIL_LOUD_RELEASE_TIMEOUT_MS}, whose
 * timer stays referenced so a never-settling disposer cannot let Node reach an
 * empty event loop and exit 0 instead of failing.
 *
 * The diagnostic is written before the release so a hanging or failing disposer
 * cannot swallow the reason. The handler stays installed while the release runs
 * — removing it would let a second concurrent rejection become uncaught and kill
 * the process mid-teardown, stranding exactly the terminal state this restores —
 * so a latch keeps the first rejection the reported one and lets later
 * rejections (including the release's own) fall through to the pending exit.
 * @param binName - the diagnostic prefix on the fatal-failure line.
 * @param proc - the process slice to register on; tests inject a fake.
 * @param release - optional teardown awaited before exit, used by a
 *   terminal-owning surface to restore the terminal. Its own failure is
 *   swallowed because the pending fatal exit already owns the outcome.
 * @returns the uninstaller that removes the rejection handler.
 */
export function installFailLoud(
  binName: string,
  proc: FailLoudProcess = process,
  release?: () => Promise<void> | void,
): () => void {
  let exiting = false
  const handler = (err: unknown): void => {
    if (assembledActivationRejections.has(err)) return
    // 已开始的 release 已经接管退出流程。后续 rejection（包括清理自身失败）不再重复上报，
    // 避免遮住首个真实错误，也避免终端恢复前被 Node 直接终止进程。
    if (exiting) return
    exiting = true
    proc.stderr.write(`${binName}: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    if (release === undefined) {
      proc.exit(1)
      return
    }
    void (async () => {
      // timeout Promise 的 executor 在构造 race 时、首次 await 前同步执行，因此变量必已赋值。
      let timer!: ReturnType<typeof setTimeout>
      try {
        await Promise.race([
          (async () => release())(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS)
          }),
        ])
      } catch {
        // 终端释放失败后，真正决定结果的是下方的致命退出；退出后也不会再运行报告器。
      }
      clearTimeout(timer)
      proc.exit(1)
    })()
  }
  const uninstall = (): void => void proc.off('unhandledRejection', handler)
  proc.on('unhandledRejection', handler)
  return uninstall
}

/**
 * After the tree settles, reject entries with no fiber and name every plugin
 * whose module failed to resolve. Disabled entries are the only valid
 * fiber-less state.
 * @param ctx - the settled context whose loader entries to audit.
 * @param binName - the diagnostic prefix on the thrown error.
 */
export function assertEntriesLoaded(ctx: Context, binName: string): void {
  const failed = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  if (failed.length > 0) {
    const names = failed.map(entry => entry.options.name).join(', ')
    throw new Error(`${binName}: plugin(s) failed to load: ${names}; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)`)
  }
}

/**
 * Value mirrors used because Cordis's const enum has no runtime object to import.
 * Keep aligned with `packages/extensions/tool-cordis/src/fiber-state.ts` and
 * `packages/client/web/src/loader-status.ts`.
 */
const FIBER_PENDING = 0 as FiberState.PENDING
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const FIBER_FAILED = 3 as FiberState.FAILED

/** Render a thrown plugin value without discarding an Error's original stack. */
function formatActivationError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

/**
 * Reject a settled Loader tree when an enabled entry failed or remains inactive.
 * Plugin failures include the original thrown stack; pending entries name their
 * unresolved services because no plugin error exists for that state. Active
 * entries require no further wait; only failed fibers are awaited to recover
 * their private rejection reason.
 * @param ctx - the settled context whose Loader entries to audit.
 * @param binName - the diagnostic prefix on the thrown error.
 * @returns nothing when every enabled entry is active.
 * @throws after one process rejection checkpoint when an entry failed to
 * import, rejected during activation, or did not become active.
 */
export async function assertEntriesActivated(ctx: Context, binName: string): Promise<void> {
  assertEntriesLoaded(ctx, binName)
  const failures: string[] = []
  const rejectionReasons: unknown[] = []
  for (const entry of ctx.loader.entries()) {
    const fiber = entry.fiber
    if (fiber === undefined || entry.disabled) continue
    const state = fiber.state
    if (state === FIBER_ACTIVE) continue
    if (state === FIBER_FAILED) {
      try {
        await fiber.await()
      } catch (error) {
        rejectionReasons.push(error)
        failures.push(`${entry.options.name}: ${formatActivationError(error)}`)
      }
      continue
    }
    if (state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
      const subject = missing.length === 1 ? 'service' : 'services'
      failures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(', ') || 'unknown'})`)
    } else {
      failures.push(`${entry.options.name}: fiber state ${String(state)}`)
    }
  }
  if (failures.length > 0) {
    if (rejectionReasons.length > 0) {
      await observeLoaderRejectionCheckpoint(rejectionReasons)
    }
    const noun = failures.length === 1 ? 'entry' : 'entries'
    throw new Error(`${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join('\n')}`)
  }
}

/**
 * 使用 `absoluteConfigPath` 启动 Loader，等待整棵插件树稳定后返回。相对条目名从配置目录
 * 解析；裸包名默认也从该目录解析，封闭的打包运行时可通过 `bareModuleBaseUrl` 指定宿主
 * 安装目录。Bootstrap Include 以 `cordis:include` 内置插件挂载，并通过宿主的 vite、tsx
 * 或原生 ESM 模块管线加载。构建产物内嵌 Include、外置 Loader，使宿主与 Include 树共享
 * 同一个 Loader 实例。Loader 稳定阶段会拒绝启动失败；`boot` 清理部分 Context 后包装
 * 该错误。最终由 {@link assertEntriesActivated} 拒绝缺少 Fiber 或永不激活的条目，并保留
 * 插件初始化异常的原始堆栈；后续未处理 rejection 由 {@link installFailLoud} 处理。
 * @param binName - 加载失败诊断的前缀。
 * @param absoluteConfigPath - 要 Include 的配置，必须已是绝对路径，参见 {@link resolveConfigPath}。
 * @param patches - 应用到插件树上的可选 Overlay Patch；空数组表示不挂载 Overlay。
 * @param prepare - Loader 安装后、任意配置条目挂载前执行的可选宿主准备函数。
 * @param bareModuleBaseUrl - 裸包名可选的宿主安装目录；完整插件集由宿主提供时使用。
 * @returns 所有条目启动后的根 Context；若启动期间某个界面已释放插件树，则立即返回。
 * @throws 释放部分 Context 后抛出带阶段标签的错误；`prepare` 失败标记为
 * `host preparation failed`，开始挂载配置后的失败标记为 `plugin tree failed to load`。
 */
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context> {
  // 学习重点：这里的启动顺序只有“先装 Loader，再挂载配置树”。配置树内部各插件的
  // 实际激活顺序由 inject 声明的 Service 依赖决定，而不是由 cordis.yml 的行顺序决定。
  const ctx = new Context()
  // 启动错误分成两类：prepare 在配置树任何条目挂载前运行，因此它失败表示宿主准备失败，
  // 而不是插件树失败。
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
    ctx.provide('dshHomePath', dshHomePath)
    await ctx.plugin(Loader)
    await prepare?.(ctx)
    stage = 'plugin tree failed to load'
    // Root Include 把基础配置和 Patch 解析为 Loader Entry；从这一刻起，每一行配置都成为
    // 一个由独立 Fiber 管理的插件实例，能够单独激活、失败、重载和释放。
    await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl)
    // 某个交互界面可能在启动尚未结束、最后一个条目尚未稳定时就完成任务并释放整棵树，
    // Loader 服务也会随之消失。激活审计只描述仍存活的树，因此每次 await 后都要重新读取，
    // 避免把一次符合预期的应用退出误报成访问 ctx.loader 的 TypeError。事务式分组更新会在
    // mount 内完成生命周期变更，所以清理甚至可能在 mount 返回前发生。
    await ctx.get('loader')?.await()
    if (ctx.get('loader') === undefined) return ctx
    // Loader 的 await 只表示装载过程已经稳定；最终审计还要拒绝缺少依赖而一直 pending
    // 的插件。DSH 因此不会把“没有报异常”误认为“系统已经完整启动”。
    await assertEntriesActivated(ctx, binName)
    return ctx
  } catch (cause) {
    // 根 Fiber 会分别收集各观察者的清理失败，重复释放只返回同一次已完成结果，因此这里的
    // await 不会再次失败并覆盖原始 cause。
    await ctx.fiber.dispose()
    const detail = cause instanceof Error ? cause.message : String(cause)
    // 事务式 Loader 会在配置树每一层为失败的 entry apply 包一层错误；detail 已汇总这些
    // 消息，最深层 cause 才是插件自身抛出的异常。追加它的堆栈，才能保留真正的激活失败
    // 位置，而不只显示外层包装链。
    let deepest: unknown = cause
    while (deepest instanceof Error && deepest.cause !== undefined) deepest = deepest.cause
    const stack = deepest instanceof Error && deepest !== cause ? `\n${deepest.stack ?? deepest.message}` : ''
    throw new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause })
  }
}

/** Prompt-section name for the harness-source location line an app bin adds after boot. */
export const HARNESS_SOURCE_SECTION = 'harness:source'

/**
 * Add a global prompt section naming the on-disk harness source checkout while
 * explicitly distinguishing it from the task workspace and current working
 * directory. The self-referential `dsh-tool-cordis` toolset reads and edits this
 * checkout. Call once on the settled boot context ({@link boot}); the section
 * orders just after the harness identity opener (`-100`) and before the deployment
 * persona (`0`). A booted tree with no `systemPrompt` service has no prompt to
 * augment, so this is then a no-op that returns `undefined`. The section is
 * registered against the `systemPrompt` service's fiber, so a dev HMR reload of
 * that plugin drops it until the next boot.
 * @param ctx - the settled boot context whose global system prompt to augment.
 * @param sourceRoot - the absolute path to the harness checkout root.
 * @returns the section disposer, or `undefined` when no `systemPrompt` service is mounted.
 */
export function addHarnessSourceSection(ctx: Context, sourceRoot: string): (() => void) | undefined {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return undefined
  // 下方英文会在应用启动后加入全局 system prompt。中文译文：DeepSeek Harness 实现代码
  // checkout 位于 sourceRoot。checkout 位置与当前工作目录是两个可能不同的值，不能从该
  // 路径推断工作目录；应使用 pwd 获取当前工作目录。只有检查或扩展 DSH 自身时才使用此
  // checkout。sourceRoot 是启动时解析的绝对路径；运行时原文保持不变。
  return systemPrompt.section({
    name: HARNESS_SOURCE_SECTION,
    order: -99,
    text: `The DeepSeek Harness implementation checkout is at ${sourceRoot}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.`,
  })
}
