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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

import {
  RECEIPT_TOPIC,
  createGatewayStore,
  createOutboxDispatcher,
  createReceiptRelay,
  createTaskProgressRelay,
  ingestInbound,
  parseEvalCommand,
  parseSuggestionCommand,
  redactedText,
  type DispatchReport,
  type DiagCommand,
  type EvalCommand,
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
  type SuggestionCommand,
  type TaskControlReport,
  type TaskProgressReport,
  type WakeReport,
  type AdmissionPort,
} from '@dsh-wfxm/gateway'
import type { ApprovalLevel, ApprovalStore, GrantStore } from '@dsh-wfxm/governance'
import {
  EvalTimeoutError,
  createTrajectoryCandidate,
  formatEvalCandidateUnavailable,
  formatEvalDbFindings,
  formatEvalEngineMissing,
  formatEvalFindingAlready,
  formatEvalFindingIgnored,
  formatEvalFindingMissing,
  formatEvalFixCreated,
  formatEvalFixExists,
  formatEvalFixNotNeeded,
  formatEvalFlagNeedsQuote,
  formatEvalFlagRecorded,
  formatEvalFromTaskCreated,
  formatEvalFromTaskDisabled,
  formatEvalFromTaskExists,
  formatEvalFromTaskMissing,
  formatEvalFromTaskNoTrace,
  formatEvalFromTaskNotFailed,
  formatEvalPromoted,
  formatEvalRefreshDone,
  formatEvalRefreshDraftMissing,
  formatEvalRefreshFixStatus,
  formatEvalRefreshNoFix,
  formatEvalRefreshNotPromoted,
  formatEvalRefreshToolsMissing,
  formatEvalRunFailed,
  formatEvalRunFinished,
  formatEvalRunRealHint,
  formatEvalRunReused,
  formatEvalRunStarted,
  type CandidatePromoter,
  type EvalL2Runner,
  type EvalStore,
} from '@dsh-wfxm/eval'
import { createTaskChangePort, type ChangeStore } from '@dsh-wfxm/changes'
import {
  DEFAULT_DIGEST_TIME_ZONE,
  buildMailDigest,
  digestDue,
  localDayMinutes,
  readDigestState,
  readMailAccount,
  renderDigest,
  searchMail,
  writeDigestState,
} from '@dsh-wfxm/mail'
import { nextDueAt as advanceReminder, type ReminderStore } from '@dsh-wfxm/reminder'
import {
  createTaskStore,
  createTaskWorker,
  planTaskRisk,
  type CheckpointRollbackPort,
  type LifecycleAudit,
  type SnapshotPort,
  type Task,
  type TaskExecutor,
  type TaskRunReport,
  type TaskStore,
  type TaskWorker,
  type VerifyContext,
} from '@dsh-wfxm/tasks'
import { createRuleForeground, type ForegroundHandler, type ForegroundOutcome } from './foreground.js'
import {
  enrichFailureReceipt,
  formatDiagReport,
  formatRepeatAlert,
  formatStatusReport,
  formatStuckAlert,
  groupErrorCodes,
  isStuck,
  taskRefOf,
  type DiagTelemetryReader,
  type StuckTask,
} from './diagnostics.js'
import { createHostPorts, type HostPorts } from './ports.js'
import {
  defaultEvalSnapshotPath,
  formatEvalFindings,
  formatEvalHelp,
  formatEvalStatus,
  formatEvalUnsupported,
  loadEvalSnapshot,
  type EvalSnapshotLoad,
} from './eval.js'

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

/** L4: user-facing words for ⑤'s lifecycle statuses (never raw enums). */
const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting_input: '等待补充输入',
  waiting_approval: '等待审批',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** L4: the chat word for a control action, so "不能cancel" never leaks. */
const CONTROL_ACTION_TEXT: Record<string, string> = {
  cancel: '停止',
  pause: '暂停',
  resume: '继续',
  rollback: '回滚',
}

/** L4: the word the owner typed, reused in "请带上任务号" examples. */
const CONTROL_COMMAND_TEXT: Record<string, string> = {
  stop: '停止',
  pause: '暂停',
  resume: '继续',
  rollback: '回滚',
  status: '状态',
}

function statusLabel(status: string | null | undefined): string {
  if (typeof status !== 'string' || status === '') return '未知状态'
  return STATUS_TEXT[status] ?? status
}

/** One actionable line after a status report; empty when there is nothing to do. */
function statusHint(status: string | null | undefined, ref: string): string {
  switch (status) {
    case 'paused': return `回复「继续 ${ref}」恢复。`
    case 'running':
    case 'queued': return `回复「停止 ${ref}」可取消。`
    case 'failed': return '如需重试，请补充要求后重新发送。'
    case 'succeeded': return '任务已完成；回复本条消息可继续追问。'
    default: return ''
  }
}

/**
 * L4: compose the chat reply for an anchored control command. ① decides what
 * happened (`executed` / `skipped`); this only says it in the owner's words,
 * including failures, so a rejected command is never silent.
 */
function controlAck(input: {
  command: string
  report: TaskControlReport
  taskRef: string | null
  status: string | null
}): string {
  const commandWord = CONTROL_COMMAND_TEXT[input.command] ?? input.command
  const actionLabel = input.report.action === null
    ? commandWord
    : CONTROL_ACTION_TEXT[input.report.action] ?? commandWord
  if (input.report.skipped === 'no-task') {
    return `没有找到要${actionLabel}的任务：请带上任务号，例如「${commandWord} abc123」。`
  }
  if (input.report.skipped === 'no-port') return `控制通道不可用，${commandWord}命令未执行。`
  const ref = input.taskRef
  if (ref === null) {
    return `没有找到要${actionLabel}的任务：请带上任务号，例如「${commandWord} abc123」。`
  }
  const label = statusLabel(input.status)
  if (input.command === 'status' || input.report.skipped === 'status-only') {
    const hint = statusHint(input.status, ref)
    return hint === ''
      ? `任务 ${ref} 当前状态：${label}。`
      : `任务 ${ref} 当前状态：${label}。\n${hint}`
  }
  if (input.report.skipped === 'not-live') return `任务 ${ref} 当前为${label}，不能${actionLabel}。`
  if (!input.report.executed) return `任务 ${ref} 的${actionLabel}请求未被处理。`
  switch (input.report.action) {
    case 'cancel': return `已停止任务 ${ref}（${label}）。`
    case 'pause': return `已暂停任务 ${ref}；回复「继续 ${ref}」恢复。`
    case 'resume': return `已继续任务 ${ref}（${label}）。`
    case 'rollback': return `已回滚任务 ${ref}（${label}）。`
    default: return `已${actionLabel}任务 ${ref}（${label}）。`
  }
}

/** L4: a wake attempt is a decision about a task; it always gets an answer. */
function wakeAck(input: { wake: WakeReport; taskRef: string | null }): string {
  const ref = input.taskRef
  if (input.wake.woken) {
    const round = input.wake.round === null ? '' : `（第 ${input.wake.round} 轮）`
    return ref === null
      ? `任务已重新开始${round}。`
      : `任务 ${ref} 已重新开始${round}。`
  }
  if (input.wake.granted === false) {
    const target = ref === null ? '该任务' : `任务 ${ref}`
    // ③ 的 `not-found` 是「没有这条继续授权」，不是「你有权但被拒」；文案必须
    // 说清原因（2026-11-27 实测：not-found 被渲染成「无权」）。
    if (input.wake.skipped === 'no-port') {
      return '继续通道不可用；这条按新消息处理。'
    }
    switch (input.wake.reason) {
      case 'not-found':
        return `${target} 没有可用的继续授权；这条按新消息处理。`
      case 'scope-mismatch':
        return `${target} 的继续授权范围不匹配；这条按新消息处理。`
      case 'expired':
        return `${target} 的继续授权已过期；这条按新消息处理。`
      case 'consumed':
        return `${target} 的继续授权已使用过；这条按新消息处理。`
      case 'revoked':
        return `继续 ${target} 的授权已撤销；这条按新消息处理。`
      default:
        return `当前身份无权继续${target}；这条按新消息处理。`
    }
  }
  return ref === null ? '任务未继续执行。' : `任务 ${ref} 未继续执行。`
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
  /** Slice BD (J2): 本轮是否投递了每日邮件摘要。 */
  digest: boolean
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

/**
 * Slice BD (J2): 每日只读邮件摘要。宿主只负责「到点判定 + 选会话 + 入 outbox」，
 * 查询由 `@dsh-wfxm/mail` 走只读 IMAP，失败不写状态以便当天重试。
 */
export interface HostMailDigestOptions {
  /** 本地 `HH:MM`（时区见 `timeZone`）。 */
  at: string
  channelId: string
  /** 固定会话；null/省略 = 该渠道 `updated_at` 最新的线程。 */
  chatId?: string | null
  hours?: number
  limit?: number
  unreadOnly?: boolean
  timeZone?: string
  /** 记录「今天已发」的日期；null = 不持久化。 */
  statePath?: string | null
  /** 测试注入；生产默认走只读 IMAP 查询。 */
  produce?: (now: Date) => Promise<string>
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

/** P6-1/P6-2: emit/flush/close plus optional read methods for `/diag` `/status`. */
export interface HostTelemetryPort extends DiagTelemetryReader {
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
  flush(): Promise<unknown> | unknown
  close(): void
}

export interface WfxmHostOptions {
  /** Same `ops.sqlite` for ① and ⑤ (`schema_migrations` keeps them apart). */
  dbPath: string
  /** The execute seam; `createDshExecutor(...)` in production, a stub in tests. */
  executor: TaskExecutor
  /** P6-1: structured trace; absent means no telemetry. */
  telemetry?: HostTelemetryPort | null
  /** P6-2: a `running` task quiet for this long is reported as stuck. */
  stuckAfterMs?: number
  /** P6-2: alert sweep cadence; `0` disables the sweep. */
  diagnosticsIntervalMs?: number
  /** P6-2: repeated same-code errors in 1h that trigger an owner alert. */
  repeatFailureThreshold?: number
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
  /** AR37: current policy version; wake re-verification rejects drift. */
  policyVersion?: string | number | null
  /** H2: channel allowlist / rate limit / payload cap; null = allow everything. */
  admission?: AdmissionPort | null
  /** ③'s approval store; without it approval cards cannot be issued or answered. */
  approvals?: ApprovalStore | null
  /** Slice AT (J5): reminders store; absent means the front desk cannot set reminders. */
  reminders?: ReminderStore | null
  /** Slice BD (J2): 每日摘要；null/省略 = 不调度。 */
  mailDigest?: HostMailDigestOptions | null
  /**
   * Slice AV: ⑦'s change ledger. Absent/null means no rows and no refusals —
   * exactly the pre-AV worker behaviour.
   */
  changes?: ChangeStore | null
  /**
   * Slice AV: restore a `dir:` workspace snapshot during startup recovery.
   * Absent means a half-applied task with a snapshot can only be left for a
   * human (the rollback is marked failed, never silently skipped).
   */
  restoreWorkspace?: WorkspaceRestorePort | null
  /**
   * H4: file whose existence means "global stop is on" (governance's kill
   * switch by default). Absent disables the IM halt/resume commands.
   */
  haltFile?: string | null
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
  /**
   * P2-1/P2-2: `/eval`。`null` disables the command; absent uses
   * `eval/latest.json` (repo root) and a 5s per-chat read limit.
   * `store` 落库 run/findings；`runner` 只在开发机（`AGENT_EVAL_ROOT`）可用。
   */
  eval?: {
    snapshotPath?: string | null
    rateLimitMs?: number
    store?: EvalStore | null
    runner?: EvalL2Runner | null
    /** P2-3: `/eval promote` 的候选生成器；缺省表示不可用。 */
    promoter?: CandidatePromoter | null
    /** P7-1: `/eval from-task` 的落盘目录与相对路径根；缺省表示不可用。 */
    fromTask?: { candidatesDir: string; root: string } | null
    /** `/eval run` 的幂等桶，默认 5 分钟。 */
    runRateLimitMs?: number
  } | null
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
  /** P2-2: 等待正在执行的 `/eval run l2` 落库（测试/停机用）。 */
  drainEval(): Promise<void>
  /** Issue an approval and post its card into `threadId` (docs/14 §六). */
  requestApproval(input: RequestApprovalInput): RequestApprovalResult
  /**
   * Slice AV: settle rows the previous process left in `applying` — keep tasks
   * that already succeeded, roll the rest back. Runs before `worker.recover()`
   * so a retry never starts on top of a half-applied workspace.
   */
  recoverChanges(): Promise<{ kept: number; rolledBack: number; failed: number }>
  /** L0: read-only task lifecycle audit; `start()` also runs it once. */
  auditLifecycle(at?: Date): LifecycleAudit
  /** H4: true while the global stop file exists (survives restarts). */
  isHalted(): boolean
  pump(): Promise<HostPumpReport>
  runWorkerOnce(): Promise<TaskRunReport>
  start(): void
  stop(): void
  close(): void
}

/** Slice AV: ⑦ restores a workspace snapshot by id; the host never reads ⑦'s tables. */
export type WorkspaceRestorePort = (snapshotId: string, taskId: string | null) => void | Promise<void>

function textOf(content: Json): string | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null
  const value = (content as Record<string, unknown>).text
  return typeof value === 'string' ? value : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Slice BD: 每日摘要的只读查询。缺配置 / IMAP 失败都抛错，由调用方退避重试；
 * 邮件主题只作为信息渲染，`renderDigest` 自带「不构成指令」标注。
 */
async function defaultDigestText(at: Date, config: HostMailDigestOptions): Promise<string> {
  const account = readMailAccount()
  if (!account.ok) throw new Error(account.message)
  const search = await searchMail({ limit: 200 }, { account: account.account })
  return renderDigest(buildMailDigest(search, {
    now: at,
    request: {
      hours: config.hours ?? 24,
      limit: config.limit ?? 20,
      unreadOnly: config.unreadOnly ?? true,
    },
  }))
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
  const telemetry = options.telemetry ?? null

  /** P6-1: telemetry must never change a host decision. */
  function noteTelemetry(event: Record<string, unknown>): void {
    if (telemetry === null) return
    try {
      telemetry.emit(event)
    } catch (error) {
      logger?.warn?.(`telemetry emit failed: ${messageOf(error)}`)
    }
  }
  const evalConfig = options.eval === undefined ? {} : options.eval
  const evalEnabled = evalConfig !== null
  const evalSnapshotPath = evalConfig?.snapshotPath === undefined
    ? defaultEvalSnapshotPath()
    : evalConfig.snapshotPath
  const evalRateLimitMs = evalConfig?.rateLimitMs ?? 5000
  const evalLastReadAt = new Map<string, number>()
  const evalStore = evalConfig?.store ?? null
  const evalRunner = evalConfig?.runner ?? null
  const evalPromoter = evalConfig?.promoter ?? null
  const evalFromTask = evalConfig?.fromTask ?? null
  const evalRunRateLimitMs = evalConfig?.runRateLimitMs ?? 300_000
  let evalRunPending: Promise<void> | null = null

  const gateway = createGatewayStore(options.dbPath)
  const tasks = createTaskStore(options.dbPath)
  const approvals = options.approvals ?? null
  const reminders = options.reminders ?? null
  const changes = options.changes ?? null
  const restoreWorkspace = options.restoreWorkspace ?? null
  const haltFile = options.haltFile ?? null
  const mailDigest = options.mailDigest ?? null
  /** Slice BD: 失败后的内存退避，避免每秒重打 IMAP 或刷日志。 */
  let digestRetryAt = 0

  const ports = createHostPorts({
    tasks,
    grants: options.grants ?? null,
    policyVersion: options.policyVersion ?? null,
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
    receipts: {
      pendingReceipts(limit) {
        const rows = ports.receipts.pendingReceipts(limit)
        if (telemetry === null) return rows
        return rows.map((row) => enrichFailureReceipt(row, telemetry))
      },
      markReceiptDelivered: ports.receipts.markReceiptDelivered,
    },
    spill: spillPort,
    spillThresholdChars: spillOptions?.thresholdChars ?? DEFAULT_SPILL_CHARS,
    // L3: a row that went out before its receipt was settled rebuilds the
    // anchor here first; the relay then settles with that message id.
    onReplayed: ({ item, externalMsgId }) => bindReceiptAnchor(item, externalMsgId),
  })

  // #10: a delivered receipt becomes an anchor, so replying to the bot's
  // message resolves back to this task instead of starting a new one.
  function bindReceiptAnchor(item: OutboxItem, externalMsgId: string): void {
    if (item.taskId === null || item.threadId === null) return
    tasks.bindThread({
      taskId: item.taskId,
      threadId: item.threadId,
      relation: 'anchor',
      anchorMsgId: externalMsgId,
    })
  }

  function onSent(item: OutboxItem, externalMsgId: string): void {
    const receiptId = receiptRelay.receiptIdOf(item)
    if (receiptId !== null) receiptRelay.settle(receiptId, externalMsgId)
    if (item.taskId !== null) {
      const task = tasks.getTask(item.taskId)
      if (task !== null) {
        noteTelemetry({
          event: 'receipt.sent',
          level: 'info',
          phase: 'deliver',
          traceId: task.correlationId,
          spanId: `delivery:${item.id}`,
          parentSpanId: `task:${task.id}`,
          taskId: task.id,
          attempt: task.attempt,
          status: 'sent',
          attrs: { receipt_id: receiptId ?? item.id, topic: item.topic },
        })
      }
    }
    if (item.topic === RECEIPT_TOPIC) bindReceiptAnchor(item, externalMsgId)
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
      onFailed: (item, detail) => {
        const task = item.taskId === null ? null : tasks.getTask(item.taskId)
        noteTelemetry({
          event: 'delivery.failed',
          level: detail.final ? 'error' : 'warn',
          phase: 'deliver',
          traceId: task?.correlationId ?? item.id,
          spanId: `delivery:${item.id}`,
          ...task === null ? {} : {
            parentSpanId: `task:${task.id}`,
            taskId: task.id,
            attempt: task.attempt,
          },
          status: detail.final ? 'failed' : 'retrying',
          error: {
            code: detail.final ? 'delivery-failed' : 'delivery-retry',
            message: detail.message,
            retryable: detail.retryable,
          },
          attrs: {
            topic: item.topic,
            ...item.taskId === null ? {} : { receipt_id: item.id },
          },
        })
      },
    })

  const workerOptions = options.worker ?? {}
  const worker = createTaskWorker({
    store: tasks,
    execute: options.executor,
    snapshot: options.snapshot ?? null,
    changes: changes === null ? null : createTaskChangePort(changes),
    telemetry,
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
      // L3: the round is part of the key, so a later round rewriting the same
      // path is delivered instead of being deduplicated away.
      const dedupeKey = `task-artifact:${task.id}:${task.round}:${file.path}`
      if (gateway.findOutboxByDedupe(dedupeKey) !== null) continue
      try {
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
      } catch (error) {
        // Delivery failure never changes the task outcome (worker contract);
        // one bad attachment must not swallow the rest of the batch.
        logger?.warn?.(
          `artifact enqueue failed: task ${task.id.slice(0, 8)} ${file.name}: ${messageOf(error)}`,
        )
      }
    }
  }

  let pumpTimer: ReturnType<typeof setInterval> | null = null
  let pumping = false
  /** L3: last reported stuck-receipt count, so a stuck row logs once. */
  let lastStuckReceipts = 0
  /** H4: whether the worker timer was started, so resume can restart it. */
  let workerStarted = false

  function stop(): void {
    workerStarted = false
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
            summary: '审批在答复前过期，任务未执行',
          })
        } catch {
          // The task already moved on (executed / cancelled); nothing to release.
        }
      }
      const cardId = approvals.get(item.approvalId)?.externalMsgId ?? null
      const threadId = item.taskId === null
        ? null
        : tasks.listTaskThreads({ taskId: item.taskId })[0]?.threadId ?? null
      const expiredTask = item.taskId === null ? null : tasks.getTask(item.taskId)
      const ref = expiredTask?.taskRef ?? (item.taskId === null ? null : item.taskId.slice(0, 8))
      gateway.enqueueOutbox({
        topic: APPROVAL_UPDATE_TOPIC,
        payload: {
          kind: 'approval_result',
          approvalId: item.approvalId,
          decision: 'expired',
          ...cardId === null ? {} : { externalMsgId: cardId },
          text: ref === null
            ? '审批已过期，任务已结束（未执行任何操作）。'
            : `任务 ${ref} 的审批已过期，任务已结束（未执行任何操作）。`,
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
   * H4 global stop. The file is the single source of truth (governance's
   * kill switch), so the state survives restarts and child sessions. Halt parks
   * live attempts (`paused`, not `cancelled`) and leaves queued rows queued:
   * resume must never replay work that already happened.
   */
  function isHalted(): boolean {
    return haltFile !== null && existsSync(haltFile)
  }

  function haltAll(): { halted: boolean } {
    if (haltFile === null) throw new Error('global stop is not configured')
    try {
      mkdirSync(dirname(haltFile), { recursive: true })
      writeFileSync(haltFile, `${now().toISOString()}\n`, { encoding: 'utf8', mode: 0o640 })
    } catch (error) {
      // 不能静默退化成"看起来停了"：调用方会据此拒绝新任务。
      logger?.warn?.(`halt: cannot write ${haltFile}: ${messageOf(error)}`)
      throw error
    }
    // Stop claiming new work in this process too; the file gate alone would
    // only take effect after a restart.
    worker.stop()
    for (const task of tasks.listTasks({ status: 'running', limit: 100 })) {
      try {
        worker.cancel(task.id)
        tasks.transition(task.id, {
          to: 'paused',
          reason: 'halt:global',
          summary: '全局停止：当前尝试已中止',
        })
      } catch (error) {
        logger?.warn?.(`halt: task ${task.id} could not be paused: ${messageOf(error)}`)
      }
    }
    logger?.info?.('global stop enabled')
    return { halted: true }
  }

  function resumeAll(): { halted: boolean } {
    if (haltFile === null) throw new Error('global stop is not configured')
    rmSync(haltFile, { force: true })
    if (workerStarted && !isHalted()) worker.start({ intervalMs: workerOptions.intervalMs ?? 1_000 })
    logger?.info?.('global stop released')
    return { halted: false }
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
    // H4: due reminders stay pending; a resume fires them (still-due rows are
    // returned by `listDue`), so stopping never loses a reminder.
    if (isHalted()) return 0
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

  /**
   * Slice BD (J2): 每日摘要。判定用「到点且今天未发」，所以 08:30 时进程不在、
   * 09:10 启动也会补发；失败不写状态，退避后当天重试。
   */
  async function fireDailyDigest(): Promise<boolean> {
    if (mailDigest === null) return false
    // H4: 停止期不产生外发，也不推进状态；恢复后当天仍可补发。
    if (isHalted()) return false
    const config = mailDigest
    const at = now()
    const timeZone = config.timeZone ?? DEFAULT_DIGEST_TIME_ZONE
    const local = localDayMinutes(at, timeZone)
    const lastDate = readDigestState(config.statePath ?? null).lastDate
    if (!digestDue({ now: at, at: config.at, lastDate, timeZone })) return false
    if (at.getTime() < digestRetryAt) return false

    const threads = gateway.listThreads({
      channelId: config.channelId,
      ...config.chatId === undefined || config.chatId === null ? {} : { chatId: config.chatId },
    })
    const thread = threads[threads.length - 1] ?? null
    if (thread === null) {
      digestRetryAt = at.getTime() + 10 * 60_000
      logger?.warn?.(`digest: no target thread on channel ${config.channelId}`)
      return false
    }

    let text: string
    try {
      text = await (config.produce === undefined ? defaultDigestText(at, config) : config.produce(at))
    } catch (error) {
      digestRetryAt = at.getTime() + 15 * 60_000
      logger?.warn?.(`digest: ${messageOf(error)}`)
      return false
    }

    gateway.enqueueOutbox({
      topic: 'say',
      payload: { text },
      threadId: thread.id,
      dedupeKey: `mail-digest:${local.date}`,
    })
    try {
      writeDigestState(config.statePath ?? null, { lastDate: local.date, firedAt: at.toISOString() })
    } catch (error) {
      // outbox 幂等键已兜底，下一轮不会重复发；只留日志。
      logger?.warn?.(`digest: state write failed: ${messageOf(error)}`)
    }
    logger?.info?.(`digest: queued for ${thread.id} (${local.date})`)
    return true
  }

  async function pump(): Promise<HostPumpReport> {
    // P6-2: stuck / repeated-failure notices are queued before dispatch, so the
    // owner sees them in this same tick.
    sweepDiagnostics()
    // Settle expired approvals first: a task released here produces its receipt
    // in this same tick instead of the next one.
    const expired = expireOverdueApprovals()
    const inputRequests = askForInput()
    // Slice AT: 到期提醒在派发前入队，同一轮就能发出去。
    const remindersFired = fireDueReminders()
    // Slice BD: 每日摘要同样先入 outbox，再让 dispatcher 在同一轮送出。
    const digest = await fireDailyDigest()
    const receipts = receiptRelay.pump()
    // L3: a receipt whose outbox row exhausted its retries can only be revived
    // by an operator requeue. Log only changes so a stuck row cannot spam ticks.
    if (receipts.stuck !== lastStuckReceipts) {
      if (receipts.stuck > 0) {
        logger?.warn?.(`receipt delivery stuck: ${receipts.stuck} row(s) need outbox requeue`)
      }
      lastStuckReceipts = receipts.stuck
    }
    // Slice R: enqueue progress notices before the dispatcher claims, so a due
    // reminder goes out in this same tick instead of waiting for the next one.
    const progress = progressRelay === null ? null : progressRelay.pump()
    // B3 v2: pause only after the notice is safely queued, so the owner always
    // learns why the task stopped.
    if (progress !== null) pauseStalled(progress.stalled)
    const dispatch = dispatcher === null ? null : await dispatcher.runOnce()
    return { expired, inputRequests, reminders: remindersFired, digest, receipts, progress, dispatch }
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

  /** P6-2: resolve a task ref, full id or id prefix. */
  function findTaskByRef(ref: string): Task | null {
    const all = tasks.listTasks()
    const normalized = ref.trim()
    if (normalized === '') return null
    return all.find((task) => task.taskRef === normalized)
      ?? all.find((task) => task.id === normalized)
      ?? all.find((task) => task.id.startsWith(normalized))
      ?? all.find((task) => task.taskRef?.startsWith(normalized) === true)
      ?? null
  }

  /** P6-2: `running` tasks whose latest event is older than the threshold. */
  function stuckTasks(): StuckTask[] {
    const at = now()
    const thresholdMs = options.stuckAfterMs ?? 15 * 60_000
    const result: StuckTask[] = []
    for (const task of tasks.listTasks({ status: 'running' })) {
      let lastActivityAt: string | null = null
      try {
        lastActivityAt = tasks.latestEvent(task.id)?.createdAt ?? null
      } catch {
        lastActivityAt = null
      }
      if (!isStuck({ task, lastActivityAt, now: at, thresholdMs })) continue
      const anchor = Date.parse(lastActivityAt ?? task.startedAt ?? task.createdAt)
      result.push({
        task,
        quietMs: Number.isFinite(anchor) ? Math.max(0, at.getTime() - anchor) : 0,
      })
    }
    return result.sort((a, b) => b.quietMs - a.quietMs)
  }

  /**
   * P6-2: `/diag <ref>` and `/status` are owner-only and read-only. They never
   * create a task or call the model.
   */
  function handleDiagCommand(
    result: IngestResult,
    command: DiagCommand,
  ): void {
    const threadId = result.thread?.id ?? null
    const replyToMsgId = result.inbox.replyToMsgId ?? null
    const reply = (text: string, suffix: string): void => {
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text },
        threadId,
        replyToMsgId,
        dedupeKey: `diag:${result.inbox.id}:${suffix}`,
      })
    }
    if (result.actor === null || result.actor.kind !== 'owner') {
      reply('仅 owner 可使用 /diag 与 /status。', 'denied')
      return
    }

    if (command.kind === 'suggestions') {
      const rows = tasks.listSuggestions({ limit: 10 })
      const lines = ['最近建议：']
      if (rows.length === 0) lines.push('（暂无）')
      for (const row of rows) {
        const task = row.taskId === null ? null : tasks.getTask(row.taskId)
        const link = row.taskId === null
          ? ''
          : ` · 任务 ${task?.taskRef ?? row.taskId.slice(0, 8)}`
        lines.push(`- [${row.status}] ${row.id} · ${row.action}${link}`)
      }
      reply(lines.join('\n'), 'suggestions')
      return
    }

    if (command.kind === 'status') {
      const at = now()
      const all = tasks.listTasks()
      const cutoff = at.getTime() - 60 * 60_000
      const recent = all.filter((task) => {
        if (task.finishedAt === null) return false
        if (task.status !== 'failed' && task.status !== 'succeeded' && task.status !== 'cancelled') {
          return false
        }
        const finished = Date.parse(task.finishedAt)
        return Number.isFinite(finished) && finished >= cutoff
      })
      reply(formatStatusReport({
        halted: isHalted(),
        tasks: all,
        failures: {
          failed: recent.filter((task) => task.status === 'failed').length,
          total: recent.length,
        },
        stuck: stuckTasks(),
        telemetry: telemetry?.stats?.() ?? null,
        now: at,
      }), 'status')
      return
    }

    if (command.ref === null) {
      reply('用法：/diag <任务号>，例如 /diag abc123。', 'usage')
      return
    }
    const task = findTaskByRef(command.ref)
    if (task === null) {
      reply(`没有找到任务 ${command.ref}。`, 'missing')
      return
    }
    const attempts = telemetry?.attempts?.(task.id) ?? []
    const events = telemetry?.query?.({ taskId: task.id, limit: 500 }).rows ?? []
    reply(formatDiagReport({
      task,
      attempts,
      events,
      now: now(),
      hasTelemetry: telemetry?.query !== undefined,
    }), 'diag')
  }

  let lastDiagnosticsSweepAt = 0

  /** P6-2: stuck / repeated-failure alerts reuse outbox dedupe as the throttle. */
  function sweepDiagnostics(): void {
    const at = now()
    const interval = options.diagnosticsIntervalMs ?? 60_000
    if (interval <= 0 || at.getTime() - lastDiagnosticsSweepAt < interval) return
    lastDiagnosticsSweepAt = at.getTime()

    const enqueue = (input: {
      text: string
      threadId: string
      dedupeKey: string
    }): void => {
      try {
        if (gateway.findOutboxByDedupe(input.dedupeKey) !== null) return
        gateway.enqueueOutbox({
          topic: 'say',
          payload: { text: input.text },
          threadId: input.threadId,
          dedupeKey: input.dedupeKey,
        })
      } catch (error) {
        logger?.warn?.(`diagnostics alert skipped: ${messageOf(error)}`)
      }
    }

    for (const { task, quietMs } of stuckTasks().slice(0, 3)) {
      const thread = tasks.listTaskThreads({ taskId: task.id, liveOnly: true })[0]
      if (thread === undefined) continue
      enqueue({
        text: formatStuckAlert(task, quietMs),
        threadId: thread.threadId,
        dedupeKey: `diag:stuck:${task.id}:${task.attempt}`,
      })
    }

    if (telemetry?.query === undefined) return
    try {
      const from = new Date(at.getTime() - 60 * 60_000).toISOString()
      const events = telemetry.query({ level: 'error', from, limit: 500 }).rows
      for (const group of groupErrorCodes(events)) {
        if (group.count < (options.repeatFailureThreshold ?? 3)) continue
        if (group.latestTaskId === null) continue
        const task = tasks.getTask(group.latestTaskId)
        if (task === null) continue
        const thread = tasks.listTaskThreads({ taskId: task.id, liveOnly: true })[0]
        if (thread === undefined) continue
        enqueue({
          text: formatRepeatAlert(group.code, group.count, taskRefOf(task)),
          threadId: thread.threadId,
          dedupeKey: `diag:repeat:${group.code}:${Math.floor(at.getTime() / 3_600_000)}`,
        })
      }
    } catch (error) {
      logger?.warn?.(`diagnostics sweep failed: ${messageOf(error)}`)
    }
  }

  function suggestionTaskLabel(taskId: string | null): string {
    if (taskId === null) return '—'
    return tasks.getTask(taskId)?.taskRef ?? taskId.slice(0, 8)
  }

  /**
   * P7-3: 「做 #n」→ 建任务并记录采纳；「忽略 #n」→ 只记状态。
   * 采纳仍走正常审批：任务创建后由下面的 task-created 分支决定是否发确认卡。
   */
  function handleSuggestionCommand(
    result: IngestResult,
    command: SuggestionCommand,
  ): ForegroundOutcome {
    const reply = (text: string): ForegroundOutcome => ({
      action: 'reply',
      text,
      threadId: result.thread?.id ?? '',
    })
    if (result.actor === null || result.actor.kind !== 'owner') {
      return reply('仅 owner 可采纳日报建议。')
    }
    const suggestion = tasks.resolveSuggestion(command.ref)
    if (suggestion === null) {
      return reply(`找不到建议 #${command.ref}；用 /diag suggestions 查看最近的建议与 id。`)
    }
    if (command.kind === 'ignore') {
      if (suggestion.status === 'accepted') {
        return reply(`建议 ${suggestion.id} 已采纳为任务 ${suggestionTaskLabel(suggestion.taskId)}，不能忽略。`)
      }
      tasks.ignoreSuggestion(suggestion.id)
      return reply(`已忽略建议 ${suggestion.id}，后续日报不再重复；如需执行请直接描述需求。`)
    }
    if (suggestion.status === 'accepted') {
      return reply(`建议 ${suggestion.id} 已采纳（任务 ${suggestionTaskLabel(suggestion.taskId)}）。`)
    }
    if (suggestion.status === 'ignored') {
      return reply(`建议 ${suggestion.id} 已忽略；如需执行请直接描述需求。`)
    }

    const plan = planTaskRisk(suggestion.action, suggestion.risk)
    const task = tasks.createTask({
      intent: suggestion.action,
      riskLevel: plan.risk,
      originMsgId: result.inbox.msgId,
      projectId: result.project?.projectId ?? null,
      correlationId: result.inbox.id,
      suggestionId: suggestion.id,
    })
    for (const assertion of plan.assertions) tasks.addAssertion(task.id, assertion)
    if (result.thread !== null) {
      tasks.bindThread({
        taskId: task.id,
        threadId: result.thread.id,
        relation: 'default_owner',
        anchorMsgId: result.inbox.msgId,
      })
    }
    tasks.acceptSuggestion(suggestion.id, task.id)
    return { action: 'task-created', taskId: task.id, note: `suggestion:${suggestion.id}` }
  }

  /**
   * P2-1: `/eval` 是只读命令——不建任务、不进模型、不执行测评。
   * 生产读随发布生成的 `eval/latest.json`；缺快照就明说，绝不推断通过。
   */
  async function handleEvalCommand(    result: IngestResult,
    target: { kind: 'eval'; command: EvalCommand },
  ): Promise<void> {
    const threadId = result.thread?.id ?? null
    const replyToMsgId = result.inbox.replyToMsgId ?? null
    const reply = (text: string, suffix: string): void => {
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text },
        threadId,
        replyToMsgId,
        dedupeKey: `eval:${result.inbox.id}:${suffix}`,
      })
    }

    if (result.actor === null || result.actor.kind !== 'owner') {
      reply('仅 owner 可使用 /eval。', 'denied')
      return
    }

    if (target.command.kind === 'help') {
      reply(formatEvalHelp(), 'help')
      return
    }
    if (target.command.kind === 'unsupported') {
      reply(formatEvalUnsupported(target.command.detail), 'unsupported')
      return
    }

    // P2-3: 人工反馈 → 写库；不跑模型、不改任务集。
    if (target.command.kind === 'flag') {
      if (evalStore === null) {
        reply('测评库未启用，无法记录 finding。', 'flag-disabled')
        return
      }
      const messageId = result.inbox.replyToMsgId
      if (messageId === null) {
        reply(formatEvalFlagNeedsQuote(), 'flag-no-quote')
        return
      }
      const { finding } = evalStore.recordFlag({
        messageId,
        threadId: result.thread?.id ?? null,
        reason: target.command.reason,
      })
      reply(formatEvalFlagRecorded(finding), 'flag-recorded')
      return
    }

    if (target.command.kind === 'promote' || target.command.kind === 'ignore') {
      if (evalStore === null) {
        reply('测评库未启用，无法处理 finding。', 'finding-disabled')
        return
      }
      const resolution = evalStore.resolveFinding(target.command.ref)
      if ('error' in resolution) {
        reply(formatEvalFindingMissing(target.command.ref, resolution.error), 'finding-missing')
        return
      }
      const finding = resolution.finding
      if (finding.status !== 'open') {
        reply(formatEvalFindingAlready(finding), 'finding-done')
        return
      }
      if (target.command.kind === 'ignore') {
        const updated = evalStore.setFindingStatus(finding.id, 'ignored')
        reply(
          updated === null ? formatEvalFindingMissing(target.command.ref, 'not-found') : formatEvalFindingIgnored(updated),
          'finding-ignored',
        )
        return
      }
      if (evalPromoter === null || !evalPromoter.available) {
        reply(formatEvalCandidateUnavailable(), 'promote-unavailable')
        return
      }
      const promoted = await evalPromoter.promote(finding)
      if (promoted.ok) evalStore.setFindingStatus(finding.id, 'promoted', promoted.taskId)
      reply(formatEvalPromoted(promoted), promoted.ok ? 'promoted' : 'promote-failed')
      return
    }

    // G2: finding → 修复任务。与候选（promoted_task_id）分开记录；任务仍走
    // 正常审批与执行链，不绕过治理闸门。上一个修复任务失败/取消时允许重建。
    if (target.command.kind === 'fix') {
      if (evalStore === null) {
        reply('测评库未启用，无法建修复任务。', 'fix-disabled')
        return
      }
      const resolution = evalStore.resolveFinding(target.command.ref)
      if ('error' in resolution) {
        reply(formatEvalFindingMissing(target.command.ref, resolution.error), 'finding-missing')
        return
      }
      const finding = resolution.finding
      if (finding.status === 'ignored' || finding.status === 'verified') {
        reply(formatEvalFixNotNeeded(finding), 'fix-not-needed')
        return
      }
      if (finding.fixTaskId !== null) {
        const existing = tasks.getTask(finding.fixTaskId)
        const retryable = existing === null
          || existing.status === 'failed'
          || existing.status === 'cancelled'
        if (!retryable) {
          reply(formatEvalFixExists(finding), 'fix-exists')
          return
        }
      }
      const intent = `修复测评失败：${finding.title}`
      const plan = planTaskRisk(intent, 'R1')
      const task = tasks.createTask({
        intent,
        riskLevel: plan.risk,
        originMsgId: result.inbox.msgId,
        projectId: result.project?.projectId ?? null,
        correlationId: result.inbox.id,
      })
      for (const assertion of plan.assertions) tasks.addAssertion(task.id, assertion)
      if (result.thread !== null) {
        try {
          tasks.bindThread({
            taskId: task.id,
            threadId: result.thread.id,
            relation: 'default_owner',
            anchorMsgId: result.inbox.msgId,
          })
        } catch (error) {
          // 线程已有 live default owner（15 §9.6）：任务已建，不必因此失败；
          // 后续消息继续归原任务，finding 关联仍然成立。
          logger?.warn?.(`fix task ${task.taskRef ?? task.id} not bound: ${messageOf(error)}`)
        }
      }
      evalStore.setFindingFixTask(finding.id, task.id)
      reply(formatEvalFixCreated(finding, task.taskRef ?? task.id.slice(0, 8)), 'fix-created')
      return
    }

    // P7-1: 生产失败 → 脱敏轨迹 + 候选，不把原文写进候选或 finding。
    if (target.command.kind === 'from-task') {
      if (evalStore === null || evalFromTask === null || telemetry?.query === undefined) {
        reply(formatEvalFromTaskDisabled(), 'from-task-disabled')
        return
      }
      const task = findTaskByRef(target.command.ref)
      if (task === null) {
        reply(formatEvalFromTaskMissing(target.command.ref), 'from-task-missing')
        return
      }
      if (task.status !== 'failed') {
        reply(formatEvalFromTaskNotFailed(task.status), 'from-task-status')
        return
      }
      const events = telemetry.query({ taskId: task.id, limit: 5000 }).rows
      if (events.length === 0) {
        reply(formatEvalFromTaskNoTrace(task.taskRef ?? task.id), 'from-task-no-trace')
        return
      }
      const result = createTrajectoryCandidate({
        task,
        events,
        attempts: telemetry.attempts?.(task.id) ?? [],
        outDir: evalFromTask.candidatesDir,
        root: evalFromTask.root,
        label: 'prod',
        onExists: 'refuse',
      })
      if (!result.ok) {
        if (result.reason === 'exists') {
          reply(formatEvalFromTaskExists('display' in result ? result.display ?? '' : ''), 'from-task-exists')
        } else if (result.reason === 'no-events') {
          reply(formatEvalFromTaskNoTrace(task.taskRef ?? task.id), 'from-task-no-trace')
        } else {
          reply('候选目录不在允许的数据根内，拒绝落盘。', 'from-task-root')
        }
        return
      }
      const { finding } = evalStore.recordProductionFinding({
        suite: 'production',
        taskId: task.id,
        title: `生产失败：${task.taskRef ?? task.id.slice(0, 8)}`,
        detail: result.traceFile,
      })
      if (finding.status === 'open') evalStore.setFindingStatus(finding.id, 'promoted', result.id)
      reply(formatEvalFromTaskCreated({
        display: result.display,
        taskRef: result.taskRef,
        lines: result.lines,
        findingId: finding.id,
      }), 'from-task-done')
      return
    }

    // P7 补口：修复任务成功后，用它的成功轨迹覆盖原候选（草稿与判据不变），
    // 下一次 nightly 回放即可把 finding 判定为 verified；不新增候选、不改 finding。
    if (target.command.kind === 'refresh') {
      if (evalStore === null || evalFromTask === null || telemetry?.query === undefined) {
        reply(formatEvalFromTaskDisabled(), 'refresh-disabled')
        return
      }
      const resolution = evalStore.resolveFinding(target.command.ref)
      if ('error' in resolution) {
        reply(formatEvalFindingMissing(target.command.ref, resolution.error), 'finding-missing')
        return
      }
      const finding = resolution.finding
      if (finding.status !== 'promoted' || finding.promotedTaskId === null) {
        reply(formatEvalRefreshNotPromoted(finding), 'refresh-not-promoted')
        return
      }
      if (finding.fixTaskId === null) {
        reply(formatEvalRefreshNoFix(finding), 'refresh-no-fix')
        return
      }
      const fixTask = tasks.getTask(finding.fixTaskId)
      const fixRef = fixTask?.taskRef ?? finding.fixTaskId.slice(0, 8)
      if (fixTask === null) {
        reply(formatEvalFromTaskMissing(fixRef), 'refresh-fix-missing')
        return
      }
      if (fixTask.status !== 'succeeded') {
        reply(formatEvalRefreshFixStatus(fixRef, fixTask.status), 'refresh-fix-status')
        return
      }
      const candidateId = finding.promotedTaskId
      if (!/^[A-Za-z0-9._-]+$/.test(candidateId)) {
        reply(formatEvalRefreshDraftMissing(candidateId), 'refresh-draft')
        return
      }
      let requiredTools: readonly string[]
      try {
        const draft = JSON.parse(
          readFileSync(join(evalFromTask.candidatesDir, `${candidateId}.json`), 'utf8'),
        ) as { expect?: { requiredTools?: unknown } }
        const tools = draft.expect?.requiredTools
        requiredTools = Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === 'string') : []
      } catch {
        reply(formatEvalRefreshDraftMissing(candidateId), 'refresh-draft')
        return
      }
      const events = telemetry.query({ taskId: fixTask.id, limit: 5000 }).rows
      if (events.length === 0) {
        reply(formatEvalFromTaskNoTrace(fixRef), 'refresh-no-trace')
        return
      }
      const candidateInput = {
        task: fixTask,
        events,
        attempts: telemetry.attempts?.(fixTask.id) ?? [],
        outDir: evalFromTask.candidatesDir,
        root: evalFromTask.root,
        label: 'prod',
        fileName: candidateId,
        onExists: 'overwrite' as const,
        writeDraft: false,
      }
      // 先 dry-run：新轨迹必须覆盖旧草稿要求的工具，否则不覆盖已有证据。
      const preview = createTrajectoryCandidate({ ...candidateInput, dryRun: true })
      if (!preview.ok) {
        reply(formatEvalFromTaskNoTrace(fixRef), 'refresh-preview')
        return
      }
      const previewDraft = preview.draft.expect as { requiredTools?: unknown } | undefined
      const newTools = Array.isArray(previewDraft?.requiredTools)
        ? previewDraft.requiredTools.filter((tool): tool is string => typeof tool === 'string')
        : []
      const missing = requiredTools.filter((tool) => !newTools.includes(tool))
      if (missing.length > 0) {
        reply(formatEvalRefreshToolsMissing(missing), 'refresh-tools')
        return
      }
      const written = createTrajectoryCandidate(candidateInput)
      if (!written.ok) {
        reply(formatEvalFromTaskNoTrace(fixRef), 'refresh-write')
        return
      }
      reply(formatEvalRefreshDone({ candidateId, taskRef: fixRef, lines: written.lines }), 'refresh-done')
      return
    }

    // P2-2: `/eval run l2` 只在开发机（AGENT_EVAL_ROOT）执行；先回执再异步跑。
    if (target.command.kind === 'run') {
      if (target.command.mode === 'real') {
        reply(formatEvalRunRealHint(), 'run-real')
        return
      }
      if (evalStore === null || evalRunner === null || !evalRunner.available) {
        reply(formatEvalEngineMissing(), 'run-missing')
        return
      }
      const actorId = result.actor.id
      // 已有 run 未结束就不再启动第二个（超时窗口 10 分钟 > 限流窗口 5 分钟）。
      const active = evalStore.findRunningRun()
      if (active !== null) {
        reply(formatEvalRunReused(active), `run-${active.id}`)
        return
      }
      // 5 分钟桶幂等：同一窗口内重复请求返回同一个 run，绝不重跑。
      const key = `l2:${Math.floor(now().getTime() / evalRunRateLimitMs)}`
      const existing = evalStore.findRunByIdempotencyKey(key)
      if (existing !== null) {
        reply(formatEvalRunReused(existing), `run-${existing.id}`)
        return
      }
      const { run } = evalStore.recordRun({
        suite: 'l2',
        runtime: 'dsh-wfxm',
        mode: 'l2',
        status: 'running',
        advisory: true,
        triggeredBy: actorId,
        idempotencyKey: key,
        startedAt: now().toISOString(),
      })
      reply(formatEvalRunStarted(run), 'run-started')
      const runThreadId = result.thread?.id ?? null
      const runReplyToMsgId = result.inbox.replyToMsgId ?? null
      const pending = evalRunner.run()
        .then((outcome) => {
          const finished = evalStore.finishRun(run.id, {
            status: outcome.ok ? 'ok' : 'failed',
            passed: outcome.passed,
            total: outcome.total,
            advisory: outcome.advisory,
            reportRef: outcome.reportRef,
            finishedAt: now().toISOString(),
          })
          if (finished === null) return
          evalStore.upsertFindings(run.id, outcome.failures.map((item) => ({
            suite: item.suite,
            taskId: item.taskId,
            severity: 'fail' as const,
            title: item.taskId ?? `${item.suite}（套件未全过）`,
            detail: item.detail ?? (typeof item.rate === 'number' ? `通过率 ${Math.round(item.rate * 100)}%` : null),
            source: 'ci' as const,
          })))
          gateway.enqueueOutbox({
            topic: 'say',
            payload: { text: formatEvalRunFinished(finished, evalStore.listFindings({ runId: run.id })) },
            threadId: runThreadId,
            replyToMsgId: runReplyToMsgId,
            dedupeKey: `eval-run:${run.id}:done`,
          })
        })
        .catch((error: unknown) => {
          const timeout = error instanceof EvalTimeoutError
          evalStore.finishRun(run.id, {
            status: timeout ? 'timeout' : 'failed',
            finishedAt: now().toISOString(),
          })
          const detail = messageOf(error)
          logger?.warn?.(`eval run ${run.id} ${timeout ? 'timeout' : 'failed'}: ${detail}`)
          gateway.enqueueOutbox({
            topic: 'say',
            payload: { text: formatEvalRunFailed(detail) },
            threadId: runThreadId,
            replyToMsgId: runReplyToMsgId,
            dedupeKey: `eval-run:${run.id}:done`,
          })
        })
        .finally(() => {
          if (evalRunPending === pending) evalRunPending = null
        })
      evalRunPending = pending
      return
    }

    const key = result.thread?.chatId ?? result.actor.id
    const at = now().getTime()
    const last = evalLastReadAt.get(key) ?? 0
    if (evalRateLimitMs > 0 && at - last < evalRateLimitMs) {
      reply('请求过于频繁，请稍后再试。', 'limited')
      return
    }
    evalLastReadAt.set(key, at)

    const load: EvalSnapshotLoad = (() => {
      if (evalSnapshotPath === null) return { ok: false, reason: 'missing' }
      const primary = loadEvalSnapshot(evalSnapshotPath)
      if (primary.ok || primary.reason !== 'missing') return primary
      // P7-2: 数据目录还没有 nightly 快照时，退回随发布生成的那份。
      const fallback = defaultEvalSnapshotPath()
      return evalSnapshotPath === fallback ? primary : loadEvalSnapshot(fallback)
    })()
    // P2-2: 快照是 nightly/release 结果的只读载体；按 recordedAt 幂等落库。
    if (evalStore !== null && load.ok) {
      try {
        evalStore.syncSnapshot(load.snapshot)
      } catch (error) {
        logger?.warn?.(`eval snapshot sync failed: ${messageOf(error)}`)
      }
    }
    if (target.command.kind === 'findings' && evalStore !== null) {
      reply(formatEvalDbFindings(evalStore.listOpenFindings(20)), 'findings')
      return
    }
    reply(
      target.command.kind === 'findings' ? formatEvalFindings(load) : formatEvalStatus(load),
      target.command.kind,
    )
  }

  async function ingest(input: IngestInboundInput): Promise<HostIngestResult> {
    const result = await ingestInbound(
      {
        store: gateway,
        relay: ports.relay,
        control: ports.control,
        global: {
          halt: haltAll,
          resume: resumeAll,
          status: () => ({ halted: isHalted() }),
        },
        grantCheck: ports.grantCheck,
        wake: ports.wake,
        project: ports.project,
        approval: approvals === null ? null : ports.approvalAnswer,
        approvalDetails: approvals === null ? null : ports.approvalDetail,
        ...options.admission === undefined || options.admission === null
          ? {}
          : { admission: options.admission },
        ...options.duplicateWindowMs === undefined
          ? {}
          : { duplicateWindowMs: options.duplicateWindowMs },
      },
      input,
    )

    noteTelemetry({
      event: 'message.received',
      level: 'info',
      phase: 'ingest',
      traceId: result.inbox.id,
      spanId: result.inbox.id,
      messageId: result.inbox.msgId,
      ...result.thread === null ? {} : { threadId: result.thread.id },
      status: result.duplicate ? 'duplicate' : 'accepted',
      attrs: { channel: input.channelId },
    })
    // P2-1/P2-3: `/eval` 直接回执，不进前台、不建任务；flag/promote/ignore 只写测评库。
    // 落在活跃任务线程里时网关会把它标成 attach，所以按文本再解析一次，避免被任务补料吞掉。
    const evalCommand = result.target.kind === 'eval'
      ? result.target.command
      : parseEvalCommand(textOf(input.content) ?? '')
    if (evalCommand !== null && !result.duplicate) {
      await handleEvalCommand(result, { kind: 'eval', command: evalCommand })
      return { result, foreground: null, error: null }
    }
    // P6-2: owner diagnostics bypass the foreground/model entirely.
    if (result.target.kind === 'diag') {
      handleDiagCommand(result, result.target.command)
      return { result, foreground: null, error: null }
    }

    // P7-3: 建议命令可能落在活跃任务线程里，必须在 task 路由/补料之前截获。
    const suggestionCommand = parseSuggestionCommand(textOf(input.content) ?? '')

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

    // H4: every global control needs an explicit acknowledgement — silence
    // would look like the command was lost.
    if (result.global !== null && result.global !== undefined) {
      const halted = result.global.halted
      const command = result.target.kind === 'control' ? result.target.command : null
      const text = result.global.executed
        ? command === 'status_all'
          ? `全局状态：${halted === true ? 'stopped（已停止）' : halted === false ? 'running（运行中）' : '不可用'}`
          : halted === true
            ? '已全局停止：新任务与提醒暂停，运行中的尝试已中止并置为暂停。发送「全局恢复」后继续。'
            : halted === false
              ? '已全局恢复：新任务与提醒继续；被暂停的任务需要单独回复「继续 <任务号>」。'
              : '全局状态不可用。'
        : '全局停止不可用：主机未配置停止开关。'
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text },
        threadId: result.thread?.id ?? null,
        replyToMsgId: result.inbox.replyToMsgId ?? null,
        dedupeKey: `global-control:${result.inbox.id}`,
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

    // L4: an anchored control command / wake always answers. ① already applied
    // or refused it; silence here reads as "the message was lost".
    const controlTarget = result.target.kind === 'control' ? result.target : null
    const globalCommand = controlTarget !== null
      && (controlTarget.command === 'halt'
        || controlTarget.command === 'resume_all'
        || controlTarget.command === 'status_all')
    if (controlTarget !== null && !globalCommand && !result.duplicate) {
      const taskId = result.followUp?.taskId ?? controlTarget.taskId ?? null
      const task = taskId === null ? null : tasks.getTask(taskId)
      const commandWord = CONTROL_COMMAND_TEXT[controlTarget.command] ?? controlTarget.command
      const text = result.control !== null && result.control !== undefined
        ? controlAck({
          command: controlTarget.command,
          report: result.control,
          taskRef: task?.taskRef ?? (taskId === null ? null : taskId.slice(0, 8)),
          status: result.control.status ?? task?.status ?? null,
        })
        : taskId === null
          // ① never invents a target: an unanchored command must ask for the ref.
          ? result.followUp?.ambiguous === true
            ? `有多个任务在执行：${(result.followUp.candidates ?? [])
              .map((id) => tasks.getTask(id)?.taskRef ?? id.slice(0, 8))
              .join(' / ')}，请用「${commandWord} <任务号>」指定。`
            : `没有找到要${commandWord}的任务：请带上任务号，例如「${commandWord} abc123」。`
          : `控制通道不可用，${commandWord}命令未执行。`
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text },
        ...taskId === null ? {} : { taskId },
        threadId: result.thread?.id ?? null,
        replyToMsgId,
        dedupeKey: `control-ack:${result.inbox.id}`,
      })
    }

    // L4: a wake attempt is a decision about a task and always gets an answer —
    // except when the same turn starts a new task (see below): two bubbles for
    // one instruction read as a malfunction.
    const wakeTaskId = result.followUp?.taskId ?? null
    const wakeTask = wakeTaskId === null ? null : tasks.getTask(wakeTaskId)
    const wakeRef = wakeTask?.taskRef ?? (wakeTaskId === null ? null : wakeTaskId.slice(0, 8))
    const wakeReported = (result.wake !== null && result.wake !== undefined)
      || result.error === 'wake-unavailable'
    const wakeNotice = !wakeReported || result.duplicate
      ? null
      : result.wake === null || result.wake === undefined
        ? '任务未能重新唤醒，请重试或另发一条新任务。'
        : wakeAck({ wake: result.wake, taskRef: wakeRef })
    const wakeNoticeDeferred = wakeNotice !== null
      && result.target.kind === 'orchestrator'
      && (result.wake === null || result.wake === undefined || !result.wake.woken)
    if (wakeNotice !== null && !wakeNoticeDeferred) {
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text: wakeNotice },
        ...wakeTaskId === null ? {} : { taskId: wakeTaskId },
        threadId: result.thread?.id ?? null,
        replyToMsgId,
        dedupeKey: `wake-ack:${result.inbox.id}`,
      })
    }

    if (result.duplicate || (suggestionCommand === null && result.target.kind !== 'orchestrator')) {
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

    // H4: while stopped, ordinary turns never reach the model and never create
    // tasks. Control commands were settled by ① above, so recovery still works.
    if (isHalted()) {
      gateway.updateInboxStatus(result.inbox.id, 'triaged')
      gateway.appendRouteDecision({
        triggerId: result.inbox.id,
        action: 'ignore',
        reason: 'halted: global stop is on',
        threadId: result.thread?.id ?? null,
      })
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text: '已全局停止，暂不处理新请求。发送「全局恢复」后继续。' },
        threadId: result.thread?.id ?? null,
        replyToMsgId,
      })
      return { result, foreground: null, error: null }
    }

    let turn: ForegroundOutcome
    // P7-3: 采纳后仍复用下面的 task-created 审批/回执。
    if (suggestionCommand !== null) {
      turn = handleSuggestionCommand(result, suggestionCommand)
    } else {
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
        noteTelemetry({
          event: 'message.failed',
          level: 'error',
          phase: 'ingest',
          traceId: result.inbox.id,
          spanId: result.inbox.id,
          messageId: result.inbox.msgId,
          ...result.thread === null ? {} : { threadId: result.thread.id },
          status: 'failed',
          error: { code: 'foreground-unavailable', message: reason },
        })
        return { result, foreground: null, error: 'foreground-unavailable' }
      }
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

    // Deferred wake notice: the foreground answered without starting a task
    // (reply / reminder / none), so the refusal still needs its own line.
    if (wakeNotice !== null && wakeNoticeDeferred && turn.action !== 'task-created') {
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text: wakeNotice },
        ...wakeTaskId === null ? {} : { taskId: wakeTaskId },
        threadId: result.thread?.id ?? null,
        replyToMsgId,
        dedupeKey: `wake-ack:${result.inbox.id}`,
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
      if (task !== null) {
        noteTelemetry({
          event: 'task.created',
          level: 'info',
          phase: 'task',
          traceId: task.correlationId,
          spanId: `task:${task.id}`,
          parentSpanId: task.correlationId,
          taskId: task.id,
          taskRef: task.taskRef ?? undefined,
          round: task.round,
          status: task.status,
          attrs: {
            risk_level: task.riskLevel,
            ...task.projectId === null ? {} : { project: task.projectId },
          },
        })
      }
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

      // P7-3: 让 owner 看到这条任务来自哪条建议。
      if (task !== null && task.suggestionId !== null && task.suggestionId !== undefined) {
        ack = ack.replace(/^收到，/, `已采纳建议 ${task.suggestionId}，`)
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

  /**
   * Slice AV startup recovery (docs/11 §5.4). Only rows left by a previous
   * process are touched — nothing here runs periodically, so an in-flight
   * attempt is never rolled back underneath the worker.
   */
  async function recoverChanges(): Promise<{ kept: number; rolledBack: number; failed: number }> {
    const report = { kept: 0, rolledBack: 0, failed: 0 }
    if (changes === null) return report

    for (const row of changes.listHalfApplied(200)) {
      const taskId = row.taskId
      if (taskId === null) continue

      // The task actually finished; only the ledger write was lost. 补账 —
      // rolling a successful task back would undo work the owner already got.
      if (row.status === 'applying' && tasks.getTask(taskId)?.status === 'succeeded') {
        const kept = changes.keep(taskId, 'recovered: task already succeeded')
        if (kept.ok) report.kept += 1
        else logger?.warn?.(`change ${row.id}: keep refused during recovery (${kept.code})`)
        continue
      }

      // A previous process may have claimed the rollback before crashing;
      // only one process may own it, so claim when it is still unclaimed.
      if (row.rollbackStatus !== 'ready' && !changes.claimRollback(taskId)) continue

      try {
        if (row.snapshotId !== null) {
          if (restoreWorkspace === null) throw new Error('workspace restore port is not configured')
          await restoreWorkspace(row.snapshotId, taskId)
        } else {
          if (ports.rollback === null) throw new Error('preimage rollback port is not configured')
          ports.rollback.rollback({ taskId })
        }
        const marked = changes.markRolledBack(taskId, 'recovered: half-applied change rolled back')
        if (!marked.ok) throw new Error(`markRolledBack refused: ${marked.code}`)
        report.rolledBack += 1
        logger?.info?.(`change ${row.id}: task ${taskId} rolled back during recovery`)
      } catch (error) {
        // 不猜、不反复重试：留痕并交给人工（docs/11 §5.4）。
        const detail = messageOf(error)
        changes.markRollbackFailed(taskId, detail)
        report.failed += 1
        logger?.warn?.(`change ${row.id}: task ${taskId} rollback failed: ${detail}`)
      }
    }
    return report
  }

  return {
    stores: { gateway, tasks },
    ports,
    dispatcher,
    worker,

    ingest,
    requestApproval,
    recoverChanges,
    /** L0 read-only lifecycle audit (also run once at `start()`). */
    auditLifecycle: (at?: Date) => tasks.auditLifecycle({ now: at }),
    isHalted,
    pump,
    drainEval: async () => {
      await evalRunPending
    },

    runWorkerOnce: () => isHalted()
      ? Promise.resolve({
        taskId: null,
        outcome: 'skipped' as const,
        failure: null,
        skipped: 'halted' as const,
        attempt: null,
        wakeAt: null,
      })
      : worker.runOnce(),

    start() {
      workerStarted = true
      // L0: surface structural drift before new work starts. Read-only and
      // non-blocking — a noisy audit must never keep the host from serving.
      try {
        const audit = tasks.auditLifecycle()
        if (audit.findings.length > 0) {
          const lines = audit.findings.slice(0, 10).map((finding) => (
            `${finding.kind}: ${finding.taskId}: ${finding.detail}`
          ))
          logger?.warn?.(`task lifecycle audit: ${audit.findings.length} finding(s)\n${lines.join('\n')}`)
        }
      } catch (error) {
        logger?.warn?.(`task lifecycle audit failed: ${messageOf(error)}`)
      }
      // A restart while the halt file exists stays stopped; the pump still
      // runs so the owner can receive `全局恢复`.
      if (!isHalted()) worker.start({ intervalMs: workerOptions.intervalMs ?? 1_000 })
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
      try {
        telemetry?.close()
      } catch (error) {
        logger?.warn?.(`telemetry close failed: ${messageOf(error)}`)
      }
      tasks.close()
      gateway.close()
    },
  }
}
