/**
 * Host port bindings (AR33): every cross-module hop goes through a structural
 * port documented by the consuming module (`@dsh-wfxm/gateway`). ⑤ / ③ / ⑥ are
 * only ever touched through their public module API; no table is read here and
 * no protocol name appears (AR32).
 *
 * A missing port is never silently "fine": control throws (① marks the inbox
 * failed), the Grant check denies, and R3 snapshots stay refused by the worker.
 */

import {
  WAKE_ACTION,
  type ApprovalAnswerPort,
  type ApprovalDetailPort,
  type GrantCheckPort,
  type Json,
  type ProjectLookupPort,
  type TaskControlPort,
  type TaskReceiptPort,
  type TaskRelayPort,
  type TaskWakePort,
} from '@dsh-wfxm/gateway'
import type { ApprovalStore, GrantStore } from '@dsh-wfxm/governance'
import {
  rollbackTask,
  type CheckpointRollbackPort,
  type TaskStore,
} from '@dsh-wfxm/tasks'

export interface HostPortDeps {
  tasks: TaskStore
  grants?: GrantStore | null
  project?: ProjectLookupPort | null
  /** ⑦'s `createPreimageRollbackPort(store)`; absent = rollback refuses loudly. */
  rollback?: CheckpointRollbackPort | null
  /** ③'s approval store; absent = approval clicks are reported as unavailable. */
  approvals?: ApprovalStore | null
  /** Shared host clock; defaults to wall time. Tests pin it. */
  now?: () => Date
}

export interface HostPorts {
  relay: TaskRelayPort
  control: TaskControlPort
  receipts: TaskReceiptPort
  wake: TaskWakePort
  grantCheck: GrantCheckPort
  approvalAnswer: ApprovalAnswerPort
  approvalDetail: ApprovalDetailPort
  project: ProjectLookupPort | null
  rollback: CheckpointRollbackPort | null
}

export const NO_GRANT_REASON = 'no-grant-store'
export const NO_APPROVAL_REASON = 'no-approval-store'
export const ROLLBACK_REASON = 'rollback-unavailable'

export function createHostPorts(deps: HostPortDeps): HostPorts {
  const { tasks, grants = null, project = null, rollback = null, approvals = null } = deps
  const clock = deps.now ?? (() => new Date())

  const relay: TaskRelayPort = {
    attach(input) {
      return tasks.bindThread({
        taskId: input.taskId,
        threadId: input.threadId,
        relation: 'anchor',
        anchorMsgId: input.anchorMsgId,
      })
    },
    enqueue(input) {
      return tasks.enqueueInput({ taskId: input.taskId, inboxId: input.inboxId })
    },
  }

  const control: TaskControlPort = {
    control(input) {
      if (input.action === 'rollback') {
        // Undo works on finished tasks too; only "can we actually restore"
        // decides success. A missing port must not look like a no-op.
        if (rollback === null) throw new Error(ROLLBACK_REASON)
        rollbackTask({
          store: tasks,
          port: rollback,
          taskId: input.taskId,
          ...input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId },
        })
        return { status: tasks.getTask(input.taskId)?.status ?? 'unknown' }
      }
      const to = input.action === 'cancel' ? 'cancelled' : input.action === 'pause' ? 'paused' : 'running'
      const cancelled = input.action === 'cancel'
      const task = tasks.transition(input.taskId, {
        to,
        ...cancelled ? { summary: 'stopped by owner' } : {},
        reason: `control:${input.action}`,
      })
      return { status: task.status }
    },
  }

  const receipts: TaskReceiptPort = {
    pendingReceipts(limit) {
      return tasks.pendingReceipts(limit)
    },
    markReceiptDelivered(id, externalMsgId) {
      return tasks.markReceiptDelivered(id, externalMsgId)
    },
  }

  const wake: TaskWakePort = {
    wake(input) {
      const task = tasks.wakeTask({
        taskId: input.taskId,
        ...input.reason === undefined ? {} : { reason: input.reason },
      })
      return { status: task.status, round: task.round }
    },
  }

  // AR37 / AR13: no Grant store means "cannot re-verify", never "allowed".
  const grantCheck: GrantCheckPort = {
    verify(input) {
      if (grants === null) return { ok: false, reason: NO_GRANT_REASON }
      const result = grants.verify({
        actorId: input.actorId,
        required: { actions: input.required.actions.length === 0 ? [WAKE_ACTION] : input.required.actions },
      })
      return { ok: result.ok, reason: result.reason }
    },
  }

  // AR13: no approval store means "cannot decide", reported back to ① loudly.
  const approvalAnswer: ApprovalAnswerPort = {
    answer(input) {
      if (approvals === null) return { ok: false, code: NO_APPROVAL_REASON }
      const result = approvals.answer({
        approvalId: input.approvalId,
        decision: input.decision,
        actorId: input.actorId,
        nonce: input.nonce,
      })
      const report = {
        ok: result.ok,
        code: result.code,
        ...result.status === undefined ? {} : { status: result.status },
        ...result.stage === undefined ? {} : { stage: result.stage },
        ...result.nonce === undefined ? {} : { nonce: result.nonce },
      }
      // A refused click (double click / expired / bad nonce) must not touch the
      // task: ③ is the only judge of whether the decision happened.
      if (!result.ok) return report

      // Slice I: the card is a view, so the task id comes from ③'s record.
      const taskId = approvals.get(input.approvalId)?.taskId ?? null
      if (taskId === null) return report

      if (input.decision !== 'rejected') {
        const resumed = tasks.resumeFromApproval({
          taskId,
          approvalId: input.approvalId,
          actorId: input.actorId,
          now: clock(),
        })
        return {
          ...report,
          taskId,
          ...resumed.task === null ? {} : { taskStatus: resumed.task.status },
        }
      }

      // Rejected: the task stays alive but parked (docs/11 state machine).
      // Losing a race here must not make the decision look failed.
      try {
        const task = tasks.transition(taskId, { to: 'paused', reason: 'approval-rejected' })
        return { ...report, taskId, taskStatus: task.status }
      } catch {
        const task = tasks.getTask(taskId)
        return { ...report, taskId, ...task === null ? {} : { taskStatus: task.status } }
      }
    },
  }

  // Read-only detail view (Slice L): joins ③'s record with ⑤'s task. It never
  // answers, withdraws or consumes a nonce — the "details" button is display only.
  const approvalDetail: ApprovalDetailPort = {
    details(input) {
      if (approvals === null) return { ok: false, code: NO_APPROVAL_REASON }
      const record = approvals.get(input.approvalId)
      if (record === null) return { ok: false, code: 'not-found' }
      const task = record.taskId === null ? null : tasks.getTask(record.taskId)
      const assertions = task === null
        ? []
        : tasks.listAssertions(task.id).map((item) => ({
          kind: item.kind,
          status: item.status,
          spec: item.spec,
        }))
      return {
        ok: true,
        code: 'ok',
        detail: {
          approvalId: record.id,
          level: record.level,
          summary: record.summary,
          status: record.status,
          stage: record.confirmStage,
          requestedAt: record.requestedAt,
          expiresAt: record.expiresAt,
          decidedAt: record.decidedAt,
          decidedBy: record.decidedBy,
          impact: record.impact as unknown as Json,
          task: task === null
            ? null
            : {
              taskId: task.id,
              taskRef: task.taskRef ?? null,
              intent: task.intent,
              riskLevel: task.riskLevel,
              status: task.status,
              plan: task.plan ?? null,
              assertions,
            },
        },
      }
    },
  }

  return { relay, control, receipts, wake, grantCheck, approvalAnswer, approvalDetail, project, rollback }
}
