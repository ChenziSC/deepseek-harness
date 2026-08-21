/**
 * UI 插件客户端 Bundle 共用的 tsdown preset。它发射 closure factory 产物：Bundle 调用
 * window.__ModuleLoader__.load({id, factory})，并通过注入的 require 解析 external；该
 * require 连接 Loader 模块表中的 Cordis DI 实体，不依赖全局变量或 import map。CSS 在
 * Bundle 内由 lightningcss 编译：`x.module.css` 生成带哈希的 class map，并在 factory
 * 执行时注入带标签的 style；`x.css?inline` 则导出编译文本，交给插件自身的生命周期 effect。
 * Virtual Loader 会把每个真实样式表注册为 watch 依赖。
 */
import { readFile } from 'node:fs/promises'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'
import { optionalStringArray } from './modules/src/client/manifest.ts'
import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from './web/src/platform.ts'
import { clientBuildEnvironmentDefines } from '../../scripts/client-build-environment.ts'

/**
 * Virtual id 包装用于阻止 Module CSS 进入 tsdown 自身依赖 @tsdown/css 的 CSS pipeline。
 * 后缀不可省略：tsdown guard 会匹配以 `.css` 结尾的 id，因此 virtual id 不能以它结尾。
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

/** 发射一个插件拥有的样式注入器，以及可选的 CSS Modules 导出。 */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/**
 * 客户端 Bundle 可以内联的 wire/type 层：browser-safe 约定，没有需要共享的运行时 identity，
 * 即不含 Symbol、instanceof 或 singleton 状态。@deepseek-ai/* 下的其他内容要么是模块表
 * 条目（external），要么是由纯度门禁拒绝的泄漏。
 */
export const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand)(\/|$)/

/**
 * Vendored 框架库被重新 scope 到 @deepseek-ai，因此下方门禁会把它们误认作插件包。它们
 * 不携带需要跨插件共享的运行时 identity：框架本身是显式请求的模块表行（external），
 * 而这些只是由浏览器 Bundle 内联的普通库。
 */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** 不携带共享运行时 identity 的已生成 descriptor/codec contribution。 */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Workspace 模式会用根默认值替换空配置数组；falsey entry 则会在解析入口前移除本包。
 */
const SKIP_WORKSPACE_BUILD: UserConfig = { entry: '' }

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** 把物理 lib 相对源码重基到镜像仓库目录结构的浏览器 URL。 */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return repositoryPath.startsWith('packages/') ? `../../../${repositoryPath}` : source
}

/**
 * 为一个 UI 插件包构造 tsdown 配置：Node half lib 构建加浏览器 Client Bundle。客户端包默认
 * 在 Client pass 同时发射两部分；Host reflection 所需的包可选择提前到 Host pass。
 * 包级 tsdown.config.ts 会替换根 Workspace 布局，因此这里必须重新声明 lib half；若遗漏，
 * 包不会生成 lib/index.js，Host Loader 也无法导入其 Node half。
 * @param id - 插件 id（包名），写入 __ModuleLoader__.load 交接与注入的 style tag。
 * @param libEntry - Node half 入口，在调用点显式列出，使 package-invariants 门禁能在每个包
 * 自身的 tsdown.config.ts 中看到 `lib/types/invariant.js`；preset 内 glob 会躲过机械检查。
 * @param options - 阶段位置、lib 覆盖和伴随 Node 配置。
 * @returns 按 ENV 选择、用于当前构建 face 的 tsdown 配置。
 */
export function clientBundle(
  id: string,
  libEntry: readonly string[],
  options: ClientBundleOptions = {},
): BuildFaceConfig {
  const lib = clientLibraryConfig(id, libEntry, options.lib)
  return ({ env }) => {
    const face = buildFace(env?.DSH_BUILD_FACE)
    const clientEntry = face === undefined ? 'src/client/index.ts' : 'lib/types/client/index.js'
    const client = clientConfig(id, clientEntry)
    const node = [lib, ...(options.companions ?? [])]
    if (face === 'host') return options.hostPhase === true ? node : [SKIP_WORKSPACE_BUILD]
    if (face === 'client') {
      return options.hostPhase === true ? [client] : [...node, client]
    }
    return [...node, client]
  }
}

/**
 * 为由编译 Shell 静态链接的客户端库构造 tsdown 配置。静态组装 channel 中，`apps/web`
 * 解析包名、打包产物，并拥有 Chunk 布局与 CSS pipeline。
 *
 * 调用本 preset 就会把包放入静态组装 channel，因此调用点本身就是 roster；门禁通过
 * {@link isStaticLinkedConfig} 读取它，无需维护第二份手写列表。Roster 中的包不能同时成为
 * 模块表行，否则浏览器会使用静态链接副本，而 Provider Bundle 中的相同字节永远不会使用。
 *
 * 四项产物约定：
 * 1. 每个裸 specifier 保持为 import。Shell 按 `node_modules/<pkg>` 归属 Chunk 字节；若依赖
 *    被内联到 Workspace 文件，就无法归属任何 npm 包，其字节会落入 index Chunk，破坏
 *    vendor/index 缓存分割。
 * 2. 在 `platform: 'browser'` 上输出 `esm`，Shell 是唯一 Consumer。
 * 3. Sourcemap 通过 `lib/types` 下的 tsc map 链接回源码。
 * 4. 样式表随包发布：相对 `.css` import 作为相对 external 保留，样式表按相对 `src` 的
 *    路径发射到 `lib/`，使 Vite 继续成为 class hashing 的唯一所有者。
 * @param id - 用于 tsdown 诊断的包名。
 * @param libEntry - 从 `lib/types` 消费的已发射 JavaScript 入口，每个入口单独一个 Bundle；
 * 多入口构建会发射哈希命名的共享 Chunk，无法由精确 `files` 列表发布。
 * @returns 按 ENV 选择、用于 Client 构建 face 的 tsdown 配置。
 */
export function staticLinked(id: string, libEntry: readonly string[]): BuildFaceConfig {
  // 每个 entry 命名自己的输出文件，因此 basename 相同的两个 entry 会互相覆盖，而不是
  // 发射两个产物。
  const names = new Set(libEntry.map(entry => basename(entry, '.js')))
  if (names.size !== libEntry.length) {
    throw new Error(`tsdown: ${id} entries collide on an output name: ${libEntry.join(', ')}`)
  }
  return clientOnly(libEntry.map(entry => staticLinkedConfig(id, entry)))
}

/**
 * 包的 tsdown 配置是否把它放入静态组装 channel。Roster 没有独立列表：门禁加载每个包
 * 自身的 `tsdown.config.ts`，以 Client face 调用，再查询本函数。
 * @param configs - 包的 build-face 函数返回的配置。
 * @returns 至少一个配置由 {@link staticLinked} 构造时为 true。
 */
export function isStaticLinkedConfig(configs: readonly UserConfig[]): boolean {
  return configs.some(config => (config.plugins as readonly { name?: string }[] | undefined ?? [])
    .some(plugin => plugin.name === STATIC_LINKED_PLUGIN))
}

/**
 * 在 Client pass 构建仅供 Client 使用的 Node 库。
 * @param id - tsdown 诊断中使用的包名。
 * @param libEntry - 从 `lib/types` 消费的已发射 JavaScript 入口。
 * @returns 按 ENV 选择、用于 Client 构建 face 的 tsdown 配置。
 */
export function clientLibrary(id: string, libEntry: readonly string[]): BuildFaceConfig {
  const lib = clientLibraryConfig(id, libEntry)
  return clientOnly([lib])
}

/**
 * 只在 Client pass 选择任意包内配置。
 * @param configs - Client tsc 后发射的 Node 侧配置。
 * @returns 按 ENV 选择、用于 Client 构建 face 的 tsdown 配置。
 */
export function clientOnly(configs: readonly UserConfig[]): BuildFaceConfig {
  return ({ env }) => buildFace(env?.DSH_BUILD_FACE) === 'host'
    ? [SKIP_WORKSPACE_BUILD]
    : [...configs]
}

interface ClientBundleOptions {
  /** 在 Host pass 而非 Client pass 发射 Node 侧产物。 */
  readonly hostPhase?: boolean
  /** 随包库一同发射的额外 Node 侧配置。 */
  readonly companions?: readonly UserConfig[]
  /** 包的主要 Node 侧库配置覆盖。 */
  readonly lib?: UserConfig
}

type BuildFace = 'host' | 'client' | undefined

type BuildFaceConfig = (inlineConfig: Pick<UserConfig, 'env'>) => UserConfig[]

function buildFace(value: unknown): BuildFace {
  if (value === undefined || value === 'host' || value === 'client') return value
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

function clientLibraryConfig(
  id: string,
  libEntry: readonly string[],
  overrides: UserConfig = {},
): UserConfig {
  const isProductionDependency = (specifier: string): boolean =>
    matchesSpecifier(productionExternals(id), specifier)
  return {
    name: id,
    entry: [...libEntry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      // Node half 从真实安装运行：production dependency 位于磁盘上并保持为 import，其他内容
      // 全部内联。显式声明两部分可避开 tsdown 的 getProductionDeps fallback；否则在 npm
      // section 之间移动依赖会静默改变打包结果。Builtin 继续由 tsdown 自身处理，两边都不认领。
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
    ...overrides,
  }
}

/** 样式表插件使用的 Rolldown 插件 Context 子集。 */
interface AssetEmitter {
  emitFile(file: {
    type: 'asset'
    fileName: string
    source: Uint8Array
    originalFileName: string
  }): string
}

function staticLinkedConfig(id: string, entry: string, outputName = basename(entry, '.js')): UserConfig {
  const emitted = new Set<string>()
  return {
    name: id,
    entry: { [outputName]: entry },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // Shell 会再次编译此产物，因此本 map 是从浏览器 stack frame 返回 TSX 的唯一路径；
    // lib/types half 由 tsc 发射。
    sourcemap: true,
    plugins: [{
      // 约定 1。使用 `pre`，否则 tsdown 自身的 deps 插件会解析并内联所有未出现在 npm
      // production section 的 specifier，而本 preset 正是为了消除该耦合。插件名同时也是
      // {@link isStaticLinkedConfig} 读取的 roster 标记。
      name: STATIC_LINKED_PLUGIN,
      resolveId: {
        order: 'pre' as const,
        handler(source: string, importer: string | undefined) {
          // Entry 到达时没有 importer，必须保持 internal。
          if (importer === undefined) return null
          return isBareSpecifier(source) ? { id: source, external: true } : null
        },
      },
    }, {
      // 约定 3。Rolldown 不读取输入的 `//# sourceMappingURL`，因此把每个 tsc map 作为对应
      // 模块的 map 交给它，再组合进 Bundle map；否则 Frame 会停在已发射的 lib/types
      // JavaScript，无法回到 TSX。
      name: 'dsh-tsc-sourcemap',
      async load(id: string) {
        if (!id.includes(TYPES_MARKER) || !id.endsWith('.js') || !existsSync(`${id}.map`)) return null
        const code = await readFile(id, 'utf8')
        return { code: code.replace(SOURCEMAP_COMMENT, ''), map: await readFile(`${id}.map`, 'utf8') }
      },
    }, {
      // 约定 4。Import 原样保留，样式表落在 JavaScript 旁，使 Shell 的 CSS Modules
      // pipeline 能看到真实样式表。
      name: 'dsh-css-asset',
      async resolveId(this: AssetEmitter, source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || importer === undefined) return null
        const { file, fileName } = stylesheetAsset(source, importer)
        if (!emitted.has(fileName)) {
          emitted.add(fileName)
          // originalFileName 还会把物理样式表放入 watch 图。
          this.emitFile({ type: 'asset', fileName, source: await readFile(file), originalFileName: file })
        }
        // 所有已发射 Chunk 都位于 lib/ 根目录，因此从那里解析的是相对 src 的名称。Rolldown
        // 会原样保留相对 external，不再规范化。
        return { id: `./${fileName}`, external: true }
      },
    }],
  }
}

/** Specifier 是否命名一个包，而非 importer 旁的文件。 */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('\0') && !isAbsolute(specifier)
}

/**
 * 根据包源码定位样式表 import，并命名其发射位置。
 * @param source - 源码中写出的相对 import specifier。
 * @param importer - 导入模块的绝对路径，可以是发射产物或源码。
 * @returns 磁盘样式表，以及它在 `lib/` 下相对 `src` 的名称。
 */
function stylesheetAsset(source: string, importer: string): { readonly file: string, readonly fileName: string } {
  const file = sourceAssetPath(source, importer)
  const boundary = file.lastIndexOf(SOURCE_MARKER)
  if (boundary < 0) throw new Error(`tsdown: stylesheet ${file} is outside the package sources`)
  return { file, fileName: file.slice(boundary + SOURCE_MARKER.length).split(sep).join('/') }
}

/** 构建 face 为声明自身模块边而读取的 manifest 字段。 */
interface WorkspaceManifest {
  readonly name?: string
  /** 真实安装会在已构建包旁落盘的 section。 */
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly dsh?: { readonly client?: { readonly external?: unknown } }
}

const manifestCache = new Map<string, WorkspaceManifest>()
const productionExternalCache = new Map<string, readonly RegExp[]>()
const clientExternalCache = new Map<string, ReadonlySet<string>>()

/**
 * 读取一个 Workspace 包的 manifest。按包名而非 cwd 定位，因为 Workspace 构建期间 tsdown
 * 会以仓库根目录作为 `process.cwd()` 评估每个包配置。调用方在构建的首次 resolveId 时
 * 读取，而不是在构造配置时读取，所以选择 build face 不会接触 manifest。
 * @param id - preset 调用点写出的包名。
 * @returns 已解析 manifest。
 * @throws {Error} 没有 Workspace 包声明该名称时抛出。
 */
function workspaceManifest(id: string): WorkspaceManifest {
  const cached = manifestCache.get(id)
  if (cached !== undefined) return cached
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: REPOSITORY_ROOT })) {
    const manifest = JSON.parse(
      readFileSync(resolvePath(REPOSITORY_ROOT, manifestPath), 'utf8'),
    ) as WorkspaceManifest
    if (manifest.name !== id) continue
    manifestCache.set(id, manifest)
    return manifest
  }
  throw new Error(`tsdown: no packages/*/*/package.json declares the name ${id}`)
}

/**
 * 一个包 Node half 的 external pattern：包自身的 production section，包括子路径。
 * @param id - preset 调用点写出的包名。
 * @returns 每个 production dependency 对应一个 `^name(/|$)` pattern，并按名称排序。
 */
function productionExternals(id: string): readonly RegExp[] {
  const cached = productionExternalCache.get(id)
  if (cached !== undefined) return cached
  const manifest = workspaceManifest(id)
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  const patterns = [...names].sort().map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
  productionExternalCache.set(id, patterns)
  return patterns
}

/**
 * 一个 `dsh.client` 声明请求的模块表 specifier。匹配严格按原值进行，不做规范化：包声明
 * 自身代码实际 import 的 specifier，Loader 也以相同方式索引静态条目。
 * @param subject - 用于诊断的包名。
 * @param declaration - 包的 `dsh.client` 对象。
 * @returns 已请求 specifier；包未声明时为空。
 * @throws {Error} `external` 不是字符串数组时抛出。
 */
export function requestedExternals(
  subject: string,
  declaration: { readonly external?: unknown },
): ReadonlySet<string> {
  return new Set(optionalStringArray(subject, 'dsh.client.external', declaration.external) ?? [])
}

/**
 * 一个包请求的模块表 specifier。Shell baseline 对所有动态 Bundle 都是隐式的；
 * `dsh.client.external` 只增加包特有的动态行或子路径。
 * @param id - preset 调用点写出的包名。
 * @returns baseline 加包的显式请求。
 */
function clientExternals(id: string): ReadonlySet<string> {
  const cached = clientExternalCache.get(id)
  if (cached !== undefined) return cached
  const externals = new Set([
    ...PLATFORM_MODULES,
    ...PRELOADED_CLIENT_EXTERNALS,
    ...requestedExternals(id, workspaceManifest(id).dsh?.client ?? {}),
  ])
  clientExternalCache.set(id, externals)
  return externals
}

/** 转义包名，使其可在 RegExp source 中按 literal 使用。 */
function escapeSpecifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Import specifier 是否为 pattern 命名的包或其子路径。 */
function matchesSpecifier(patterns: readonly RegExp[], specifier: string): boolean {
  return patterns.some(pattern => pattern.test(specifier))
}

function clientConfig(id: string, entry: string): UserConfig {
  const isRequested = (specifier: string): boolean => clientExternals(id).has(specifier)
  return {
    name: `${id}/client`,
    entry: { client: entry },
    // Browser Bundle 落在 Node half 旁边；两者共用一个 lib/ 产物目录，entryFileNames pin
    // 保证路径精确为 lib/client.js。clean 必须关闭，否则默认清理会删除上方发射的 Node half。
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // 类型由 tsc 从 lib/types 发布；此处启用 dts 会把 banner/footer 包入 .d.cts 并破坏解析。
    dts: false,
    // 插件代码在 Vite 模块图之外获取，因此自身 Bundle 必须携带浏览器分析工具消费的
    // TS/TSX 映射。
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      // 未从 Loader 模块表请求的内容都必须内联，包括 wire/type 层、zod、clsx 和所有非共享
      // 依赖。模块表无法回答的 require() 一定会在运行时抛错，因此规则以包自身请求列表
      // 为准：已请求 specifier 保持 import，其他内容全部打入 Bundle。
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    // Browser Bundle 会内联使用 Node idiom 的依赖：zustand/immer 读取
    // process.env.NODE_ENV，zustand 的 ESM 构建还探测 import.meta.env.MODE，而 CJS 输出
    // 无法携带后者，Rolldown 会报告 EMPTY_IMPORT_META。Vite 已在 seed 路径定义二者；tsdown
    // 内联也必须在此替换，否则 factory 会在启动时抛 ReferenceError，构建门禁也会失败。
    // 两个键都遵循构建的 NODE_ENV，使开发构建保留开发分支语义，产物默认使用 production。
    // 精确 MODE 键之外还需要裸 `import.meta.env`：zustand 会探测
    // `import.meta.env ? import.meta.env.MODE : ...`，否则真值探测会以空 import.meta 残留。
    define: {
      ...clientBuildEnvironmentDefines(process.env),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      // Bundle 纯度门禁是模块边规则的构建时镜像：baseline 与包特有请求保持 external，
      // inline-safe wire 层内联，其他 @deepseek-ai 值 import 都是构建错误。跨插件值 import
      // 要么内联重复运行时实例，要么 require 本包模块表无法回答的 specifier。跨插件协作
      // 必须改走 Cordis 服务。
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null // requested module-table row: external wins
        if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${id}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
    }, {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        // 若不显式添加，virtual id 会让物理样式表从 Rolldown watch 图中消失。
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        const exportEntries = Object.entries(cssExports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        for (const [local, exp] of exportEntries) classMap[local] = exp.name
        return styleInjectionModule(id, fileId, code.toString(), classMap)
      },
    }, {
      name: 'dsh-css-text-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
        const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
        const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
        return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true })
        return `export default ${JSON.stringify(code.toString())};`
      },
    }, {
      name: 'dsh-css-global-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true })
        return styleInjectionModule(id, fileId, code.toString())
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      // Map 从 /plugins/<scoped-package>/client.js.map 提供。浏览器把其中本地源码解析为镜像
      // /packages/<group>/<package>/src 目录的 URL；sourcesContent 使源码可用，无需把该目录
      // tree 暴露为 HTTP route。
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/** 分隔包 tsc 输出与其来源源码的路径片段。 */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/** 承载约定 1 的插件名，也是识别静态链接配置的标记。 */
const STATIC_LINKED_PLUGIN = 'dsh-static-linked-external'

/** 包源码所在的路径片段，也是已发射资源镜像的根。 */
const SOURCE_MARKER = `${sep}src${sep}`

/** tsc 附加到每个已发射模块末尾的 sourcemap 引用。 */
const SOURCEMAP_COMMENT = /\n\/\/# sourceMappingURL=.*\s*$/

/** 根据源码 tree 中的对应文件解析已发射 JS 资源 import。 */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}
