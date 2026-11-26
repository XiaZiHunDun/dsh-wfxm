/**
 * P6-2 owner diagnostics commands (docs/15 §十四).
 *
 * `/diag <任务号>`、`/diag suggestions` 和 `/status` bypass the model exactly
 * like `/eval`; the host checks `actor.kind === 'owner'` and renders the reply.
 */
export type DiagCommand =
  | { kind: 'diag'; ref: string | null }
  | { kind: 'suggestions' }
  | { kind: 'status' }

const STATUS_RE = /^\/status\s*$/i
const SUGGESTIONS_RE = /^\/diag\s+(?:suggestions?|建议)\s*$/i
const DIAG_RE = /^\/diag(?:\s+(@?\S+))?\s*$/i

export function parseDiagCommand(text: string): DiagCommand | null {
  const trimmed = text.trim()
  if (STATUS_RE.test(trimmed)) return { kind: 'status' }
  if (SUGGESTIONS_RE.test(trimmed)) return { kind: 'suggestions' }
  const match = DIAG_RE.exec(trimmed)
  if (match === null) return null
  const raw = match[1]?.replace(/^@/, '') ?? ''
  return { kind: 'diag', ref: raw === '' ? null : raw }
}
