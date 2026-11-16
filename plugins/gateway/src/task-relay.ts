/**
 * Task relay: after an anchor hit, hand the message to ⑤.
 *
 * Module ① never reads or writes ⑤'s tables (AR33). The port below is
 * implemented by the host on top of ⑤'s public module API
 * (`bindThread` / `enqueueInput`), so ① can be tested with a fake and the
 * real wiring stays a composition concern.
 *
 * Rules (docs/11 §13.3, docs/15 §9.6 / AR35–AR37):
 * - only a live task accepts input; a finished task is attached but the wake
 *   waits for a Grant re-check (AR37), so nothing is enqueued here;
 * - system / CI messages are context only and never wake a task;
 * - an explicit reply-to anchor is bound as an `anchor` subscription so later
 *   messages resolve to the same task.
 */

import type { FollowUpResolution } from './ingest.js'

export interface TaskRelayPort {
  /** ⑤ `TaskSubscriptionApi.bind` with `relation='anchor'`; idempotent. */
  attach(input: {
    taskId: string
    threadId: string
    anchorMsgId: string | null
  }): { id: string }
  /** ⑤ `TaskInputApi.enqueue`; idempotent on `(task_id, inbox_id)`. */
  enqueue(input: { taskId: string; inboxId: string }): { id: string }
}

export type RelaySkipReason = 'no-port' | 'finished-needs-grant' | 'system-message'

export interface TaskRelayReport {
  attached: boolean
  enqueued: boolean
  subscriptionId: string | null
  inputId: string | null
  skipped: RelaySkipReason | null
}

export interface TaskRelayInput {
  taskId: string
  threadId: string
  inboxId: string
  replyToMsgId: string | null
  matchedBy: FollowUpResolution['matchedBy']
  /** False for a finished task: attach only, wake after ③ re-verifies (AR37). */
  live: boolean
  /** System / CI messages never wake a task. */
  systemMessage?: boolean
}

export function relayToTask(
  port: TaskRelayPort | null,
  input: TaskRelayInput,
): TaskRelayReport {
  if (port === null) {
    return {
      attached: false,
      enqueued: false,
      subscriptionId: null,
      inputId: null,
      skipped: 'no-port',
    }
  }
  if (input.systemMessage === true) {
    return {
      attached: false,
      enqueued: false,
      subscriptionId: null,
      inputId: null,
      skipped: 'system-message',
    }
  }

  let subscriptionId: string | null = null
  if (input.matchedBy === 'anchor' && input.replyToMsgId !== null) {
    subscriptionId = port.attach({
      taskId: input.taskId,
      threadId: input.threadId,
      anchorMsgId: input.replyToMsgId,
    }).id
  }

  if (!input.live) {
    return {
      attached: subscriptionId !== null,
      enqueued: false,
      subscriptionId,
      inputId: null,
      skipped: 'finished-needs-grant',
    }
  }

  const queued = port.enqueue({ taskId: input.taskId, inboxId: input.inboxId })
  return {
    attached: subscriptionId !== null,
    enqueued: true,
    subscriptionId,
    inputId: queued.id,
    skipped: null,
  }
}
