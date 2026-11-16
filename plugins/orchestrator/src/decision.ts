/**
 * Validation of the front-desk decision (docs/17 §7.3: S2's output is a
 * structured `choice + reason`, and it may only tighten what the rules allow).
 *
 * Everything the model returns is untrusted text: unknown actions, oversized
 * bodies and inflated risk levels are rejected here instead of reaching ⑤. A
 * rejected decision is never guessed into an action — the caller degrades to the
 * deterministic rule foreground (loudly, see `foreground.ts`).
 */

export type DecisionRisk = 'R0' | 'R1'

export type Decision =
  | { action: 'reply'; text: string }
  | { action: 'task'; intent: string; risk: DecisionRisk }
  | { action: 'queue'; text: string }

export type DecisionParse =
  | { ok: true; decision: Decision }
  | { ok: false; reason: string }

export interface ParseDecisionOptions {
  /** True when this thread has a live task a `queue` decision could target. */
  liveTask?: boolean
  /** Replies longer than this are rejected (channel split is 4000). */
  maxReplyChars?: number
  /** Intents longer than this are rejected. */
  maxIntentChars?: number
}

export const DEFAULT_MAX_REPLY_CHARS = 4_000
/** ⑤ caps a task intent at 500 characters; validate here so it degrades early. */
export const DEFAULT_MAX_INTENT_CHARS = 500

/** Strip fences / prose and return the outermost JSON object, or null. */
export function extractJsonObject(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced === null ? text : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return body.slice(start, end + 1)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function parseDecision(raw: string, options: ParseDecisionOptions = {}): DecisionParse {
  const maxReply = options.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS
  const maxIntent = options.maxIntentChars ?? DEFAULT_MAX_INTENT_CHARS

  const json = extractJsonObject(raw)
  if (json === null) return { ok: false, reason: 'not-json' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  const record = asRecord(parsed)
  if (record === null) return { ok: false, reason: 'not-an-object' }

  const action = nonEmpty(record.action)
  if (action === null) return { ok: false, reason: 'missing-action' }

  if (action === 'reply') {
    const text = nonEmpty(record.text)
    if (text === null) return { ok: false, reason: 'reply-empty' }
    if (text.length > maxReply) return { ok: false, reason: 'reply-too-long' }
    return { ok: true, decision: { action: 'reply', text } }
  }

  if (action === 'task') {
    const intent = nonEmpty(record.intent)
    if (intent === null) return { ok: false, reason: 'intent-empty' }
    if (intent.length > maxIntent) return { ok: false, reason: 'intent-too-long' }

    const rawRisk = record.risk
    if (rawRisk === undefined || rawRisk === null || rawRisk === '') {
      return { ok: true, decision: { action: 'task', intent, risk: 'R1' } }
    }
    if (typeof rawRisk !== 'string') return { ok: false, reason: 'invalid-risk' }
    const risk = rawRisk.trim().toUpperCase()
    if (risk === 'R0' || risk === 'R1') {
      return { ok: true, decision: { action: 'task', intent, risk } }
    }
    // §8.7: R2+ needs assertions from the template library; the front desk has
    // none, so it is not allowed to raise the level. Reject rather than lower it.
    if (risk === 'R2' || risk === 'R3') return { ok: false, reason: 'risk-not-allowed' }
    return { ok: false, reason: 'invalid-risk' }
  }

  if (action === 'queue') {
    const text = nonEmpty(record.text)
    if (text === null) return { ok: false, reason: 'queue-empty' }
    if (text.length > maxIntent) return { ok: false, reason: 'queue-too-long' }
    if (options.liveTask !== true) return { ok: false, reason: 'queue-without-task' }
    return { ok: true, decision: { action: 'queue', text } }
  }

  return { ok: false, reason: 'unknown-action' }
}
