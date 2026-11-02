/**
 * Process-local keyed mutex. Callers with the same key run one at a time; a
 * different key never blocks. Keys are released in FIFO order and an aborted
 * waiter opens the gate for its successors instead of wedging the queue.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Run `task` while holding the key.
   * @param key - serialization key (one workspace root per key).
   * @param signal - cancellation while queued; aborts before running `task`.
   * @param task - critical section.
   * @returns the task value.
   */
  async run<T>(key: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key, signal)
    try {
      return await task()
    } finally {
      release()
    }
  }

  private async acquire(key: string, signal: AbortSignal | undefined): Promise<() => void> {
    signal?.throwIfAborted()
    const previous = this.tails.get(key) ?? Promise.resolve()
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    // The queue tail must always resolve, so a throwing task cannot poison it.
    const queued = previous.then(() => gate, () => gate)
    this.tails.set(key, queued)

    let closed = false
    const release = (): void => {
      if (closed) return
      closed = true
      if (this.tails.get(key) === queued) this.tails.delete(key)
      open()
    }

    try {
      await waitFor(previous, signal)
    } catch (error) {
      release()
      throw error
    }
    return release
  }
}

function waitFor(promise: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return promise.then(() => undefined, () => undefined)
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('aborted while queued'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    promise.then(settle, settle)
  })
}
