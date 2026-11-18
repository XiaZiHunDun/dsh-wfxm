/**
 * Receipt closure: ⑤ writes a `receipt`, ① announces it and settles it.
 *
 * ① never reads ⑤'s tables (AR33): the port below is implemented by the host
 * on top of ⑤'s `pendingReceipts` / `markReceiptDelivered`. The relay turns
 * each undelivered receipt into one outbox row (deduplicated by receipt id),
 * and `settle` is called from the dispatcher's `onSent` hook once the channel
 * returns an `external_msg_id`.
 *
 * A receipt without a live thread (e.g. a Web-only task) is skipped instead of
 * being sent nowhere; it stays pending in ⑤ for a later channel (docs/15 §9.6).
 */

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
}

/** Chat-side excerpt when the body went to a file. */
export const SPILL_EXCERPT_CHARS = 300

export interface ReceiptRelayReport {
  scanned: number
  enqueued: number
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

  return {
    pump(limit) {
      const report: ReceiptRelayReport = { scanned: 0, enqueued: 0, skippedNoThread: 0 }
      for (const receipt of receipts.pendingReceipts(limit ?? defaultLimit)) {
        report.scanned += 1
        if (receipt.threadId === null || store.getThread(receipt.threadId) === null) {
          report.skippedNoThread += 1
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
          dedupeKey: `task-receipt:${receipt.id}`,
        })
        report.enqueued += 1
      }
      return report
    },

    settle(receiptId, externalMsgId) {
      receipts.markReceiptDelivered(receiptId, externalMsgId)
    },

    receiptIdOf(item) {
      return item.topic === topic ? receiptIdFromPayload(item.payload) : null
    },
  }
}
