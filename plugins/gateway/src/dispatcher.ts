/**
 * Single outbox dispatcher (module ①, docs/13 §3.2).
 *
 * Semantics, in order:
 * - **One dispatcher + lease**: `claimOutbox` steals `pending` rows with a
 *   lease, so two instances never deliver the same row (the lease is also the
 *   crash recovery: an expired lease is claimable again).
 * - **Ack needs `external_msg_id`**: a transport answer without a message id is
 *   recorded as a failed attempt, never as `sent`.
 * - **Backoff**: 1s → 5s → 30s → 2m → 10m, then `failed` after 6 attempts.
 * - **Idempotency**: the transport receives `outbox.id` as the idempotency key,
 *   so a retry does not double-notify.
 */

import { OUTBOX_MAX_ATTEMPTS, type OutboxItem } from './model.js'
import { isTransportError, type OutboxDelivery, type OutboxTransport } from './port.js'
import type { GatewayStore } from './store.js'

export interface DispatchReport {
  claimed: number
  sent: number
  retried: number
  failed: number
  /** Post-send hooks that threw; the row is still `sent`. */
  settleFailed: number
}

export interface OutboxDispatcherOptions {
  store: GatewayStore
  transport: OutboxTransport
  /** Lease owner; defaults to a per-process name. */
  owner?: string
  /** Lease length in ms; defaults to 60s. */
  leaseMs?: number
  /** Max rows claimed per `runOnce`; defaults to 10. */
  limit?: number
  now?: () => Date
  /**
   * Called after a row is marked `sent`, e.g. to close ⑤'s receipt loop.
   * A throwing hook never turns a delivered row back into a retry.
   */
  onSent?: (item: OutboxItem, externalMsgId: string) => void
  /**
   * P6-1 delivery telemetry. `final` is true when the row will not be retried.
   * A throwing hook never changes delivery semantics.
   */
  onFailed?: (item: OutboxItem, detail: {
    message: string
    retryable: boolean
    final: boolean
  }) => void
  /**
   * Failure visibility (Slice Q): a scheduled retry is `warn`, a give-up is
   * `error`. Only ids/topics/counts are logged — never the payload.
   */
  logger?: {
    warn?: (message: string) => void
    error?: (message: string) => void
  }
}

export interface OutboxDispatcher {
  runOnce(): Promise<DispatchReport>
}

function toDelivery(item: OutboxItem): OutboxDelivery {
  return {
    id: item.id,
    topic: item.topic,
    payload: item.payload,
    attempts: item.attempts,
    taskId: item.taskId,
    threadId: item.threadId,
    replyToMsgId: item.replyToMsgId,
  }
}

export function createOutboxDispatcher(options: OutboxDispatcherOptions): OutboxDispatcher {
  const { store, transport } = options
  const owner = options.owner ?? `dispatcher-${process.pid}`
  const leaseMs = options.leaseMs ?? 60_000
  const limit = options.limit ?? 10
  const now = options.now ?? (() => new Date())

  return {
    async runOnce() {
      const report: DispatchReport = { claimed: 0, sent: 0, retried: 0, failed: 0, settleFailed: 0 }
      const claimed = store.claimOutbox({ owner, leaseMs, limit, now: now() })
      report.claimed = claimed.length

      // Slice Q: a retry is a warning, an exhausted row is an error. The log
      // carries ids/counts only; payload text stays in the (redacted) outbox.
      const recordFailure = (item: OutboxItem, message: string, retryable: boolean): void => {
        const after = store.markOutboxFailed(item.id, { error: message, retryable, now: now() })
        if (options.onFailed !== undefined) {
          try {
            options.onFailed(item, { message, retryable, final: after.status === 'failed' })
          } catch {
            // Delivery semantics outrank telemetry.
          }
        }
        if (after.status === 'failed') {
          report.failed += 1
          options.logger?.error?.(
            `outbox failed after ${after.attempts} attempt(s): ${item.id} (${item.topic}): ${message}`,
          )
        } else {
          report.retried += 1
          options.logger?.warn?.(
            `outbox retry ${after.attempts}/${OUTBOX_MAX_ATTEMPTS}: ${item.id} (${item.topic}) at ${after.nextRetryAt ?? 'n/a'}: ${message}`,
          )
        }
      }

      for (const item of claimed) {
        let ack: Awaited<ReturnType<OutboxTransport['send']>>
        try {
          ack = await transport.send(toDelivery(item))
        } catch (error) {
          // Unknown failures are treated as transient: the row is retried and
          // eventually fails after the attempt ceiling, so a bug cannot turn
          // into a silent drop.
          const retryable = isTransportError(error) ? error.retryable : true
          const message = error instanceof Error ? error.message : String(error)
          recordFailure(item, message, retryable)
          continue
        }

        const externalMsgId = typeof ack.externalMsgId === 'string'
          ? ack.externalMsgId.trim()
          : ''
        if (externalMsgId === '') {
          recordFailure(item, 'transport returned no external_msg_id', true)
          continue
        }

        store.markOutboxSent(item.id, externalMsgId, now())
        report.sent += 1
        if (options.onSent !== undefined) {
          try {
            options.onSent(item, externalMsgId)
          } catch {
            // The message is delivered; a failing hook must not cause a resend.
            report.settleFailed += 1
          }
        }
      }

      return report
    },
  }
}
