/**
 * Telemetry seam for module ⑤ (P6-1).
 *
 * The worker, isolation resolver and merge service only need to *emit* and to
 * record attempt rows. Declaring the port here keeps ⑤ free of a runtime
 * dependency on `@dsh-wfxm/telemetry` (AR32 structural twin); the host injects
 * the real store.
 */

export interface TaskTelemetryPort {
  emit(event: Record<string, unknown>): boolean
  beginAttempt(input: {
    taskId: string
    attempt: number
    traceId: string
    executor?: string
    model?: string
    sessionRef?: string
    traceRef?: string
    startedAt?: string | number | Date
  }): unknown
  finishAttempt(taskId: string, attempt: number, input: {
    outcome: 'succeeded' | 'failed' | 'cancelled'
    failureKind?: string
    errorCode?: string
    summary?: string
    finishedAt?: string | number | Date
    model?: string
    inputTokens?: number
    outputTokens?: number
    costUsd?: number
  }): boolean
}

/** Deterministic span ids: the same task can be recomputed from its row. */
export function taskSpanId(taskId: string): string {
  return `task:${taskId}`
}

export function attemptSpanId(taskId: string, attempt: number): string {
  return `attempt:${taskId}:${attempt}`
}

export function stepSpanId(taskId: string, attempt: number, step: number): string {
  return `step:${taskId}:${attempt}:${step}`
}

export function toolSpanId(taskId: string, attempt: number, step: number, seq: number): string {
  return `tool:${taskId}:${attempt}:${step}:${seq}`
}

/**
 * Emit without ever letting telemetry change the business outcome. The real
 * store already never throws in `emit`; this also protects structural fakes.
 */
export function noteTelemetry(
  telemetry: TaskTelemetryPort | null | undefined,
  event: Record<string, unknown>,
  onError?: (error: unknown) => void,
): void {
  if (telemetry === null || telemetry === undefined) return
  try {
    telemetry.emit(event)
  } catch (error) {
    onError?.(error)
  }
}
