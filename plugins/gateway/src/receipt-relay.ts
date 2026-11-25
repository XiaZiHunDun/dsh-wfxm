/**
 * Receipt closure: ⑤ writes a `receipt`, ① announces it and settles it.
 *
 * ① never reads ⑤'s tables (AR33): the port below is implemented by the host
 * on top of ⑤'s `pendingReceipts` / `markReceiptDelivered`. The relay turns
 * each undelivered receipt into one outbox row (deduplicated by receipt id),
 * and `settle` is called from the dispatcher's `onSent` hook once the channel
 * returns an `external_msg_id`.
 *
 * L3 recovery: because the row is marked `sent` before `onSent` runs, a crash
 * (or a throwing hook) leaves a delivered row with an unsettled receipt. The
 * next pump sees that `sent` row and settles it with the row's own
 * `external_msg_id` — never by sending again. A row that exhausted its retries
 * (`failed`) is reported as `stuck` instead of being counted as enqueued, so a
 * dead delivery is visible rather than silently retried forever.
 *
 * A receipt without a live thread (e.g. a Web-only task) is skipped instead of
 * being sent nowhere; it stays pending in ⑤ for a later channel (docs/15 §9.6).
 */

import type { OutboxItem } from './model.js'
import type { GatewayStore } from './store.js'

export interface TaskReceipt {
  id: string
  taskId: string
  round: number | null
  summary: string
  evidenceLocator: string | null
  threadId: string | null
  createdAt: string
}

/** `TaskReceiptApi` as implemented by ⑤ (`@dsh-wfxm/tasks`). */
export interface TaskReceiptPort {
  pendingReceipts(limit?: number): TaskReceipt[]
  markReceiptDelivered(id: string, externalMsgId: string): unknown
}

/**
 * Slice AS (A4): turns an over-long receipt into a local file the channel can
 * upload. Implemented by the host (redaction + `outbox-files/`); ① only calls.
 */
export interface SpillPort {
  write(input: { name: string; content: string }): { path: string; name: string }
}

export interface ReceiptRelayOptions {
  store: GatewayStore
  receipts: TaskReceiptPort
  /** Outbox topic; defaults to `task.receipt`. */
  topic?: string
  /** Max receipts scanned per `pump`; defaults to 20. */
  limit?: number
  /** Absent/null keeps every receipt as inline text. */
  spill?: SpillPort | null
  /** Receipt bodies longer than this spill to a file; `0` disables spilling. */
  spillThresholdChars?: number
  /**
   * L3: called when an outbox row already went out but the receipt was never
   * settled (crash / throwing hook). Runs before `settle` so a failure here
   * keeps the receipt pending for the next pump instead of losing the anchor.
   */
  onReplayed?: (input: { receipt: TaskReceipt; item: OutboxItem; externalMsgId: string }) => void
}

/** Chat-side excerpt when the body went to a file. */
export const SPILL_EXCERPT_CHARS = 300

export interface ReceiptRelayReport {
  scanned: number
  /** A deliverable row was ensured: newly inserted, or already `pending`. */
  enqueued: number
  /** The row was already `sent`; the receipt was settled from that message. */
  recovered: number
  /** The row is `failed` (retries exhausted) and needs an operator requeue. */
  stuck: number
  skippedNoThread: number
}

export interface ReceiptRelay {
  pump(limit?: number): ReceiptRelayReport
  settle(receiptId: string, externalMsgId: string): void
  /** Reads the receipt id out of one of this relay's outbox payloads. */
  receiptIdOf(item: { topic: string; payload: unknown }): string | null
}

export const RECEIPT_TOPIC = 'task.receipt'

function receiptIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const value = (payload as Record<string, unknown>).receiptId
  return typeof value === 'string' && value !== '' ? value : null
}

export function createReceiptRelay(options: ReceiptRelayOptions): ReceiptRelay {
  const { store, receipts } = options
  const topic = options.topic ?? RECEIPT_TOPIC
  const defaultLimit = options.limit ?? 20
  const spill = options.spill ?? null
  const spillThreshold = options.spillThresholdChars ?? 0

  /**
   * A spill failure must not lose the receipt: falling back to inline text is
   * always deliverable, and the chat copy says the attachment is missing.
   */
  const spillOf = (receipt: TaskReceipt): { path: string; name: string } | null => {
    if (spill === null || spillThreshold <= 0 || receipt.summary.length <= spillThreshold) return null
    try {
      return spill.write({ name: `receipt-${receipt.id}.md`, content: receipt.summary })
    } catch {
      return null
    }
  }

  const settle = (receiptId: string, externalMsgId: string): void => {
    receipts.markReceiptDelivered(receiptId, externalMsgId)
  }

  return {
    pump(limit) {
      const report: ReceiptRelayReport = {
        scanned: 0,
        enqueued: 0,
        recovered: 0,
        stuck: 0,
        skippedNoThread: 0,
      }
      for (const receipt of receipts.pendingReceipts(limit ?? defaultLimit)) {
        report.scanned += 1
        if (receipt.threadId === null || store.getThread(receipt.threadId) === null) {
          report.skippedNoThread += 1
          continue
        }
        const dedupeKey = `task-receipt:${receipt.id}`
        const existing = store.findOutboxByDedupe(dedupeKey)
        if (existing !== null && existing.status === 'sent' && existing.externalMsgId !== null) {
          // C1: the message went out but the receipt was never settled. Rebuild
          // the anchor first (host hook), then settle; a throw here keeps the
          // receipt pending so the next pump retries instead of losing it.
          try {
            options.onReplayed?.({
              receipt,
              item: existing,
              externalMsgId: existing.externalMsgId,
            })
          } catch {
            report.stuck += 1
            continue
          }
          settle(receipt.id, existing.externalMsgId)
          report.recovered += 1
          continue
        }
        if (existing !== null && existing.status === 'failed') {
          // C2: retries are exhausted; only an operator requeue can revive it.
          report.stuck += 1
          continue
        }
        if (existing !== null) {
          // Pending (possibly waiting for a retry): the unique dedupe key
          // already guarantees exactly one row.
          report.enqueued += 1
          continue
        }
        const spilled = spillOf(receipt)
        const excerpt = receipt.summary.length <= SPILL_EXCERPT_CHARS
          ? receipt.summary
          : `${receipt.summary.slice(0, SPILL_EXCERPT_CHARS)}…`
        store.enqueueOutbox({
          topic,
          payload: {
            receiptId: receipt.id,
            taskId: receipt.taskId,
            round: receipt.round,
            summary: receipt.summary,
            evidenceLocator: receipt.evidenceLocator,
            ...spilled === null
              ? {}
              : {
                kind: 'file',
                filePath: spilled.path,
                fileName: spilled.name,
                text: `${excerpt}\n（完整回执 ${receipt.summary.length} 字，见附件 ${spilled.name}）`,
              },
          },
          taskId: receipt.taskId,
          threadId: receipt.threadId,
          dedupeKey,
        })
        report.enqueued += 1
      }
      return report
    },

    settle,

    receiptIdOf(item) {
      return item.topic === topic ? receiptIdFromPayload(item.payload) : null
    },
  }
}
