/**
 * NotifyPort — outbound delivery only (docs/11 §端口表).
 *
 * This module is protocol-neutral on purpose (AR32): no product names, URLs or
 * commands live here. Transports (ntfy, IM, ...) implement `NotifyPort`.
 *
 * The port does not decide *whether* to speak: grading and quiet windows belong
 * to the caller / outbound module ⑥. `key` is carried through untouched so a
 * future dedup layer can collapse repeats without knowing the transport.
 */

export type NotifyLevel = 'p0' | 'p1'

export interface NotifyMessage {
  title: string
  body: string
  tags?: string[]
  /** Stable dedup key for a future quiet window; adapters pass it through. */
  key?: string
}

export interface NotifyReceipt {
  transport: string
  /** Transport-side message id, when the transport returns one. */
  id: string
  deliveredAt: string
  /** Set by a policy decorator when the quiet window swallowed the message. */
  suppressed?: boolean
}

export interface NotifyPort {
  readonly transport: string
  notify(level: NotifyLevel, message: NotifyMessage): Promise<NotifyReceipt>
}

export type NotifyErrorCode = 'not-configured' | 'upstream' | 'unavailable'

export class NotifyError extends Error {
  constructor(
    readonly code: NotifyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'NotifyError'
  }
}
