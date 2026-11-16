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
import { parseDecision, type Decision } from './decision.js'
import { buildDecisionPrompt } from './prompt.js'
import { createQuickAnswer, type QuickAnswer, type QuickChecks, type ResourceSnapshot } from './quick-answer.js'

export type ForegroundOutcome =
  | { action: 'task-created'; taskId: string; note?: string }
  | { action: 'input-queued'; taskId: string; inputId: string; note?: string }
  | { action: 'reply'; text: string; threadId: string; note?: string }
  | { action: 'none'; reason: string; note?: string }

export interface ForegroundInput {
  result: IngestResult
  /** Plain text body, already extracted from the channel payload. */
  text: string | null
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
  decide: (prompt: string) => Promise<string>
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

  return async ({ result, text }) => {
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
    const prompt = buildDecisionPrompt({
      text: trimmed,
      projectName: result.project?.name ?? null,
      liveTask: live,
    })

    let decision: Decision
    try {
      const raw = await decide(prompt)
      const parsed = parseDecision(raw, {
        liveTask: live !== null,
        ...options.maxReplyChars === undefined ? {} : { maxReplyChars: options.maxReplyChars },
        ...options.maxIntentChars === undefined ? {} : { maxIntentChars: options.maxIntentChars },
      })
      if (!parsed.ok) return await degrade({ result, text }, thread.id, parsed.reason)
      decision = parsed.decision
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return await degrade({ result, text }, thread.id, `decision-failed: ${message}`)
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

    // A second task on the same thread would fight the live owner slot (#9), so
    // a work request while something is live is delivered as an input instead.
    if (live !== null) return queue(result, live.id)
    return createTask(result, thread.id, decision.intent, decision.risk)
  }
}
