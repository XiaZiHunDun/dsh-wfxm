/**
 * Deterministic rule foreground (slice C placeholder for the real `orchestrator`).
 *
 * The front stage must never execute anything itself (AR25 / #11): it only
 * decides what this turn *is* and hands work to ⑤. This rule foreground keeps
 * one task per thread so consecutive messages stay in the same conversation
 * (#9), and it creates at most one `queued` task per new thread.
 *
 * Replacing this with the dsh `orchestrator` preset later means swapping the
 * injected `ForegroundHandler`; nothing else in the host changes.
 */

import type { IngestResult } from '@dsh-wfxm/gateway'
import { EXPERT_USAGE, parseExpertDirective, planTaskRisk } from '@dsh-wfxm/tasks'
import type { RiskLevel, TaskStore } from '@dsh-wfxm/tasks'

/** 体现前台的提醒视图（与 orchestrator 的结构一致；本包不依赖它）。 */
export interface ForegroundReminder {
  id: string
  text: string
  dueAt: string
  repeat: 'none' | 'daily' | 'weekly'
  when: string
  repeatLabel: string
}

export type ForegroundOutcome =
  | { action: 'task-created'; taskId: string; note?: string }
  | { action: 'input-queued'; taskId: string; inputId: string; note?: string }
  | { action: 'reply'; text: string; threadId: string; note?: string }
  // Slice AT (J5): 提醒相关的三种结果；宿主据此生成确认文案。
  | {
      action: 'reminder-created'
      reminderId: string
      text: string
      dueAt: string
      repeat: 'none' | 'daily' | 'weekly'
      when: string
      repeatLabel: string
      threadId: string
      note?: string
    }
  | { action: 'reminder-list'; items: ForegroundReminder[]; threadId: string; note?: string }
  | {
      action: 'reminder-cancelled'
      reminderId: string
      text: string
      when: string
      threadId: string
      note?: string
    }
  | { action: 'none'; reason: string; note?: string }

export interface ForegroundInput {
  result: IngestResult
  /** Plain text body, already extracted from the channel payload. */
  text: string | null
  /** Recent turns of this thread (旧→新), assembled by the host. */
  history?: readonly { role: 'user' | 'assistant'; text: string }[]
}

export type ForegroundHandler = (
  input: ForegroundInput,
) => ForegroundOutcome | Promise<ForegroundOutcome>

/**
 * Statuses that accept more input instead of starting a new task (#9).
 * `paused` is excluded on purpose — a rejected approval parks the task with no
 * resume entry, so treating it as live would block the thread forever.
 */
export const DEFAULT_LIVE_STATUSES: readonly string[] = [
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
]

export interface RuleForegroundOptions {
  tasks: TaskStore
  defaultRiskLevel?: RiskLevel
  liveStatuses?: readonly string[]
  /** Shown when the channel sends something the rule foreground cannot act on. */
  nonTextReply?: string
}

export const NON_TEXT_REPLY = '暂时只支持文本消息，请直接发文字。'

export function createRuleForeground(options: RuleForegroundOptions): ForegroundHandler {
  const { tasks } = options
  const riskLevel = options.defaultRiskLevel ?? 'R1'
  const liveStatuses = options.liveStatuses ?? DEFAULT_LIVE_STATUSES
  const nonTextReply = options.nonTextReply ?? NON_TEXT_REPLY

  return ({ result, text }) => {
    // ① already handled everything that is not a foreground turn.
    if (result.target.kind !== 'orchestrator') {
      return { action: 'none', reason: `target:${result.target.kind}` }
    }
    if (result.duplicate) return { action: 'none', reason: 'duplicate' }
    const thread = result.thread
    if (thread === null) return { action: 'none', reason: 'no-thread' }

    const trimmed = text === null ? '' : text.trim()
    if (trimmed === '') {
      return { action: 'reply', text: nonTextReply, threadId: thread.id }
    }

    // Continuity: a live task on this thread absorbs the message as input.
    const live = tasks.listTaskThreads({ threadId: thread.id, liveOnly: true })
      .map((binding) => tasks.getTask(binding.taskId))
      .find((task) => task !== null && liveStatuses.includes(task.status))
    if (live !== undefined && live !== null) {
      const input = tasks.enqueueInput({ taskId: live.id, inboxId: result.inbox.id })
      return { action: 'input-queued', taskId: live.id, inputId: input.id }
    }

    // Slice CH (O1): explicit expert only on the new-task path. A live task
    // above keeps its expert; switching mid-run would change the executor.
    const directive = parseExpertDirective(trimmed)
    if (directive.usage) return { action: 'reply', text: EXPERT_USAGE, threadId: thread.id }
    const plan = planTaskRisk(directive.intent, riskLevel)
    const task = tasks.createTask({
      intent: directive.intent,
      expert: directive.expert,
      riskLevel: plan.risk,
      originMsgId: result.inbox.msgId,
      projectId: result.project?.projectId ?? null,
      correlationId: result.inbox.id,
    })
    for (const assertion of plan.assertions) tasks.addAssertion(task.id, assertion)
    tasks.bindThread({
      taskId: task.id,
      threadId: thread.id,
      relation: 'default_owner',
      anchorMsgId: result.inbox.msgId,
    })
    const note = plan.reasons.length === 0 ? undefined : `risk-escalated:${plan.reasons.join(',')}`
    return note === undefined
      ? { action: 'task-created', taskId: task.id }
      : { action: 'task-created', taskId: task.id, note }
  }
}
