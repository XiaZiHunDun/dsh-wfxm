/**
 * Safe text reader for ①'s `inbox.content`.
 *
 * ① owns the message body, so redaction happens here at the owner boundary;
 * consumers (digests, logs) must not depend on @dsh-wfxm/redact themselves just
 * to read one message. This never writes and never returns non-text content.
 */

import { redactText } from '@dsh-wfxm/redact'
import type { Json } from './model.js'

/**
 * Redacts free text that is about to leave ①'s boundary (model prompt, log).
 * Kept here so consumers don't need their own @dsh-wfxm/redact dependency.
 */
export function redactedText(value: string): string {
  return redactText(value).value
}

/**
 * Returns the redacted, trimmed text of an inbound message, or `null` when the
 * content carries no text (card actions, controls, malformed rows).
 */
export function inboundText(content: Json): string | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null
  const text = (content as Record<string, Json>).text
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  return redactText(trimmed).value
}
