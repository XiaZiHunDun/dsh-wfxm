/**
 * Model-backed front desk (docs/17 §二 `orchestrator`, slice D).
 *
 * The handler is still a `ForegroundHandler`: the host injects it exactly where
 * the rule foreground used to go, so nothing else in the composition changes.
 * What is new is *who decides* — one model turn turns the message into one of
 * three validated decisions (`reply` / `task` / `queue`) instead of every
 * message becoming a task.
 *
 * Guarantees kept by construction:
 *
 * - **#11 the front stage never executes**: it only creates tasks / queues input.
 *   The decision run itself is tool-less (see `assets/frontdesk.patch.yml`).
 * - **The model never widens scope**: `parseDecision` rejects R2/R3 and unknown
 *   shapes; a rejected or failed decision degrades to the deterministic rule
 *   foreground with a `note`, never to a guess.
 * - **A degradation is visible**: the outcome carries `note`, which the host
 *   records as a route decision (AR13: no silent drop, no silent fallback).
 *   A local quick answer carries `note: quick-answer:<kind>` for the same reason.
 */

import type { IngestResult } from '@dsh-wfxm/gateway'
import { planTaskRisk } from '@dsh-wfxm/tasks'
import type { RiskLevel, TaskStore } from '@dsh-wfxm/tasks'
import { parseDecision, type Decision, type DecisionRepeat } from './decision.js'
import { buildDecisionPrompt, type ConversationTurn } from './prompt.js'
import { createQuickAnswer, type QuickAnswer, type QuickChecks, type ResourceSnapshot } from './quick-answer.js'

/**
 * 已由宿主格式化好的提醒视图（本包不 import reminder，保持端口无关）。
 * `when` / `repeatLabel` 由宿主按 `Asia/Shanghai` 生成，模型与确认文案共用。
 */
export interface ReminderView {
  id: string
  text: string
  dueAt: string
  repeat: DecisionRepeat
  when: string
  repeatLabel: string
}

/** 前台能做的提醒写入，仅此三项；端口缺失即能力不存在。 */
export interface ReminderPort {
  create(input: {
    threadId: string
    text: string
    dueAt: string
    repeat: DecisionRepeat
    sourceMsgId: string | null
  }): ReminderView
  listPending(threadId: string, limit?: number): ReminderView[]
  cancel(id: string): ReminderView | null
}

export type ForegroundOutcome =
  | { action: 'task-created'; taskId: string; note?: string }
  | { action: 'input-queued'; taskId: string; inputId: string; note?: string }
  | { action: 'reply'; text: string; threadId: string; note?: string }
  | {
      action: 'reminder-created'
      reminderId: string
      text: string
      dueAt: string
      repeat: DecisionRepeat
      when: string
      repeatLabel: string
      threadId: string
      note?: string
    }
  | { action: 'reminder-list'; items: ReminderView[]; threadId: string; note?: string }
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
  history?: readonly ConversationTurn[]
}

export type ForegroundHandler = (
  input: ForegroundInput,
) => ForegroundOutcome | Promise<ForegroundOutcome>

/**
 * Statuses that accept more input instead of starting a new task (#9).
 * `paused` is deliberately absent: a rejected approval leaves the task paused,
 * there is no resume entry yet, so keeping it "live" made every later message
 * attach to a task that can never run again (2026-11-13 实测，线程被永久占住).
 */
export const DEFAULT_LIVE_STATUSES: readonly string[] = [
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
]

/** Shown when the channel sends something the front desk cannot act on. */
export const NON_TEXT_REPLY = '暂时只支持文本消息，请直接发文字。'

export interface OrchestratorForegroundOptions {
  tasks: TaskStore
  /** The model seam: prompt in, raw model text out. `createDshDecisionRunner`. */
  decide: (prompt: string, sessionKey?: string) => Promise<string>
  /** Downgrade path for a failed / rejected decision. Defaults to the rule foreground. */
  fallback?: ForegroundHandler
  liveStatuses?: readonly string[]
  maxReplyChars?: number
  /**
   * ⑤ rejects intents over 500 characters; validating here means an oversized
   * intent degrades instead of throwing inside `createTask`.
   */
  maxIntentChars?: number
  logger?: { warn?(message: string): void } | null
  /**
   * Read-only resource probe (svcops `createResourceProbe`). When set, a
   * short, unambiguous resource question is answered locally instead of
   * spending a decision run — milliseconds instead of seconds.
   */
  probe?: (() => Promise<ResourceSnapshot>) | null
  /** Slice S: read-only unit / port / log checks; absent methods fall through. */
  checks?: QuickChecks | null
  /** Slice AT (J5): 提醒端口；缺失时前台不提供提醒动作。 */
  reminders?: ReminderPort | null
  /** 可注入时钟（测试与提醒的相对时间换算）。 */
  now?: () => Date
}

interface LiveTask {
  id: string
  status: string
  intent: string
}

function liveTaskOn(tasks: TaskStore, threadId: string, liveStatuses: readonly string[]): LiveTask | null {
  const bindings = tasks.listTaskThreads({ threadId, liveOnly: true })
  for (const binding of bindings) {
    const task = tasks.getTask(binding.taskId)
    if (task !== null && liveStatuses.includes(task.status)) {
      return { id: task.id, status: task.status, intent: task.intent }
    }
  }
  return null
}

export function createOrchestratorForeground(options: OrchestratorForegroundOptions): ForegroundHandler {
  const { tasks, decide } = options
  const liveStatuses = options.liveStatuses ?? DEFAULT_LIVE_STATUSES
  const logger = options.logger ?? null
  const quickAnswer = createQuickAnswer({ tasks, probe: options.probe ?? null, checks: options.checks ?? null })
  const reminders = options.reminders ?? null
  const clock = options.now ?? (() => new Date())

  /** Rule-shaped actions, so a model decision and a fallback look the same. */
  function createTask(result: IngestResult, threadId: string, intent: string, risk: RiskLevel): ForegroundOutcome {
    // The model never raises risk; this deterministic layer may (17 §7.1), and
    // attaches the template assertion that makes the escalation verifiable.
    const plan = planTaskRisk(intent, risk)
    const task = tasks.createTask({
      intent,
      riskLevel: plan.risk,
      originMsgId: result.inbox.msgId,
      projectId: result.project?.projectId ?? null,
    })
    for (const assertion of plan.assertions) tasks.addAssertion(task.id, assertion)
    tasks.bindThread({
      taskId: task.id,
      threadId,
      relation: 'default_owner',
      anchorMsgId: result.inbox.msgId,
    })
    return plan.reasons.length === 0
      ? { action: 'task-created', taskId: task.id }
      : { action: 'task-created', taskId: task.id, note: `risk-escalated:${plan.reasons.join(',')}` }
  }

  function queue(result: IngestResult, taskId: string): ForegroundOutcome {
    const input = tasks.enqueueInput({ taskId, inboxId: result.inbox.id })
    return { action: 'input-queued', taskId, inputId: input.id }
  }

  async function degrade(
    input: ForegroundInput,
    threadId: string,
    reason: string,
  ): Promise<ForegroundOutcome> {
    const note = `orchestrator-fallback: ${reason}`
    logger?.warn?.(note)
    if (options.fallback === undefined) {
      // No downgrade path configured: fail loudly instead of dropping the message.
      throw new Error(note)
    }
    const outcome = await options.fallback(input)
    return { ...outcome, note }
  }

  return async ({ result, text, history }) => {
    if (result.target.kind !== 'orchestrator') {
      return { action: 'none', reason: `target:${result.target.kind}` }
    }
    if (result.duplicate) return { action: 'none', reason: 'duplicate' }
    const thread = result.thread
    if (thread === null) return { action: 'none', reason: 'no-thread' }

    const trimmed = text === null ? '' : text.trim()
    if (trimmed === '') {
      return { action: 'reply', text: NON_TEXT_REPLY, threadId: thread.id }
    }

    // Deterministic first hand (docs/17 principle 2): a read-only status
    // question is answered by a probe, not by a model and not by a task.
    const quick: QuickAnswer | null = await quickAnswer(trimmed, thread.id)
    if (quick !== null) {
      return {
        action: 'reply',
        text: quick.text,
        threadId: thread.id,
        note: `quick-answer:${quick.kind}`,
      }
    }

    const live = liveTaskOn(tasks, thread.id, liveStatuses)
    const nowAt = clock()
    // 本轮只读一次：prompt 里的序号与取消时用的是同一份列表。
    const pendingReminders = reminders === null ? [] : reminders.listPending(thread.id, 8)
    const prompt = buildDecisionPrompt({
      text: trimmed,
      projectName: result.project?.name ?? null,
      liveTask: live,
      ...history === undefined ? {} : { history },
      now: nowAt,
      remindersEnabled: reminders !== null,
      reminders: pendingReminders.map((item, index) => ({
        index: index + 1,
        when: item.when,
        text: item.text,
        repeatLabel: item.repeatLabel,
      })),
    })

    let decision: Decision
    try {
      const raw = await decide(prompt, thread.id)
      const parsed = parseDecision(raw, {
        liveTask: live !== null,
        now: nowAt,
        remindersEnabled: reminders !== null,
        ...options.maxReplyChars === undefined ? {} : { maxReplyChars: options.maxReplyChars },
        ...options.maxIntentChars === undefined ? {} : { maxIntentChars: options.maxIntentChars },
      })
      if (!parsed.ok) return await degrade({ result, text, ...history === undefined ? {} : { history } }, thread.id, parsed.reason)
      decision = parsed.decision
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return await degrade({ result, text, ...history === undefined ? {} : { history } }, thread.id, `decision-failed: ${message}`)
    }

    if (decision.action === 'reply') {
      return { action: 'reply', text: decision.text, threadId: thread.id }
    }

    if (decision.action === 'queue') {
      // Validation already required a live task; re-check because the caller
      // may have closed it between the decision and now.
      if (live === null) return await degrade({ result, text }, thread.id, 'queue-without-task')
      return queue(result, live.id)
    }

    // Slice AT (J5): 提醒只是"登记一个未来的通知"，不建任务、不执行外部动作。
    if (decision.action === 'remind') {
      if (reminders === null) {
        return { action: 'reply', text: '提醒功能暂不可用。', threadId: thread.id, note: 'reminder-unavailable' }
      }
      try {
        const created = reminders.create({
          threadId: thread.id,
          text: decision.text,
          dueAt: decision.at,
          repeat: decision.repeat,
          sourceMsgId: result.inbox.msgId,
        })
        return {
          action: 'reminder-created',
          reminderId: created.id,
          text: created.text,
          dueAt: created.dueAt,
          repeat: created.repeat,
          when: created.when,
          repeatLabel: created.repeatLabel,
          threadId: thread.id,
        }
      } catch (error) {
        logger?.warn?.(`reminder create failed: ${error instanceof Error ? error.message : String(error)}`)
        return { action: 'reply', text: '设提醒失败，请稍后再试。', threadId: thread.id, note: 'reminder-failed' }
      }
    }

    if (decision.action === 'reminders') {
      return { action: 'reminder-list', items: [...pendingReminders], threadId: thread.id }
    }

    if (decision.action === 'cancel_remind') {
      const target = pendingReminders[decision.index - 1]
      if (reminders === null || target === undefined) {
        return {
          action: 'reply',
          text: `没有第 ${decision.index} 条待触发的提醒。`,
          threadId: thread.id,
          note: 'reminder-missing',
        }
      }
      const cancelled = reminders.cancel(target.id)
      if (cancelled === null) {
        return { action: 'reply', text: '这条提醒已不存在或已被取消。', threadId: thread.id, note: 'reminder-gone' }
      }
      return {
        action: 'reminder-cancelled',
        reminderId: cancelled.id,
        text: cancelled.text,
        when: cancelled.when,
        threadId: thread.id,
      }
    }

    // A second task on the same thread would fight the live owner slot (#9), so
    // a work request while something is live is delivered as an input instead.
    if (live !== null) return queue(result, live.id)
    return createTask(result, thread.id, decision.intent, decision.risk)
  }
}
