/**
 * 输入触发流水线的冻结跨包约定。这里只包含类型，不包含运行时代码。
 * 各来源（ui-commands / ui-skill / ui-reference）和会话输入层都从这里
 * 导入类型，因此修改必须由主线统一协调。
 *
 * 每次调用时，提供方只会收到 {@link ClientSessionContext} 投影，绝不会
 * 收到 Cordis 上下文或可变的 Session。RPC 和服务访问必须经由提供方插件
 * 注册时捕获的根上下文完成。
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * 面向提供方的客户端会话投影。它只携带稳定身份；需要调用 Agent 绑定 RPC
 * 的来源必须查询自身服务的能力状态，因为被寻址的持久化子智能体即使拥有
 * 客户端作用域，也可能没有仍在运行的 Host Agent。
 */
export interface ClientSessionContext {
  readonly sessionId: SessionId
}

/** 来源绑定的触发字符。 */
export type TriggerChar = '/' | '@'

/** 触发词元在草稿中的位置：开头（去除空白后的草稿以它起始）或行内。 */
export type TriggerPosition = 'leading' | 'inline'

/** 本次选择由菜单、空格或回车三条路径中的哪一条产生。 */
export type PickVia = 'menu' | 'space' | 'enter'

/** 一个菜单候选项。它只是展示数据，不声明任何行为。 */
export interface InputTriggerCandidate {
  readonly name: string
  readonly description?: string
  readonly icon?: string
  readonly hint?: string
  /** 相邻候选项可共享的可选视觉标题；存在分段时，分组不再显示来源标题行。 */
  readonly section?: string
  /** 由来源拥有并解释的不透明选择载荷。 */
  readonly value?: string
}

/** 选择瞬间的触发词元区间快照。CAS：draftRev 已过期时，整个动作不产生效果。 */
export interface TokenSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** 随一次已认领提交事务发送的 Base64 编码编辑器图片。 */
export interface SubmitImageAttachment {
  /** 声明的媒体类型；宿主会用解码后的字节验证它。 */
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** 图片字节的规范 Base64 编码。 */
  readonly data: string
  /** 可选展示名称；绝不会按路径解释。 */
  readonly name?: string
}

/**
 * 进入命令模式的凭证。它只有纯数据和一个闭包方法，没有类或跨包运行时值，
 * 从而保持客户端产物纯净。
 */
export interface CommandClaim {
  /** 持续校验完整性的草稿前缀，如 `'/goal '`；不再满足 startsWith 时释放认领。 */
  readonly token: string
  /** 命令参数为空时渲染的幽灵文本提示。 */
  readonly hint?: string
  /**
   * 此命令提交时能否携带编辑器图片附件。未提供时，只要仍附有图片，编辑器
   * 就会拒绝提交，并在显示提示的同时保留草稿和图片。
   */
  readonly images?: boolean
  /**
   * 由来源以闭包形式提供的回车提交事务。
   * @param images - 随提交携带的已序列化编辑器图片；仅当
   *   {@link CommandClaim.images} 为 true 时，编辑器才会传入它们。
   */
  submit(args: string, actx: ClientContext, images: readonly SubmitImageAttachment[]): Promise<SubmitOutcome>
}

/**
 * 行内引用插入。草稿保存完整展示文本，同时引用实例保留自身区间；拥有者在
 * 插入时提供两个面向用户的投影，面向模型的表示则在提交时通过来源编解码器序列化。
 */
export interface ReferenceInsert {
  readonly source: string
  readonly ref: string
  /** 行内展示标签（同时缓存在引用实例上，供降级显示）。 */
  readonly label: string
  /** 显示在标签旁的可选领域图标。 */
  readonly appearance?: 'session' | 'file' | 'folder'
  /** 剪贴板/持久化投影，如 `/name`（绝不是模型表示）。 */
  readonly clipboardText: string
}

/** 命令提交事务完成后的结果。 */
export interface SubmitOutcome {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/**
 * 统一的选择返回值。`undefined` 表示未命中，交给默认出口；`'handled'` 表示
 * 来源已在内部处理（例如打开自己的弹窗外壳）。`text` 分支是纯文本引用路径
 * （决策记录见
 * .agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
 *）：词元区间会替换成字面文本，不创建引用实例身份或占位符；后续的胶囊视觉
 * 完全由渲染侧用来源词典扫描草稿后推导。
 */
export type PickOutcome =
  | { readonly claim: CommandClaim }
  | { readonly insert: ReferenceInsert }
  | { readonly text: string; readonly continue?: boolean }
  | 'handled'
  | undefined

/**
 * 回车裁决可见的非文本编辑器提交状态。实际附件载荷由编辑器拥有；裁决只需知道
 * 它们是否存在，以决定接受还是拒绝整次提交。
 */
export interface SubmitEnvelope {
  /** 随草稿提交的图片附件数量。 */
  readonly images: number
}

/** 传给来源的候选请求。查询变化或菜单关闭时，signal 会被新请求取代。 */
export interface CandidateRequest {
  readonly query: string
  /** 当前 @file 词元是否为尚未闭合引号的路径。 */
  readonly quoted?: boolean
  readonly position: TriggerPosition
  readonly signal: AbortSignal
}

/** 来源在选择时收到的全部数据：候选项、会话投影，以及用于 CAS 的区间快照。 */
export interface InputTriggerPick {
  readonly candidate: InputTriggerCandidate
  readonly session: ClientSessionContext
  readonly position: TriggerPosition
  readonly via: PickVia
  readonly span: TokenSpan
}

/**
 * 由产生 {@link ReferenceInsert} 结果的来源拥有的引用编解码器：一部分负责
 * 复制、剪切和持久化所用的剪贴板投影，另一部分由提交尝试按引用实例调用，生成
 * 模型表示。后者是异步过程，取消沿用本次尝试的 signal；失败会阻止发送，绝不
 * 静默降级成剪贴板文本。
 */
export interface ReferenceCodec {
  /** 单个引用的剪贴板/持久化投影，如 `/name`。 */
  clipboardText(ref: string): string
  /** 单个引用的模型序列化结果，如 `<skill>name</skill>`。 */
  serialize(ref: string, signal: AbortSignal): Promise<string>
}

/**
 * 一个触发来源。每个回调都会收到会话的 ClientSessionContext 投影；来源不会
 * 跨调用保存该投影的副本。
 *
 * 空格/回车裁决依赖可选的匹配钩子：实现钩子本身就表示参与裁决。流水线会把
 * 开头词元依次交给所有实现方，按注册顺序取第一个非 undefined 结果；无人认领
 * 时进入默认出口。两个钩子分开，是因为时间预算不同：空格发生在输入过程中，
 * 必须从热状态同步回答；回车则可以等待来源自身预热完成。
 */
export interface InputTriggerSource {
  readonly trigger: TriggerChar
  /** 菜单分组标签；在同一触发字符下必须唯一，重复注册会抛错。 */
  readonly name: string
  /** 菜单分组展示顺序（数值越小越靠前，默认为 0）。 */
  readonly order?: number
  /** 菜单是否渲染来源标题行，默认为 true。 */
  readonly showGroupTitle?: boolean
  candidates(session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]>
  /** 所有选择都会到达这里；认领/插入结果由流水线通过限定作用域的输入事件执行。 */
  onPick(pick: InputTriggerPick): PickOutcome
  /** 仅基于热状态执行的同步空格裁决。`token` 是刚完成的开头词元，如 '/goal'。 */
  matchSpace?(session: ClientSessionContext, token: string): PickOutcome
  /**
   * 回车时裁决；可以强等待来源自身预热，并在预热失败时拒绝。`line` 是去除空白
   * 后的完整草稿：来源自行解析并应用类别策略——允许参数的类别即使带有尾随文本
   * 也会认领；只允许裸词元的类别只有在线内容与词元完全一致时才认领，否则返回
   * undefined。`envelope` 描述编辑器提交的其余部分；若来源本会消费文本行，却
   * 无法消费整个提交信封，就应抛错并显式呈现拒绝，同时保持提交内容完整。
   */
  matchEnter?(
    session: ClientSessionContext,
    line: string,
    signal: AbortSignal,
    envelope: SubmitEnvelope,
  ): Promise<PickOutcome>
  /**
   * 作用域创建时的预热钩子（触发后不等待）：每会话控制器在会话作用域生效时
   * 调用一次，让来源能在首次交互前获取支撑数据。
   */
  warm?(session: ClientSessionContext): void
  /**
   * 用于装饰纯文本引用的同步热快照名称表。实现此方法本身就表示参与：渲染侧会
   * 扫描草稿中的 `<trigger><name>` 词元，并装饰精确匹配项。`undefined` 表示
   * 支撑数据尚未预热，此时不装饰，也绝不发起获取；渲染路径必须保持同步且无副作用。
   */
  lexicon?(session: ClientSessionContext): readonly string[] | undefined
  /**
   * 订阅某个会话中此来源 {@link InputTriggerSource.lexicon} 返回值的变化，包括
   * 支撑数据就绪、失效或刷新。每次通知后控制器都会重新读取词典；预热后名称表
   * 永不变化的来源可以不实现此钩子。
   * @param session - 稳定的会话投影。
   * @param listener - 失效回调。
   * @returns 取消订阅函数。
   */
  subscribeLexicon?(session: ClientSessionContext, listener: () => void): () => void
  /** 引用编解码器；会产生插入结果的来源必须提供。 */
  readonly codec?: ReferenceCodec
}

/** 由接线层根据输入阶段推导出的触发器可用级别。 */
export interface TriggerGuard {
  /** plain：'/'、'@' 均可用；claimed：禁用 '/'、保留 '@'；frozen：全部禁用。 */
  readonly tier: 'plain' | 'claimed' | 'frozen'
}

/** 菜单打开时拦截的按键（全部受 IME 组合输入保护）。 */
export type ArbitrateKey = 'up' | 'down' | 'enter' | 'escape'

/** consumed：已处理；pick-highlighted：回车选中了高亮项；pass：交给输入框处理。 */
export type ArbitrateOutcome = 'consumed' | 'pick-highlighted' | 'pass'

/** 限定作用域的开始命令输入事件载荷。 */
export interface BeginCommandRequest {
  readonly claim: CommandClaim
  readonly span: TokenSpan
}

/** 限定作用域的插入引用输入事件载荷。 */
export interface InsertReferenceRequest {
  readonly reference: ReferenceInsert
  readonly span: TokenSpan
}

/** 限定作用域的消费词元输入事件载荷。 */
export interface ConsumeTokenRequest {
  readonly guard:
    | { readonly kind: 'span'; readonly span: TokenSpan }
    | { readonly kind: 'bare-token'; readonly token: string }
}

/** 限定作用域的插入文本输入事件载荷（纯文本引用路径）。 */
export interface InsertTextRequest {
  /** 触发词元区间的字面替换文本，如 `/name `。 */
  readonly text: string
  readonly span: TokenSpan
  /** 拼接后保持补全开启（用于进入目录）：输入层会从光标位置重新跟踪。 */
  readonly continue?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 把一次命令认领应用到限定作用域的 Input。事件携带会话作用域载体分发；
     * 只有阶段检查与区间 CAS 都通过且状态机确实发生变化时，所属会话的输入监听器
     * 才返回 `true`，生产方把其他结果一律视为“未应用”。
     * @param request - 命令认领与菜单时刻的区间 CAS。
     * @mode bail
     */
    'slash/input-begin-command'(request: BeginCommandRequest): true | undefined
    /**
     * 向限定作用域的 Input 插入一个引用；载体路由和“确实应用才返回 true”的约定
     * 与 begin-command 相同。
     * @param request - 引用与菜单时刻的区间 CAS。
     * @mode bail
     */
    'slash/input-insert-reference'(request: InsertReferenceRequest): true | undefined
    /**
     * 业务成功后（弹窗结算/菜单选择执行）消费一个命令词元。载体路由和应用结果
     * 约定与前述事件相同。
     * @param request - 精确区间或裸词元保护条件。
     * @mode bail
     */
    'slash/input-consume-token'(request: ConsumeTokenRequest): true | undefined
    /**
     * 用字面文本替换触发词元区间，也就是纯文本引用路径。载体路由和应用结果约定
     * 与前述事件相同；草稿只增加普通字符，不创建引用实例记录。
     * @param request - 替换文本与菜单时刻的区间 CAS。
     * @mode bail
     */
    'slash/input-insert-text'(request: InsertTextRequest): true | undefined
  }
}
