/**
 * Composition root (slice C). This is the only place that knows every module.
 *
 * It adds no business rules: ① decides routing/triage, the foreground decides
 * what a turn is, ⑤ owns the task lifecycle, ③/⑥/⑦ are reached only through
 * the ports from `ports.ts`. The host owns three seams and nothing else:
 *
 * - **foreground dispatch**: an `orchestrator` target becomes a foreground turn
 *   (#11: the front stage never executes, it only creates / queues work);
 * - **receipt closure**: ⑤'s pending receipts become ① outbox rows, and a
 *   delivered receipt also becomes an `anchor` subscription so replying to the
 *   bot's message lands back on the same task (#10);
 * - **lifecycle**: worker loop + outbox pump, started and stopped together.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import {
  RECEIPT_TOPIC,
  createGatewayStore,
  createOutboxDispatcher,
  createReceiptRelay,
  createTaskProgressRelay,
  ingestInbound,
  redactedText,
  type DispatchReport,
  type GatewayStore,
  type IngestInboundInput,
  type IngestResult,
  type Json,
  type OutboxDispatcher,
  type OutboxItem,
  type OutboxTransport,
  type ProjectLookupPort,
  type ReceiptRelayReport,
  type RouteAction,
  type RunningTaskSnapshot,
  type SpillPort,
  type TaskProgressReport,
} from '@dsh-wfxm/gateway'
import type { ApprovalLevel, ApprovalStore, GrantStore } from '@dsh-wfxm/governance'
import { nextDueAt as advanceReminder, type ReminderStore } from '@dsh-wfxm/reminder'
import {
  createTaskStore,
  createTaskWorker,
  type CheckpointRollbackPort,
  type SnapshotPort,
  type TaskExecutor,
  type TaskRunReport,
  type TaskStore,
  type TaskWorker,
  type VerifyContext,
} from '@dsh-wfxm/tasks'
import { createRuleForeground, type ForegroundHandler, type ForegroundOutcome } from './foreground.js'
import { createHostPorts, type HostPorts } from './ports.js'

/** How a degraded foreground turn is recorded in `route_decisions`. */
const TURN_ROUTE_ACTION: Record<ForegroundOutcome['action'], RouteAction> = {
  'task-created': 'accept',
  'input-queued': 'attach',
  reply: 'answer',
  // Slice AT (J5): 建提醒/取消提醒都算"接受了这条请求"，列表是回答。
  'reminder-created': 'accept',
  'reminder-list': 'answer',
  'reminder-cancelled': 'accept',
  none: 'ignore',
}

export interface HostIngestResult {
  result: IngestResult
  /** Set when this turn reached the foreground (`orchestrator` target only). */
  foreground: ForegroundOutcome | null
  error: 'foreground-unavailable' | null
}

export interface HostPumpReport {
  /** Pending approvals that ran past `expires_at` during this tick. */
  expired: number
  /**
   * Slice AR: `waiting_input` tasks whose question was enqueued in this tick.
   * Deduplicated by the request event's seq, so a restart never asks twice.
   */
  inputRequests: number
  /** Slice AT (J5): 本轮到点并入队的提醒数。 */
  reminders: number
  receipts: ReceiptRelayReport
  /** Slice R: null when progress notices are disabled (or routing-only host). */
  progress: TaskProgressReport | null
  /** Null when no transport was injected (routing-only host). */
  dispatch: DispatchReport | null
}

export interface HostProgressOptions {
  /** Ascending ms milestones since `started_at`; defaults to 2 / 10 minutes. */
  milestonesMs?: readonly number[]
  /** Silence before the "maybe stuck" notice; null or <= 0 disables it. */
  stallMs?: number | null
  /**
   * B3 v2: kill the stalled child and pause the row after the notice is queued.
   * Off by default; `DSH_WFXM_WATCHDOG_PAUSE` turns it on in production.
   */
  pauseOnStall?: boolean
  /** Max running tasks scanned per pump; defaults to 50. */
  limit?: number
}

export interface HostWorkerOptions {
  owner?: string
  leaseMs?: number
  heartbeatMs?: number
  backoffMs?: readonly number[]
  intervalMs?: number
  verify?: VerifyContext
  /** B4-b Phase 3: lease `task.plan.resources` before execution. */
  resourceLocks?: boolean
  resourceTtlSec?: number
  resourceRetryMs?: number
}

export interface HostDispatcherOptions {
  owner?: string
  leaseMs?: number
  limit?: number
}

/** Slice AS: produced files ride their own topic into the task's thread. */
export const TASK_ARTIFACT_TOPIC = 'task.artifact'
/** Slice AS: receipts longer than this become a Markdown attachment. */
export const DEFAULT_SPILL_CHARS = 600

/** Delivered as `msg_type: image`; everything else goes as a file. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/** Outbox topics the host owns for the approval loop (docs/14 §六). */
export const APPROVAL_CARD_TOPIC = 'approval.card'
export const APPROVAL_UPDATE_TOPIC = 'approval.update'
/** Slice L: the read-only "details" card and R3's second-confirmation card. */
export const APPROVAL_DETAIL_TOPIC = 'approval.detail'
export const APPROVAL_CONFIRM_TOPIC = 'approval.confirm'

export interface RequestApprovalInput {
  level: ApprovalLevel
  summary: string
  /** What the decision touches; rendered on the card (docs/14 §五). */
  impact?: Record<string, unknown>
  /** Thread the card is posted into — the card must be addressable. */
  threadId: string
  chatId?: string | null
  taskId?: string
  correlationId?: string
  ttlMs?: number
  /** Channel instance carried in the button value (`channel_id`). */
  channelId?: string | null
}

export interface RequestApprovalResult {
  approvalId: string
  expiresAt: string
  outboxId: string
}

export interface WfxmHostOptions {
  /** Same `ops.sqlite` for ① and ⑤ (`schema_migrations` keeps them apart). */
  dbPath: string
  /** The execute seam; `createDshExecutor(...)` in production, a stub in tests. */
  executor: TaskExecutor
  /** Absent = routing only (no outbound delivery). */
  transport?: OutboxTransport | null
  /** Defaults to the deterministic rule foreground. */
  foreground?: ForegroundHandler | null
  /**
   * Build the foreground from the host's own stores. Needed by front desks that
   * read ⑤ (e.g. the orchestrator's live-task context) — the stores only exist
   * inside this factory, so a pre-built handler could not reach them.
   */
  foregroundFactory?: ((stores: { gateway: GatewayStore; tasks: TaskStore }) => ForegroundHandler) | null
  snapshot?: SnapshotPort | null
  grants?: GrantStore | null
  /** ③'s approval store; without it approval cards cannot be issued or answered. */
  approvals?: ApprovalStore | null
  /** Slice AT (J5): reminders store; absent means the front desk cannot set reminders. */
  reminders?: ReminderStore | null
  project?: ProjectLookupPort | null
  rollback?: CheckpointRollbackPort | null
  worker?: HostWorkerOptions
  dispatcher?: HostDispatcherOptions
  /**
   * Slice AS (A4): write over-long receipts into `dir` and deliver them as a
   * file. Absent/null keeps inline text only.
   */
  spill?: { dir: string; thresholdChars?: number } | null
  /** Slice R: long-task notices; `null` disables them, absent uses defaults. */
  progress?: HostProgressOptions | null
  /** Outbox pump cadence in `start()`; defaults to 1s. */
  pumpIntervalMs?: number
  /** Slice AO.1: identical-message dedupe window; `0` disables, defaults to 60s. */
  duplicateWindowMs?: number
  now?: () => Date
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
    error?: (message: string) => void
  } | null
}

export interface WfxmHost {
  readonly stores: { gateway: GatewayStore; tasks: TaskStore }
  readonly ports: HostPorts
  readonly dispatcher: OutboxDispatcher | null
  readonly worker: TaskWorker
  ingest(input: IngestInboundInput): Promise<HostIngestResult>
  /** Issue an approval and post its card into `threadId` (docs/14 §六). */
  requestApproval(input: RequestApprovalInput): RequestApprovalResult
  pump(): Promise<HostPumpReport>
  runWorkerOnce(): Promise<TaskRunReport>
  start(): void
  stop(): void
  close(): void
}

function textOf(content: Json): string | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null
  const value = (content as Record<string, unknown>).text
  return typeof value === 'string' ? value : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read a string field off a JSON object payload; anything else is `null`. */
function payloadString(payload: Json, key: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const value = (payload as Record<string, Json>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

export function createWfxmHost(options: WfxmHostOptions): WfxmHost {
  const now = options.now ?? (() => new Date())
  const logger = options.logger ?? null

  const gateway = createGatewayStore(options.dbPath)
  const tasks = createTaskStore(options.dbPath)
  const approvals = options.approvals ?? null
  const reminders = options.reminders ?? null

  const ports = createHostPorts({
    tasks,
    grants: options.grants ?? null,
    approvals,
    project: options.project ?? null,
    rollback: options.rollback ?? null,
    // Late-bound: the worker is constructed below, but cancel is only called
    // later, after this closure exists.
    cancelRunning: (taskId) => worker.cancel(taskId),
    now,
  })

  const foreground = options.foreground
    ?? options.foregroundFactory?.({ gateway, tasks })
    ?? createRuleForeground({ tasks })

  // Slice AS: spill to `<dir>/receipt-<id>.md`, redacted before it hits disk
  // (H7 — receipts may quote logs, and the file is meant to be opened/shared).
  const spillOptions = options.spill ?? null
  const spillPort: SpillPort | null = spillOptions === null
    ? null
    : {
        write({ name, content }) {
          mkdirSync(spillOptions.dir, { recursive: true })
          const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
          const path = join(spillOptions.dir, safe)
          writeFileSync(path, redactedText(content), { encoding: 'utf8', mode: 0o640 })
          return { path, name: safe }
        },
      }

  const receiptRelay = createReceiptRelay({
    store: gateway,
    receipts: ports.receipts,
    spill: spillPort,
    spillThresholdChars: spillOptions?.thresholdChars ?? DEFAULT_SPILL_CHARS,
  })

  // #10: a delivered receipt becomes an anchor, so replying to the bot's
  // message resolves back to this task instead of starting a new one.
  function onSent(item: OutboxItem, externalMsgId: string): void {
    const receiptId = receiptRelay.receiptIdOf(item)
    if (receiptId !== null) receiptRelay.settle(receiptId, externalMsgId)
    if (item.topic === RECEIPT_TOPIC && item.taskId !== null && item.threadId !== null) {
      tasks.bindThread({
        taskId: item.taskId,
        threadId: item.threadId,
        relation: 'anchor',
        anchorMsgId: externalMsgId,
      })
    }
    // The card is a view (AR10): remember where it is so the decision can
    // patch it later instead of leaving a stale "please confirm" on screen.
    if (item.topic === APPROVAL_CARD_TOPIC && approvals !== null) {
      const approvalId = payloadString(item.payload, 'approvalId')
      if (approvalId !== null) approvals.setExternalMsgId(approvalId, externalMsgId)
    }
  }

  const transport = options.transport ?? null
  // Slice Q: retries/failures reach the same host log as the pump itself; a
  // host logger without `error` degrades to `warn` instead of dropping them.
  const dispatcherLogger = logger === null
    ? null
    : {
        warn: (message: string) => logger.warn?.(message),
        error: (message: string) => (logger.error ?? logger.warn)?.(message),
      }
  const dispatcher = transport === null
    ? null
    : createOutboxDispatcher({
      store: gateway,
      transport,
      now,
      ...options.dispatcher ?? {},
      ...dispatcherLogger === null ? {} : { logger: dispatcherLogger },
      onSent,
    })

  const workerOptions = options.worker ?? {}
  const worker = createTaskWorker({
    store: tasks,
    execute: options.executor,
    snapshot: options.snapshot ?? null,
    now,
    ...workerOptions.owner === undefined ? {} : { owner: workerOptions.owner },
    ...workerOptions.leaseMs === undefined ? {} : { leaseMs: workerOptions.leaseMs },
    ...workerOptions.heartbeatMs === undefined ? {} : { heartbeatMs: workerOptions.heartbeatMs },
    ...workerOptions.backoffMs === undefined ? {} : { backoffMs: workerOptions.backoffMs },
    ...workerOptions.resourceLocks === undefined ? {} : { resourceLocks: workerOptions.resourceLocks },
    ...workerOptions.resourceTtlSec === undefined ? {} : { resourceTtlSec: workerOptions.resourceTtlSec },
    ...workerOptions.resourceRetryMs === undefined ? {} : { resourceRetryMs: workerOptions.resourceRetryMs },
    ...workerOptions.verify === undefined ? {} : { verify: workerOptions.verify },
    onArtifacts: sendArtifacts,
    onError: (error) => logger?.warn?.(`worker error: ${messageOf(error)}`),
  })

  const progressOptions = options.progress ?? {}
  const progressRelay = options.progress === null
    ? null
    : createTaskProgressRelay({
      store: gateway,
      now,
      ...progressOptions.milestonesMs === undefined ? {} : { milestonesMs: progressOptions.milestonesMs },
      ...progressOptions.stallMs === undefined ? {} : { stallMs: progressOptions.stallMs },
      ...progressOptions.pauseOnStall === undefined ? {} : { pauseOnStall: progressOptions.pauseOnStall },
      ...progressOptions.limit === undefined ? {} : { limit: progressOptions.limit },
      tasks: {
        listRunningTasks(limit?: number): RunningTaskSnapshot[] {
          return tasks
            .listTasks({ status: 'running', ...limit === undefined ? {} : { limit } })
            .map((task) => {
              const last = tasks.latestEvent(task.id)
              const threadIds = tasks
                .listTaskThreads({ taskId: task.id, liveOnly: true })
                .slice()
                .sort((a, b) => (a.relation === b.relation
                  ? b.createdAt.localeCompare(a.createdAt)
                  : a.relation === 'default_owner' ? -1 : 1))
                .map((thread) => thread.threadId)
              return {
                taskId: task.id,
                taskRef: task.taskRef,
                intent: task.intent,
                startedAt: task.startedAt,
                lastEventAt: last?.createdAt ?? null,
                lastEventSeq: last?.seq ?? null,
                lastEventType: last?.type ?? null,
                threadIds,
              }
            })
        },
      },
    })

  /**
   * The thread a task's output should land on: `default_owner` first, then the
   * newest anchor, skipping threads ① cannot address.
   */
  function liveThreadId(taskId: string): string | null {
    return tasks
      .listTaskThreads({ taskId, liveOnly: true })
      .slice()
      .sort((a, b) => (a.relation === b.relation
        ? b.createdAt.localeCompare(a.createdAt)
        : a.relation === 'default_owner' ? -1 : 1))
      .map((thread) => thread.threadId)
      .find((id) => gateway.getThread(id) !== null) ?? null
  }

  /**
   * Slice AS (A4): deliver files the attempt produced. The dedupe key is the
   * real path, so a retried settle or a crash-restart cannot queue a file
   * twice; no addressable thread means the file stays on disk (never guessed).
   */
  function sendArtifacts(input: {
    taskId: string
    attachments: readonly { path: string; name: string }[]
  }): void {
    const task = tasks.getTask(input.taskId)
    if (task === null) return
    const threadId = liveThreadId(task.id)
    if (threadId === null) return
    const ref = task.taskRef ?? task.id.slice(0, 8)
    for (const file of input.attachments) {
      const dedupeKey = `task-artifact:${task.id}:${file.path}`
      if (gateway.findOutboxByDedupe(dedupeKey) !== null) continue
      gateway.enqueueOutbox({
        topic: TASK_ARTIFACT_TOPIC,
        payload: {
          kind: IMAGE_EXTENSIONS.has(extname(file.name).toLowerCase()) ? 'image' : 'file',
          filePath: file.path,
          fileName: file.name,
          text: `任务 ${ref} 的附件：${file.name}`,
        },
        taskId: task.id,
        threadId,
        dedupeKey,
      })
    }
  }

  let pumpTimer: ReturnType<typeof setInterval> | null = null
  let pumping = false

  function stop(): void {
    worker.stop()
    if (pumpTimer !== null) clearInterval(pumpTimer)
    pumpTimer = null
  }

  /**
   * Release tasks whose approval ran past its TTL. ③ only expires lazily on a
   * click, so without this sweep a never-clicked card leaves the task parked in
   * `waiting_approval` forever and the thread can no longer start anything new.
   */
  function expireOverdueApprovals(): number {
    if (approvals === null) return 0
    let expired = 0
    for (const item of approvals.expireOverdue(now())) {
      expired += 1
      if (item.taskId !== null) {
        try {
          tasks.transition(item.taskId, {
            to: 'failed',
            reason: 'approval-expired',
            summary: 'approval expired before the owner answered; nothing ran',
          })
        } catch {
          // The task already moved on (executed / cancelled); nothing to release.
        }
      }
      const cardId = approvals.get(item.approvalId)?.externalMsgId ?? null
      const threadId = item.taskId === null
        ? null
        : tasks.listTaskThreads({ taskId: item.taskId })[0]?.threadId ?? null
      gateway.enqueueOutbox({
        topic: APPROVAL_UPDATE_TOPIC,
        payload: {
          kind: 'approval_result',
          approvalId: item.approvalId,
          decision: 'expired',
          ...cardId === null ? {} : { externalMsgId: cardId },
          text: '审批已过期，任务已结束',
        },
        threadId,
        dedupeKey: `approval-update:${item.approvalId}`,
      })
    }
    return expired
  }

  /**
   * B3 v2: a stalled task is aborted first, then parked in `paused`. The order
   * matters — `worker.cancel` only signals the child, so the row must not lie
   * about being paused while the executor still runs. Either write can lose a
   * race with completion/cancellation, so a failure is logged and skipped
   * (the notice is already queued and its dedupe key prevents a retry storm).
   */
  function pauseStalled(stalled: TaskProgressReport['stalled']): void {
    for (const item of stalled) {
      try {
        worker.cancel(item.taskId)
        tasks.transition(item.taskId, {
          to: 'paused',
          reason: 'watchdog:stalled',
          summary: `stalled: no task event for ${Math.round(item.silentMs / 60_000)}min`,
        })
      } catch (error) {
        logger?.warn?.(`watchdog pause skipped for ${item.taskId}: ${messageOf(error)}`)
      }
    }
  }

  /**
   * Slice AR: a parked task asked a question. The question lives in the
   * `task.input_requested` event, so this scan is restart-safe: the outbox
   * dedupe key pins it to that event's seq.
   */
  function askForInput(): number {
    let asked = 0
    for (const task of tasks.listTasks({ status: 'waiting_input', limit: 50 })) {
      const last = tasks.latestEvent(task.id)
      if (last === null || last.type !== 'task.input_requested') continue
      const question = payloadString(last.payload ?? null, 'question')
      if (question === null) continue
      const threadId = liveThreadId(task.id)
      // No addressable thread: never guess a chat; the owner can still answer
      // from the thread that created the task once it has one.
      if (threadId === null) continue
      const dedupeKey = `task-input-request:${task.id}:${last.seq}`
      if (gateway.findOutboxByDedupe(dedupeKey) !== null) continue
      const ref = task.taskRef ?? task.id.slice(0, 8)
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text: `任务 ${ref} 需要补充信息：${question}\n直接回复本条消息即可继续。` },
        threadId,
        dedupeKey,
      })
      asked += 1
    }
    return asked
  }

  /**
   * Slice AT (J5): 到点提醒进 outbox。先入队（幂等键固定）再推进状态：
   * 入队成功而状态写入失败时，下一轮命中去重键，不会重复发；反之（先改状态）
   * 一旦崩溃就永久丢提醒。
   *
   * 目标线程不可寻址时不猜 chat：直接结束并留 warn（不反复堆积）。
   */
  function fireDueReminders(): number {
    if (reminders === null) return 0
    const at = now()
    let fired = 0
    for (const item of reminders.listDue(at, 50)) {
      if (gateway.getThread(item.threadId) === null) {
        reminders.markFired(item.id, { nextDueAt: null, now: at })
        logger?.warn?.(`reminder ${item.id}: thread ${item.threadId} is gone; dropped`)
        continue
      }
      try {
        gateway.enqueueOutbox({
          topic: 'say',
          payload: { text: `提醒：${item.text}` },
          threadId: item.threadId,
          dedupeKey: `reminder:${item.id}:${item.dueAt}`,
        })
      } catch (error) {
        logger?.warn?.(`reminder ${item.id}: enqueue failed: ${messageOf(error)}`)
        continue
      }
      reminders.markFired(item.id, {
        nextDueAt: advanceReminder(item.dueAt, item.repeat, at),
        now: at,
      })
      fired += 1
    }
    return fired
  }

  async function pump(): Promise<HostPumpReport> {
    // Settle expired approvals first: a task released here produces its receipt
    // in this same tick instead of the next one.
    const expired = expireOverdueApprovals()
    const inputRequests = askForInput()
    // Slice AT: 到期提醒在派发前入队，同一轮就能发出去。
    const remindersFired = fireDueReminders()
    const receipts = receiptRelay.pump()
    // Slice R: enqueue progress notices before the dispatcher claims, so a due
    // reminder goes out in this same tick instead of waiting for the next one.
    const progress = progressRelay === null ? null : progressRelay.pump()
    // B3 v2: pause only after the notice is safely queued, so the owner always
    // learns why the task stopped.
    if (progress !== null) pauseStalled(progress.stalled)
    const dispatch = dispatcher === null ? null : await dispatcher.runOnce()
    return { expired, inputRequests, reminders: remindersFired, receipts, progress, dispatch }
  }

  /**
   * Slice AO: a supplement to a live task is applied, not parked. Steering a
   * running attempt re-queues it with a fresh budget and aborts the child; the
   * ack tells the user which of the three things just happened.
   */
  function applySupplement(input: {
    taskId: string
    inputId: string
    text: string
    threadId: string | null
    replyToMsgId: string | null
  }): void {
    const task = tasks.getTask(input.taskId)
    if (task === null) return
    const ref = task.taskRef ?? input.taskId.slice(0, 8)
    try {
      const steered = tasks.steerTask({
        taskId: task.id,
        inputId: input.inputId,
        text: input.text,
      })
      if (steered.applied === 'rerun') worker.cancel(task.id)
      const text = steered.applied === 'rerun'
        ? `已按补充指令重新开始（${ref}）。`
        : steered.applied === 'merged'
          ? `已并入任务 ${ref}，稍后按新内容执行。`
          : `已记录补充指令（${ref}），任务恢复后生效。`
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text },
        threadId: input.threadId,
        replyToMsgId: input.replyToMsgId,
        dedupeKey: `steer:${input.inputId}`,
      })
    } catch (error) {
      logger?.warn?.(`steer failed: ${messageOf(error)}`)
    }
  }

  async function ingest(input: IngestInboundInput): Promise<HostIngestResult> {
    const result = await ingestInbound(
      {
        store: gateway,
        relay: ports.relay,
        control: ports.control,
        grantCheck: ports.grantCheck,
        wake: ports.wake,
        project: ports.project,
        approval: approvals === null ? null : ports.approvalAnswer,
        approvalDetails: approvals === null ? null : ports.approvalDetail,
        ...options.duplicateWindowMs === undefined
          ? {}
          : { duplicateWindowMs: options.duplicateWindowMs },
      },
      input,
    )

    // Read-only "details" click (Slice L): a separate card, never a decision.
    // Nothing here touches ③, so the pending approval and its nonce survive.
    if (result.details !== null && result.details !== undefined) {
      const detail = result.details.detail
      gateway.enqueueOutbox({
        topic: APPROVAL_DETAIL_TOPIC,
        payload: detail === undefined
          ? {
            kind: 'approval_detail',
            approvalId: result.details.approvalId,
            text: `审批 ${result.details.approvalId} 的详情不可用（${result.details.code}）`,
          }
          : {
            kind: 'approval_detail',
            ...detail as unknown as Record<string, Json>,
            text: `${detail.level} · ${detail.summary}（审批 ${detail.approvalId}）`,
          },
        threadId: result.thread?.id ?? null,
        replyToMsgId: result.inbox.replyToMsgId ?? null,
      })
    }

    // A settled approval must be mirrored on the card it came from (docs/14 §六).
    // A refused click (double click / expired) is already visible on the card, so
    // it is audited only — no second message.
    if (result.approval !== null && result.approval !== undefined
      && result.approval.ok && approvals !== null) {
      const cardId = approvals.get(result.approval.approvalId)?.externalMsgId ?? null
      const approved = result.approval.decision !== 'rejected'
      gateway.enqueueOutbox({
        topic: APPROVAL_UPDATE_TOPIC,
        payload: {
          kind: 'approval_result',
          approvalId: result.approval.approvalId,
          decision: approved ? 'approved' : 'rejected',
          ...cardId === null ? {} : { externalMsgId: cardId },
          text: approved ? '已批准，任务继续执行' : '已拒绝，任务已暂停',
        },
        threadId: result.thread?.id ?? null,
        replyToMsgId: result.inbox.replyToMsgId ?? null,
        dedupeKey: `approval-update:${result.approval.approvalId}`,
      })
    }

    // R3 first click (Slice L): ③ recorded who asked and kept the record pending.
    // Replace the original card with the explicit second-confirmation card; its
    // button carries the dedicated `confirm` decision, so a double click on
    // "approve" can never settle the approval.
    if (result.approval !== null && result.approval !== undefined
      && !result.approval.ok && result.approval.code === 'confirm-required') {
      const outcome = result.approval
      const record = approvals?.get(outcome.approvalId) ?? null
      const cardId = record?.externalMsgId ?? null
      const level = record?.level ?? 'R3'
      const summary = record?.summary ?? ''
      gateway.enqueueOutbox({
        topic: APPROVAL_CONFIRM_TOPIC,
        payload: {
          kind: 'approval_confirm',
          approvalId: outcome.approvalId,
          level,
          summary,
          nonce: outcome.nonce ?? '',
          ...record === null ? {} : { expiresAt: record.expiresAt },
          ...cardId === null ? {} : { externalMsgId: cardId },
          text: `这是 ${level} 操作，需要再次确认：${summary}`,
        },
        threadId: result.thread?.id ?? null,
        replyToMsgId: result.inbox.replyToMsgId ?? null,
      })
    }

    // A reply target must be a real channel message id; the dedup key (event id)
    // is not addressable and is rejected downstream (99992354). The channel
    // carries its message id in content (docs/14 §三).
    const external = result.inbox.content as { externalMsgId?: unknown } | null
    const replyToMsgId
      = typeof external?.externalMsgId === 'string' && external.externalMsgId !== ''
        ? external.externalMsgId
        : null

    if (result.target.kind !== 'orchestrator' || result.duplicate) {
      // An anchored message on a live task is routed by ① straight to ⑤; that
      // path used to end here with the input parked forever (Slice AO).
      if (result.target.kind === 'task' && !result.duplicate && result.relay?.enqueued === true
        && result.relay.inputId !== null) {
        applySupplement({
          taskId: result.target.taskId,
          // `inputId` is the `task_inputs` row; the inbox id would not resolve.
          inputId: result.relay.inputId,
          text: textOf(input.content) ?? '',
          threadId: result.thread?.id ?? null,
          replyToMsgId,
        })
      }
      return { result, foreground: null, error: null }
    }

    let turn: ForegroundOutcome
    try {
      const history = result.thread === null ? [] : gateway.threadHistory(result.thread.id, 12)
      turn = await foreground({
        result,
        text: textOf(input.content),
        ...history.length === 0 ? {} : { history },
      })
    } catch (error) {
      // AR13: a foreground that cannot decide is not a silent drop.
      const reason = `foreground failed: ${messageOf(error)}`
      gateway.updateInboxStatus(result.inbox.id, 'failed', 'foreground-unavailable')
      gateway.appendRouteDecision({
        triggerId: result.inbox.id,
        action: 'ignore',
        reason,
        threadId: result.thread?.id ?? null,
      })
      logger?.warn?.(reason)
      return { result, foreground: null, error: 'foreground-unavailable' }
    }

    // A turn with a note is recorded, not hidden (AR13): either the front desk
    // fell back to the rule path, or it answered locally without the model.
    if (turn.note !== undefined) {
      gateway.appendRouteDecision({
        triggerId: result.inbox.id,
        action: TURN_ROUTE_ACTION[turn.action],
        reason: turn.note,
        threadId: result.thread?.id ?? null,
      })
    }

    if (turn.action === 'reply') {
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text: turn.text },
        threadId: turn.threadId,
        replyToMsgId,
      })
    }

    // Instant ack: a long task says nothing until it finishes, which reads as a
    // dead bot. One `say` per task, idempotent on the task id.
    if (turn.action === 'task-created') {
      const task = tasks.getTask(turn.taskId)
      const ref = task?.taskRef ?? turn.taskId.slice(0, 8)
      let ack = `收到，任务 ${ref} 已开始处理，完成后回执。`

      // Slice I: R2/R3 must be approved before the worker can claim them.
      // Nothing awaits between creation and the hold, so the worker timer
      // cannot slip in and lease the task first.
      if (task !== null && (task.riskLevel === 'R2' || task.riskLevel === 'R3')) {
        const level: ApprovalLevel = task.riskLevel
        const threadId = result.thread?.id ?? null
        if (approvals === null || threadId === null) {
          // AR13: if nobody can approve it, it must not run.
          const why = approvals === null ? '未挂载审批模块' : '没有可发卡的线程'
          tasks.transition(task.id, {
            to: 'cancelled',
            summary: `${why}，${level} 任务拒绝执行`,
            reason: approvals === null ? 'approval-unavailable' : 'no-thread-for-approval',
          })
          ack = `任务 ${ref} 属于 ${level} 风险，但${why}，已按策略拒绝执行。`
        } else {
          try {
            tasks.holdForApproval({ taskId: task.id, reason: `risk:${level}` })
          } catch (error) {
            logger?.warn?.(`approval gate: ${messageOf(error)}`)
          }
          if (tasks.getTask(task.id)?.status === 'waiting_approval') {
            requestApproval({
              level,
              summary: task.intent,
              impact: { taskId: task.id, taskRef: task.taskRef },
              threadId,
              chatId: result.thread?.chatId ?? null,
              channelId: result.thread?.channelId ?? null,
              taskId: task.id,
              correlationId: task.correlationId,
            })
            ack = `收到，任务 ${ref} 属于 ${level} 风险，已发确认卡片，批准后开始执行。`
          } else {
            ack = `任务 ${ref} 在确认前已进入执行，未能挂起，请检查。`
          }
        }
      }

      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text: ack },
        threadId: result.thread?.id ?? null,
        replyToMsgId,
        dedupeKey: `ack:${turn.taskId}`,
      })
    }

    if (turn.action === 'input-queued') {
      applySupplement({
        taskId: turn.taskId,
        inputId: turn.inputId,
        text: textOf(input.content) ?? '',
        threadId: result.thread?.id ?? null,
        replyToMsgId,
      })
    }

    // Slice AT (J5): 确认文案由宿主生成（时间已格式化），模型只负责决定。
    if (turn.action === 'reminder-created') {
      gateway.enqueueOutbox({
        topic: 'say',
        payload: {
          text: `已设提醒：${turn.when}「${turn.text}」${turn.repeatLabel}。到点会在这里提醒你。`,
        },
        threadId: turn.threadId,
        replyToMsgId,
        dedupeKey: `reminder-ack:${turn.reminderId}`,
      })
    }

    if (turn.action === 'reminder-list') {
      const lines = turn.items.map(
        (item, index) => `${index + 1}. ${item.when} ${item.text}${item.repeatLabel}`,
      )
      gateway.enqueueOutbox({
        topic: 'say',
        payload: {
          text: lines.length === 0 ? '当前没有待触发的提醒。' : `当前提醒：\n${lines.join('\n')}`,
        },
        threadId: turn.threadId,
        replyToMsgId,
      })
    }

    if (turn.action === 'reminder-cancelled') {
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text: `已取消提醒：${turn.when}「${turn.text}」。` },
        threadId: turn.threadId,
        replyToMsgId,
        dedupeKey: `reminder-cancel:${turn.reminderId}`,
      })
    }

    return { result, foreground: turn, error: null }
  }

  function requestApproval(input: RequestApprovalInput): RequestApprovalResult {
    if (approvals === null) throw new Error('approval-unavailable: no approval store mounted')
    const summary = input.summary.trim()
    if (summary === '') throw new Error('approval-invalid: summary is required')
    const channelId = input.channelId ?? null
    const chatId = input.chatId ?? null

    const ticket = approvals.create({
      correlationId: input.correlationId ?? input.taskId ?? input.threadId,
      level: input.level,
      summary,
      impact: input.impact ?? {},
      ...input.taskId === undefined ? {} : { taskId: input.taskId },
      ...channelId === null ? {} : { channelId },
      ...input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs },
    })

    // Payload is protocol-neutral (spec G1): the channel adapter renders it.
    const item = gateway.enqueueOutbox({
      topic: APPROVAL_CARD_TOPIC,
      payload: {
        kind: 'approval_card',
        approvalId: ticket.id,
        level: input.level,
        summary,
        impact: (input.impact ?? {}) as unknown as Json,
        expiresAt: ticket.expiresAt,
        nonce: ticket.nonce,
        ...channelId === null ? {} : { channelId },
        ...chatId === null ? {} : { chatId },
        text: `需要确认 ${input.level}：${summary}`,
      },
      threadId: input.threadId,
      dedupeKey: `approval-card:${ticket.id}`,
    })
    return { approvalId: ticket.id, expiresAt: ticket.expiresAt, outboxId: item.id }
  }

  return {
    stores: { gateway, tasks },
    ports,
    dispatcher,
    worker,

    ingest,
    requestApproval,
    pump,

    runWorkerOnce: () => worker.runOnce(),

    start() {
      worker.start({ intervalMs: workerOptions.intervalMs ?? 1_000 })
      if (pumpTimer !== null) return
      const intervalMs = options.pumpIntervalMs ?? 1_000
      pumpTimer = setInterval(() => {
        if (pumping) return
        pumping = true
        pump()
          .catch((error) => logger?.warn?.(`pump error: ${messageOf(error)}`))
          .finally(() => {
            pumping = false
          })
      }, intervalMs)
      pumpTimer.unref?.()
    },

    stop,

    close() {
      stop()
      tasks.close()
      gateway.close()
    },
  }
}
