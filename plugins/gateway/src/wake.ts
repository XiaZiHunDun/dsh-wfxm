/**
 * AR37 wake: a reply that lands on a `succeeded` task may start a new round —
 * but only after ③ re-verified the actor (docs/11 §13.3 第 7 行).
 *
 * Module ① never imports ③ or ⑤ (AR33). Both ports below are structural types
 * the host composes onto ③'s `verify` and ⑤'s `wakeTask`; the action string
 * lives here so the gateway and the grant scope cannot drift.
 *
 * `task_ref` / thread anchors are routing hints only, never authorization
 * input: the wake decision is the Grant check, not the reply.
 */

export const WAKE_ACTION = 'task.wake'

export interface GrantCheckPort {
  verify(input: {
    actorId: string
    required: { actions: string[] }
  }): { ok: boolean; reason?: string }
}

export interface TaskWakePort {
  wake(input: { taskId: string; reason?: string }): { status: string; round: number }
}

export type WakeSkipReason = 'no-port'

export interface WakeReport {
  /** True once ③ re-verified the actor for `task.wake`. */
  granted: boolean
  /** ③'s rejection reason (`revoked` / `not-found` / `scope-mismatch` / ...). */
  reason: string | null
  woken: boolean
  /** Task status after the wake (⑤ returns `queued`). */
  status: string | null
  /** New round after the wake. */
  round: number | null
  skipped: WakeSkipReason | null
}

export interface WakePorts {
  grant: GrantCheckPort | null
  wake: TaskWakePort | null
}

export interface WakeInput {
  taskId: string
  actorId: string
  reason?: string
}

/**
 * Re-verify, then wake. A missing port is fail-closed: the caller keeps the
 * "needs Grant" marker and nothing is woken. A port that throws is a delivery
 * failure and propagates, so the caller can mark the inbox `failed`.
 */
export function wakeTask(ports: WakePorts, input: WakeInput): WakeReport {
  if (ports.grant === null || ports.wake === null) {
    return {
      granted: false,
      reason: null,
      woken: false,
      status: null,
      round: null,
      skipped: 'no-port',
    }
  }

  const check = ports.grant.verify({
    actorId: input.actorId,
    required: { actions: [WAKE_ACTION] },
  })
  if (!check.ok) {
    return {
      granted: false,
      reason: check.reason ?? 'denied',
      woken: false,
      status: null,
      round: null,
      skipped: null,
    }
  }

  const woken = ports.wake.wake({
    taskId: input.taskId,
    ...input.reason === undefined ? {} : { reason: input.reason },
  })
  return {
    granted: true,
    reason: null,
    woken: true,
    status: woken.status,
    round: woken.round,
    skipped: null,
  }
}
