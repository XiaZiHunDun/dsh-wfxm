/**
 * Outbound guard for module ① (M7 / Slice BE).
 *
 * docs/11 §七 内容信任规则 #2: outbound content must pass a guard —
 * redaction, length, attachment size, target allowlist. This module owns the
 * first two at ①'s single export choke point (`store.enqueueOutbox`):
 *
 * 1. Redact secrets first (`@dsh-wfxm/redact`, the existing D19-2 mount).
 * 2. Cap free text (`text` / `summary`) so an injection-induced long output
 *    cannot flood the chat. Attachment size is already bounded by the executor
 *    (AS `MAX_ATTACHMENT_BYTES`); the target allowlist is enforced by the
 *    channel transport (only configured chats are addressable).
 *
 * Pure functions only: no I/O, no store access.
 */

import { redactDeep, type RedactHit } from '@dsh-wfxm/redact'
import type { Json } from './model.js'

/** Per-message text cap; Feishu segments at 4000 chars, so this is ~5 parts. */
export const MAX_OUTBOUND_TEXT_CHARS = 20_000

/** Only these payload keys carry user-visible free text. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['text', 'summary'])

export interface OutboundGuardOptions {
  /** Override the per-field cap (tests / future channel profiles). */
  maxTextChars?: number
}

export interface OutboundGuardResult {
  payload: Json
  /** Secret hits from the redaction pass (kind + length only, never values). */
  hits: RedactHit[]
  /** True when at least one `text` / `summary` field was truncated. */
  truncated: boolean
}

function truncationSuffix(dropped: number): string {
  return `\n…（输出过长，已截断 ${dropped} 字）`
}

function capText(
  value: string,
  max: number,
  state: { truncated: boolean },
): string {
  if (value.length <= max) return value
  state.truncated = true
  return `${value.slice(0, max)}${truncationSuffix(value.length - max)}`
}

/** True for objects we may clone; Date / Buffer / class instances pass through. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Redact secrets, then cap `text` / `summary`. Redaction runs first so a
 * truncation cut can never leave a half-masked secret in the payload.
 */
export function guardOutboundPayload(
  payload: Json,
  options: OutboundGuardOptions = {},
): OutboundGuardResult {
  const max = options.maxTextChars ?? MAX_OUTBOUND_TEXT_CHARS
  const redacted = redactDeep(payload)
  const state = { truncated: false }
  const seen = new WeakSet<object>()

  const walk = (value: Json): Json => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
      if (seen.has(value)) return value
      seen.add(value)
      return value.map((item) => walk(item))
    }
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return value
      seen.add(value)
      if (!isPlainObject(value)) return value
      const out: Record<string, Json> = {}
      for (const [key, item] of Object.entries(value)) {
        out[key] = typeof item === 'string' && TEXT_KEYS.has(key)
          ? capText(item, max, state)
          : walk(item as Json)
      }
      return out
    }
    return value
  }

  return {
    payload: walk(redacted.value),
    hits: redacted.hits,
    truncated: state.truncated,
  }
}
