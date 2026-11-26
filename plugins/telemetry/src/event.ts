/**
 * Telemetry event contract v1 (spec §3.1, docs/15 §十二).
 *
 * The schema is the single source of truth: types are inferred from it. The
 * normaliser never throws on optional noise, but it does reject events that
 * cannot be correlated (`traceId`, `phase`) or explain a failure
 * (`error.code` when `level='error'`).
 *
 * Privacy default is `meta`: only ids, digests, error codes, tool names and
 * durations survive. `full` additionally stores re-redacted error text and
 * whitelisted attributes. `off` drops everything but keeps drop counters.
 */

import { createHash } from 'node:crypto'
import { redactDeep, redactText } from '@dsh-wfxm/redact'
import { z } from 'zod'
import { uuidv7 } from './ids.js'

export type TelemetryMode = 'off' | 'meta' | 'full'
export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error'

export type AttrValue = string | number | boolean | null

/**
 * Attributes a collection point may attach. Unknown keys are dropped rather
 * than failing the whole event: instrumentation typos must not hide a failure.
 */
export const TELEMETRY_ATTR_KEYS: ReadonlySet<string> = new Set([
  'channel',
  'chat_id',
  'project',
  'risk_level',
  'isolation',
  'branch',
  'merge_state',
  'prepare_state',
  'step',
  'turn',
  'exit_code',
  'retry_after_ms',
  'http_status',
  'unit',
  'session_ref',
  'worktree',
  'receipt_id',
  'approval_id',
  'grant_id',
  'provider',
  'tool_call_id',
  'topic',
  'error_stage',
  'degraded',
])

const MAX_MESSAGE_CHARS = 2_000
const MAX_STACK_CHARS = 8_000
const MAX_SHORT_CHARS = 120

const attrValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const telemetryEventSchema = z
  .object({
    ts: z.union([z.string(), z.number(), z.date()]).optional(),
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    event: z.string().trim().min(1).max(80),
    traceId: z.string().trim().min(1).max(MAX_SHORT_CHARS),
    spanId: z.string().trim().min(1).max(MAX_SHORT_CHARS).optional(),
    parentSpanId: z.string().trim().max(MAX_SHORT_CHARS).optional(),
    threadId: z.string().trim().max(MAX_SHORT_CHARS).optional(),
    messageId: z.string().trim().max(MAX_SHORT_CHARS).optional(),
    projectId: z.string().trim().max(MAX_SHORT_CHARS).optional(),
    taskId: z.string().trim().max(MAX_SHORT_CHARS).optional(),
    taskRef: z.string().trim().max(MAX_SHORT_CHARS).optional(),
    round: z.number().int().nonnegative().optional(),
    attempt: z.number().int().nonnegative().optional(),
    phase: z.string().trim().min(1).max(40),
    status: z.string().trim().max(40).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    error: z
      .object({
        code: z.string().trim().min(1).max(MAX_SHORT_CHARS),
        kind: z.string().trim().max(40).optional(),
        message: z.string().max(64_000).optional(),
        stack: z.string().max(128_000).optional(),
        retryable: z.boolean().optional(),
      })
      .optional(),
    model: z
      .object({
        name: z.string().trim().max(MAX_SHORT_CHARS).optional(),
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
      })
      .optional(),
    tool: z
      .object({
        name: z.string().trim().max(MAX_SHORT_CHARS).optional(),
        args: z.string().max(64_000).optional(),
        exitCode: z.number().int().optional(),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .optional(),
    attrs: z.record(z.string(), attrValue).optional(),
  })
  .refine((value) => value.level !== 'error' || value.error !== undefined, {
    message: 'error events require error.code',
    path: ['error', 'code'],
  })

export type TelemetryEventInput = z.input<typeof telemetryEventSchema>
export type ValidatedTelemetryEvent = z.output<typeof telemetryEventSchema>

export interface NormalizedError {
  code: string
  kind: string | null
  messageDigest: string | null
  stackDigest: string | null
  retryable: boolean | null
  /** Raw text kept in memory for `full` rendering; never persisted in `meta`. */
  message: string | null
  stack: string | null
}

export interface NormalizedModel {
  name: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
}

export interface NormalizedTool {
  name: string | null
  argsDigest: string | null
  exitCode: number | null
  durationMs: number | null
}

export interface NormalizedTelemetryEvent {
  ts: string
  level: TelemetryLevel
  event: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  threadId: string | null
  messageId: string | null
  projectId: string | null
  taskId: string | null
  taskRef: string | null
  round: number | null
  attempt: number | null
  phase: string
  status: string | null
  durationMs: number | null
  error: NormalizedError | null
  model: NormalizedModel | null
  tool: NormalizedTool | null
  attrs: Record<string, AttrValue> | null
}

/** Validation failure: the caller passed something the contract cannot store. */
export class TelemetryError extends Error {
  readonly code: 'invalid-event' | 'invalid-mode' | 'invalid-input'
  readonly issues: string[]

  constructor(code: 'invalid-event' | 'invalid-mode' | 'invalid-input', issues: string[]) {
    super(`${code}: ${issues.join('; ')}`)
    this.name = 'TelemetryError'
    this.code = code
    this.issues = issues
  }
}

export function digestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Accepts ISO strings, epoch milliseconds and `Date`; invalid input falls back. */
export function toIsoTime(value: string | number | Date | undefined, fallback: Date): string {
  if (value === undefined) return fallback.toISOString()
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? fallback.toISOString() : value.toISOString()
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : fallback.toISOString()
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? fallback.toISOString() : new Date(parsed).toISOString()
}

export function validateTelemetryEvent(input: unknown): ValidatedTelemetryEvent {
  const parsed = telemetryEventSchema.safeParse(input)
  if (!parsed.success) {
    throw new TelemetryError(
      'invalid-event',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    )
  }
  return parsed.data
}

function optionalText(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

function optionalNumber(value: number | undefined): number | null {
  return value === undefined ? null : value
}

function normalizeAttrs(
  attrs: Record<string, AttrValue> | undefined,
): Record<string, AttrValue> | null {
  if (attrs === undefined) return null
  const kept: Record<string, AttrValue> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (TELEMETRY_ATTR_KEYS.has(key)) kept[key] = value
  }
  return Object.keys(kept).length === 0 ? null : kept
}

export function normalizeTelemetryEvent(
  input: unknown,
  now: Date = new Date(),
): NormalizedTelemetryEvent {
  const event = validateTelemetryEvent(input)
  const error: NormalizedError | null =
    event.error === undefined
      ? null
      : {
          code: event.error.code,
          kind: optionalText(event.error.kind),
          messageDigest:
            event.error.message === undefined ? null : digestText(event.error.message),
          stackDigest: event.error.stack === undefined ? null : digestText(event.error.stack),
          retryable: event.error.retryable ?? null,
          message: optionalText(event.error.message),
          stack: optionalText(event.error.stack),
        }
  const model: NormalizedModel | null =
    event.model === undefined
      ? null
      : {
          name: optionalText(event.model.name),
          inputTokens: optionalNumber(event.model.inputTokens),
          outputTokens: optionalNumber(event.model.outputTokens),
          costUsd: optionalNumber(event.model.costUsd),
        }
  const tool: NormalizedTool | null =
    event.tool === undefined
      ? null
      : {
          name: optionalText(event.tool.name),
          argsDigest: event.tool.args === undefined ? null : digestText(event.tool.args),
          exitCode: optionalNumber(event.tool.exitCode),
          durationMs: optionalNumber(event.tool.durationMs),
        }

  return {
    ts: toIsoTime(event.ts, now),
    level: event.level,
    event: event.event,
    traceId: event.traceId,
    spanId: event.spanId ?? uuidv7(now.getTime()),
    parentSpanId: optionalText(event.parentSpanId),
    threadId: optionalText(event.threadId),
    messageId: optionalText(event.messageId),
    projectId: optionalText(event.projectId),
    taskId: optionalText(event.taskId),
    taskRef: optionalText(event.taskRef),
    round: optionalNumber(event.round),
    attempt: optionalNumber(event.attempt),
    phase: event.phase,
    status: optionalText(event.status),
    durationMs: optionalNumber(event.durationMs),
    error,
    model,
    tool,
    attrs: normalizeAttrs(event.attrs),
  }
}

/** Second-pass redaction for text that survives into `full` mode. */
export function redactForStorage(value: string, maxChars: number): string {
  return redactText(value).value.slice(0, maxChars)
}

export function redactAttrsForStorage(
  attrs: Record<string, AttrValue>,
): Record<string, AttrValue> {
  return redactDeep(attrs).value
}

export const TELEMETRY_MESSAGE_LIMIT = MAX_MESSAGE_CHARS
export const TELEMETRY_STACK_LIMIT = MAX_STACK_CHARS

/** `DSH_WFXM_TRACE=off|meta|full`; absent means `meta`, unknown fails fast. */
export function resolveTelemetryMode(raw: string | undefined = process.env.DSH_WFXM_TRACE): TelemetryMode {
  if (raw === undefined || raw.trim() === '') return 'meta'
  const value = raw.trim().toLowerCase()
  if (value === 'off' || value === 'meta' || value === 'full') return value
  throw new TelemetryError('invalid-mode', [`DSH_WFXM_TRACE must be off|meta|full, got "${raw}"`])
}
