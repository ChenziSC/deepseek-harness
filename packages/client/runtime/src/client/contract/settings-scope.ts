/**
 * 设置命名空间 scope 接口。类型放在这里，因为这是所有拥有偏好设置的功能所依赖的
 * 公共包；实现和 Host 传输则随 Settings 界面（`dsh-client-ui-settings`）提供。功能
 * 服务通过 `attachSettings` 接收 scope，无需依赖负责绑定该 scope 的界面，从而避免
 * 形成循环引用。
 */

/** 一个设置命名空间在客户端的同步状态。 */
export interface SettingsScopeSnapshot<T> {
  /**
   * 首个 section 被接受前为 `loading`；已有有效 section 时为 `ready`；命名空间未向
   * 本客户端公开，或连接将偏好设置保留在进程内（memory 模式）时为 `unavailable`。
   */
  status: 'loading' | 'ready' | 'unavailable'
  /** 最近接受并经 schema 解析的 section；首次接受前为 undefined。 */
  value: T | undefined
  /**
   * 所有者插件声明组合层时，Host 据此解析 {@link value}。字段被清除后会回退到此层。
   */
  base: unknown
  /**
   * 存在时保存原始用户层。字段是否在这里出现决定它是否被覆盖；即使覆盖值等于组合
   * 默认值，仍然属于覆盖，因此不能只比较值。
   */
  user: unknown
  /** 用于隔离下一次写入的命名空间 revision；收到首个 Host 视图前为 undefined。 */
  revision: number | undefined
  /** Host 文档是否接受写入；memory 模式始终不接受。 */
  writable: boolean
  /** `host` 与 Host 文档同步；`memory` 将远程浏览器设置保留在进程内。 */
  mode: 'host' | 'memory'
}

/** 业务域拥有、供浏览器插件使用的设置命名空间说明。 */
export interface SettingsScopeSpec<T> {
  /** 所属 Host 插件注册的设置命名空间。 */
  namespace: string
  /**
   * 收窄一份传输 section；返回 undefined 时保留最近接受的值。默认逻辑按命名空间自身
   * 的序列化传输 schema 校验 section，因此业务域只有需要进一步收窄时才添加 decoder。
   */
  decode?: (section: unknown) => T | undefined
}

/**
 * 某命名空间持久 section 的响应式所有者 handle，是 Host 端 `SettingsScope` 所有者
 * 接口在浏览器中的镜像。业务域服务读取、观察快照，并通过 `set` 提交用户明确选择。
 */
export interface SettingsScope<T> {
  /** @returns 当前同步快照；下次变化前引用保持稳定。 */
  getSnapshot(): SettingsScopeSnapshot<T>
  /**
   * 观察快照替换。
   * @param listener - 每次快照变化后调用。
   * @returns 移除此监听器的 disposer。
   */
  subscribe(listener: () => void): () => void
  /**
   * 将一次字段写入排队。连续快速写入会保持修改顺序，每次都携带最新已知命名空间
   * revision，且只有最新请求完成时可以发布；若最新写入被拒绝或失败，则改为重新加载
   * Host 状态。
   * @param field - 命名空间 section 内的标量字段。
   * @param value - 用户选择的 JSON 结构值。
   * @returns 写入及必要的最新写入恢复读取完成后的 Promise。
   */
  set(field: string, value: unknown): Promise<void>
  /**
   * 将一次字段清除排队，使该字段重新继承组合层。排序、revision 和恢复约定与
   * {@link set} 相同。
   * @param field - 命名空间 section 内的标量字段。
   * @returns 清除及必要的最新写入恢复读取完成后的 Promise。
   */
  unset(field: string): Promise<void>
}
