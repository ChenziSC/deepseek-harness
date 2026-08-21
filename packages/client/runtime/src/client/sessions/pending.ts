// PendingWait 是等待中 Host 交互的载体协议部分。runtime 只了解信封，即把 rpcId 回填
// 到 client-response；业务结果编码属于该交互的消费者包。

import type {
  ClientResponse, MuxFrame, RpcId, RpcReceipt, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'

/** 以 kind 为键的载荷映射：请求帧去除信封字段后的业务字段。 */
export interface PendingPayloads {
  approval: Omit<Extract<MuxFrame, { type: 'approval/requested' }>, 'type' | 'sessionId'>
  question: Omit<Extract<MuxFrame, { type: 'question/requested' }>, 'type' | 'sessionId'>
}

/** 等待交互的判别字段，即 PendingPayloads 的键。 */
export type PendingKind = keyof PendingPayloads

/** 当前阻塞进度的用户操作在 session 列表中的摘要。 */
export type PendingInteractionStatus = 'approval' | 'plan-review' | 'question'

/** 以 kind 判别的具体等待联合类型；按 `kind` 收窄后可确定 `payload` 类型。 */
export type PendingInteraction = { [K in PendingKind]: PendingWait<K> }[PendingKind]

/** 每种 kind 对应一个键前缀；该键同时作为 Session pending map 的键。 */
const KEY_PREFIX: Record<PendingKind, string> = { approval: 'a', question: 'q' }

/**
 * 一个等待中的 Host 所有交互：由不可变渲染接口（kind/key/sessionId/payload）和响应
 * 载体组成。respond() 把请求帧的 rpcId 回填进 client-response 信封，消费者不会看到
 * 原始 rpcId。是否完成只由其是否仍在 pending 列表中表达；settled 标记仅用于明确
 * 防止重复响应，不是渲染输入。
 */
export class PendingWait<K extends PendingKind = PendingKind> {
  /** 交互 kind，也是联合类型判别字段。 */
  readonly kind: K
  /** 不透明渲染身份 `<prefix>:<rpcId>`；基线重放期间稳定，可用作 React key。 */
  readonly key: string
  /** 所属 session。 */
  readonly sessionId: SessionId
  /** 请求帧的业务字段，原样保留。 */
  readonly payload: PendingPayloads[K]
  #settled = false
  readonly #rpcId: RpcId
  readonly #respond: (message: ClientResponse) => Promise<RpcReceipt>

  /**
   * Session 收到 requested 帧时创建；公开构造器供测试 fixture 使用。
   * @param kind - 交互 kind。
   * @param rpcId - 请求帧的稳定信封 ID；私有保存，由 respond 回显。
   * @param sessionId - 所属 session。
   * @param payload - 请求帧的业务字段。
   * @param respond - client-response 载体，即 api.respond。
   */
  constructor(
    kind: K, rpcId: RpcId, sessionId: SessionId, payload: PendingPayloads[K],
    respond: (message: ClientResponse) => Promise<RpcReceipt>,
  ) {
    this.kind = kind
    this.key = `${KEY_PREFIX[kind]}:${rpcId}`
    this.sessionId = sessionId
    this.payload = payload
    this.#rpcId = rpcId
    this.#respond = respond
  }

  /**
   * 为本次等待发送结果：将其包装进 client-response 信封并回填 rpcId。完成后再次调用
   * 会同步抛错。
   * @param result - 由调用方按业务编码的结果外壳，即成功值或错误信封。
   * @returns 载体回执。
   */
  respond(result: ClientResponse['result']): Promise<RpcReceipt> {
    if (this.#settled) throw new Error(`pending wait ${this.key} is already settled`)
    return this.#respond({ type: 'client-response', rpcId: this.#rpcId, result })
  }

  /** 仅供 Session 使用的完成标记；表示权威 resolved 帧已到达，此后 respond() 会抛错。 */
  markSettled(): void {
    this.#settled = true
  }
}
