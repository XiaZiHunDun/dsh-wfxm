/**
 * Quiet-window decorator for `NotifyPort` (G6 静默窗/去重).
 *
 * Policy, not transport: any adapter can be wrapped. A message carrying a
 * `key` is delivered at most once per window; repeats return a receipt with
 * `suppressed: true` and never reach the transport. A failed delivery does not
 * open the window, so retries are not silenced. State is in-memory by design —
 * the outbound layer (⑥) may swap in a persisted store later.
 */

import type { NotifyLevel, NotifyMessage, NotifyPort, NotifyReceipt } from './port.js'

export interface QuietWindowOptions {
  /** Window length in milliseconds; 0 disables suppression. */
  windowMs: number
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number
}

export function withQuietWindow(port: NotifyPort, options: QuietWindowOptions): NotifyPort {
  const lastSent = new Map<string, number>()
  const clock = options.now ?? Date.now

  return {
    transport: port.transport,
    async notify(level: NotifyLevel, message: NotifyMessage): Promise<NotifyReceipt> {
      const key = message.key
      if (options.windowMs > 0 && key !== undefined && key !== '') {
        const now = clock()
        for (const [seen, at] of lastSent) {
          if (now - at >= options.windowMs) lastSent.delete(seen)
        }
        if (lastSent.has(key)) {
          return {
            transport: port.transport,
            id: '',
            deliveredAt: new Date(now).toISOString(),
            suppressed: true,
          }
        }
        const receipt = await port.notify(level, message)
        lastSent.set(key, now)
        return receipt
      }
      return port.notify(level, message)
    },
  }
}
