import { z } from 'zod'
import { sha256Hex, stableStringify } from './canonical.js'

export interface SessionLike {
  id?: string
}

export interface SessionEventLike {
  type?: string
  seq?: number
  time?: number
  data?: unknown
}

/** Fields that go into `audit_log`; canonical fields follow docs/15 §三·模块 ④. */
export interface AuditFields {
  sessionId: string | null
  sessionSeq: number | null
  time: number
  actorId: string | null
  action: string
  target: string | null
  correlationId: string | null
  payloadDigest: string
}

const ToolCallData = z.object({
  turn: z.number(),
  step: z.number(),
  callId: z.string(),
  name: z.string(),
  arguments: z.string(),
})

const ToolResultData = z.object({
  turn: z.number(),
  step: z.number(),
  message: z.object({ toolCallId: z.string().optional() }),
})

const ApprovalAskedData = z.object({
  id: z.string(),
  toolName: z.string(),
  callId: z.string().optional(),
  reason: z.string().optional(),
})

const ApprovalDecidedData = z.object({
  id: z.string(),
  outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']),
})

/**
 * Map one dsh `session/event` into an audit row. Events outside the four
 * audited types return null. A known type with an unexpected payload still
 * yields a row (digest preserved, target/correlation null) so the audit chain
 * keeps no silent gaps.
 */
export function toAuditFields(session: SessionLike | undefined, event: SessionEventLike | undefined): AuditFields | null {
  if (!event || typeof event.type !== 'string') return null
  const type = event.type
  if (type !== 'tool/call' && type !== 'tool/result' && type !== 'approval/asked' && type !== 'approval/decided') {
    return null
  }

  let target: string | null = null
  let correlationId: string | null = null
  if (type === 'tool/call') {
    const parsed = ToolCallData.safeParse(event.data)
    if (parsed.success) {
      target = parsed.data.name
      correlationId = parsed.data.callId
    }
  } else if (type === 'tool/result') {
    const parsed = ToolResultData.safeParse(event.data)
    if (parsed.success) correlationId = parsed.data.message.toolCallId ?? null
  } else if (type === 'approval/asked') {
    const parsed = ApprovalAskedData.safeParse(event.data)
    if (parsed.success) {
      target = parsed.data.toolName
      correlationId = parsed.data.id
    }
  } else {
    const parsed = ApprovalDecidedData.safeParse(event.data)
    if (parsed.success) {
      target = parsed.data.outcome
      correlationId = parsed.data.id
    }
  }

  return {
    sessionId: typeof session?.id === 'string' ? session.id : null,
    sessionSeq: Number.isSafeInteger(event.seq) ? (event.seq as number) : null,
    time: Number.isSafeInteger(event.time) ? (event.time as number) : Date.now(),
    actorId: null,
    action: type,
    target,
    correlationId,
    payloadDigest: sha256Hex(stableStringify(event.data ?? null)),
  }
}
