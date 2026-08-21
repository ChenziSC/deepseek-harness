/**
 * 从 welcome settings 作用域派生的欢迎提示状态。作用域就是传输：loopback 浏览器
 * 跟随 Host 持久化分区；远程浏览器的 memory 模式作用域永不回答，确认状态只保留
 * 在本进程。
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION,
} from '../onboarding-copy.ts'

/** 欢迎步骤渲染的状态。 */
export interface WelcomeNoticeState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  acknowledged: boolean
  error: string | null
}

/** 欢迎提示所读取的 welcome 分区。 */
export type WelcomeSection = Record<string, unknown>

/**
 * 原样接受任意对象分区；畸形持久化值读取为空分区，使提示把它视为未确认，而不是
 * 让作用域停留在旧值。
 * @param section - 线协议分区值。
 * @returns 分区对象；非对象值返回空对象。
 */
export function decodeWelcomeSection(section: unknown): WelcomeSection {
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    ? section as WelcomeSection
    : {}
}

/* v8 ignore next 3 -- closed-union default only defends future source widening */
function assertNever(_value: never): never {
  throw new Error('unexpected welcome settings status')
}

/** 协调 Host 持久确认或远程浏览器的进程内 fallback。 */
export class WelcomeNoticeStore {
  /** 由已注册欢迎步骤共享、符合 uSES 要求的状态来源。 */
  readonly store: SnapshotStore<WelcomeNoticeState> = createSnapshotStore<WelcomeNoticeState>({
    status: 'idle', acknowledged: false, error: null,
  })

  private localAcknowledged = false
  private saving = false
  private following: (() => void) | undefined

  /**
   * @param scope - welcome settings 命名空间作用域；其 memory 模式使远程浏览器
   * 状态保持在进程内。
   */
  constructor(private readonly scope: SettingsScope<WelcomeSection>) {}

  /**
   * 开始跟随已绑定作用域（幂等），并发布当前回答。
   * @returns 当前回答发布后完成。
   */
  load(): Promise<void> {
    this.following ??= this.scope.subscribe(() => { this.derive() })
    this.derive()
    return Promise.resolve()
  }

  /**
   * 持久化当前文案版本；远程浏览器则只推进本进程。成功以写入留下的状态判断，
   * 因此被拒绝或失败的写入在恢复读取完成后返回 false。
   * @returns 所选持久化模式已保存确认时为 true。
   */
  async acknowledge(): Promise<boolean> {
    if (this.scope.getSnapshot().mode === 'memory') {
      this.localAcknowledged = true
      this.derive()
      return true
    }
    this.saving = true
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    try {
      await this.scope.set(WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION)
    } finally {
      this.saving = false
    }
    this.derive()
    const { acknowledged } = this.store.getSnapshot()
    if (!acknowledged) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = 'the acknowledgement did not persist'
      })
    }
    return acknowledged
  }

  /** 停止跟随作用域。 */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.saving) return
    const scope = this.scope.getSnapshot()
    if (scope.mode === 'memory') {
      this.store.update((state) => {
        state.status = 'ready'
        state.acknowledged = this.localAcknowledged
        state.error = null
      })
      return
    }
    switch (scope.status) {
      case 'loading':
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        return
      case 'unavailable':
        this.store.update((state) => {
          state.status = 'error'
          state.acknowledged = false
          state.error = 'welcome acknowledgement settings are unavailable'
        })
        return
      case 'ready': {
        const acknowledged = scope.value?.[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION
        this.store.update((state) => {
          state.status = 'ready'
          state.acknowledged = acknowledged
          state.error = null
        })
        return
      }
      /* v8 ignore next -- every current settings scope status is handled above */
      default: return assertNever(scope.status)
    }
  }
}
