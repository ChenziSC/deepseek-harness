/**
 * Models 设置页存储：用一个快照联接可配置提供方目录（`llm.providers`）、设置命名
 * 空间（共享 settings 镜像）和被引用凭据（`credentials.describe`）。Host 始终是
 * 唯一事实来源；每次变更都通过线协议写入，页面从下一次推送或重新获取的 describe
 * 重新渲染。
 */

import type {
  ConfigurableProviderView, CredentialView, IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/**
 * 任意路由键遍历 dict schema 都会到达同一 profile 节点，因此查询使用一个不可能
 * 与已配置路由冲突的名称。
 */
const PROBE_ROUTE = '\u0000probe'

/** 页面渲染的一行提供方。 */
export interface ProviderRow {
  /** 目录条目，包括路由 ID、展示名、设置地址和实时状态。 */
  entry: ConfigurableProviderView
  /** 是否有任一层配置此提供方，即其 profile 能否解析。 */
  configured: boolean
  /** 是否只有用户层携带 profile；移除后会恢复 base。 */
  removable: boolean
  /** 已解析 profile 指定凭据时，其凭据引用。 */
  apiKeyEnv: string | undefined
  /** describe 完成后 {@link apiKeyEnv} 对应的凭据状态。 */
  credential: CredentialView | undefined
}

/** 页面快照。 */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 整体加载失败文本；行级写入失败保留在编辑器中。 */
  error: string | null
  /** 凭据补充失败；提供方/settings 行仍可使用。 */
  credentialError: string | null
  /** settings 提供方是否接受写入。 */
  writable: boolean
  /** 每个可配置提供方与其配置/凭据状态的联接结果。 */
  rows: readonly ProviderRow[]
  /** 按 ns 索引的命名空间视图，供编辑器读取 schema/layers/secrets。 */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
}

/**
 * 线协议调用被拒绝时的可读文本。传输失败会以 Error 拒绝，Host 或运行时则可能
 * 用任意值拒绝，但页面仍必须显示内容。
 * @param error - 拒绝值。
 * @returns 要显示的消息。
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 为提供方路由派生常规凭据引用。v1 页面从不要求用户填写环境变量名，因此输入的键
 * 保存到该派生引用下，profile 则把它记录为 `apiKeyEnv`。
 * @param provider - 提供方路由 ID，如 `anthropic`、`minimax-cn`。
 * @returns 派生引用名，如 `MINIMAX_CN_API_KEY`。
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * 手工声明路由可指定的线协议，从所属命名空间自身 schema 读取。它保持为 schema
 * 读取而不是线协议字段，使页面提供的选项不会与 adapter 接受的选项漂移；两者都
 * 来自同一个 `Config`。
 * @param namespace - 其 schema 声明 profile 结构的命名空间视图。
 * @param schema - settings schema 操作。
 * @returns 协议标识列表；schema 没有声明时为空列表。
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** 已解析 profile 指定的凭据引用，即其 `apiKeyEnv` 字段。 */
function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined) return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** Models 设置页控制器；每个设置界面一个。 */
export class ModelsSettingsStore {
  /** 分区用于渲染的快照，来自符合 uSES 要求的存储。 */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
  })

  /** 最新加载获胜；旧响应绝不覆盖新响应。 */
  private generation = 0

  /**
   * @param api - 线协议接口，包括 credentials/llm 领域和 settings 写入。
   * @param describeFace - 共享镜像的 describe 接口，提供命名空间视图和可写性。
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * 刷新整个页面快照：并行读取提供方目录和镜像 settings 回答，再对所有被引用 ref
   * 批量执行一次凭据 describe。提供方失败或缺少初始 settings 回答时保留最近正常行
   * 并显示错误；settings 刷新失败则复用镜像持有的视图。
   * @returns 无返回值；结果由快照承载。
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: readonly SettingsNamespaceView[]
    try {
      const [providersResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.describeFace.ensure(),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      const mirrored = this.describeFace.getSnapshot()
      if (mirrored.view === undefined) {
        throw new Error(mirrored.error ?? 'settings are unavailable in this browser')
      }
      providers = providersResponse.result.value.providers
      writable = mirrored.view.writable
      views = mirrored.view.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && this.schema.hasPath(namespace.user, entry.settingsPath)
        && !this.schema.hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
      }
    })
    const refs = [...new Set(rows.flatMap(row => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))]
    let credentials: Record<string, CredentialView> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs })
        // 凭据状态只是 Models 页的补充信息：业务拒绝和传输失败都不会让整体加载失败。
        // 下方 onboarding 投影仍保留失败类别差异。
        if (response.result.ok) credentials = response.result.value.credentials
        else credentialError = response.result.error.message
      } catch (error) {
        credentialError = messageOf(error)
      }
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.map(row => ({
        ...row,
        ...row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
          ? { credential: credentials[row.apiKeyEnv] }
          : {},
      }))
      s.namespaces = namespaces
    })
  }
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
