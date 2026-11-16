/**
 * Channel transport seam (module ①, docs/11 §三 · docs/15 §五 ChannelPort).
 *
 * Protocol-neutral on purpose (AR32): no product names, URLs or commands live
 * here. A transport (long connection, webhook, ...) implements `OutboxTransport`
 * and is injected into the dispatcher; the gateway never speaks a protocol.
 *
 * The port only carries an outbound message and returns the transport-side
 * message id. Delivery is *not* considered successful without that id
 * (13 §3.2 ack rule) — an empty ack is treated as a missing receipt.
 */

import type { Json } from './model.js'

export interface OutboxDelivery {
  /** `outbox.id` — also the idempotency key (13 §3.2). */
  id: string
  topic: string
  payload: Json
  /** How many delivery attempts have been started, including this one. */
  attempts: number
  taskId: string | null
  threadId: string | null
  replyToMsgId: string | null
}

export interface OutboxDeliveryAck {
  /** Transport-side message id; without it the delivery is not acked. */
  externalMsgId?: string | null
}

export interface OutboxTransport {
  readonly transport: string
  send(delivery: OutboxDelivery): Promise<OutboxDeliveryAck>
}

export type TransportErrorCode =
  | 'unavailable'
  | 'rejected'
  | 'too-large'
  | 'timeout'
  | 'rate-limited'

const RETRYABLE: Record<TransportErrorCode, boolean> = {
  unavailable: true,
  rejected: false,
  'too-large': false,
  timeout: true,
  'rate-limited': true,
}

/** Adapters must translate their own failures into this shape (15 §五). */
export class TransportError extends Error {
  readonly retryable: boolean

  constructor(readonly code: TransportErrorCode, message: string) {
    super(message)
    this.name = 'TransportError'
    this.retryable = RETRYABLE[code]
  }
}

/**
 * Structural check (AR32/AR33): a channel plugin cannot import this class, so
 * any error carrying the documented shape (`name === 'TransportError'`, a known
 * `code`, a boolean `retryable`) is honoured as a transport error.
 */
export function isTransportError(error: unknown): error is TransportError {
  if (error instanceof TransportError) return true
  if (typeof error !== 'object' || error === null) return false
  const shape = error as { name?: unknown; code?: unknown; retryable?: unknown }
  return (
    shape.name === 'TransportError'
    && typeof shape.code === 'string'
    && shape.code in RETRYABLE
    && typeof shape.retryable === 'boolean'
  )
}
