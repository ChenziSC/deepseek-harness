/** 实例级原生图片转换并发限制。 */

/**
 * 异步图片压缩的 FIFO 限流器。队列归 AttachmentStore 实例所有，因此不同部署的
 * 并发配置不会通过全局状态相互干扰。
 */
export class CompressionLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []

  /**
   * @param concurrency - 同时执行的任务数上限，必须为正数。
   */
  constructor(readonly concurrency: number) {}

  /**
   * 获得实例槽位后执行一项任务。不论任务成功或失败，都会释放槽位并唤醒队首。
   * @param task - 直到 settle 前一直占用一个槽位的压缩操作。
   * @returns 任务结果。
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1
        const release = (): void => {
          this.active -= 1
          this.waiting.shift()?.()
        }
        void Promise.resolve().then(task).then(
          (value) => {
            release()
            resolve(value)
          },
          (error: unknown) => {
            release()
            reject(error instanceof Error
              ? error
              : new Error('Image compression task rejected with a non-Error value.', { cause: error }))
          },
        )
      }
      if (this.active < this.concurrency) start()
      else this.waiting.push(start)
    })
  }
}
