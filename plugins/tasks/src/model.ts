/**
 * Task model (module ⑤, docs/15 §三 · docs/17 §八).
 *
 * Pure constants and validation helpers. The store owns persistence, the
 * machine owns transitions; both import from here so status names and the
 * allowed edges exist in exactly one place.
 */

import { randomBytes } from 'node:crypto'

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3'

/** JSON value, matching the shape the host's tool schema inference produces. */
export type Json = string | number | boolean | null | Json[] | JsonObject

export interface JsonObject {
  [key: string]: Json
}

export type AssertionKind =
  | 'exit_code'
  | 'file_exists'
  | 'port_listening'
  | 'service_active'
  | 'unit_restarted'
  | 'http_status'
  | 'git_diff_matches'
  | 'page_contains'
  | 'mail_archived'
  | 'mail_sent'
  | 'mail_drafted'
  | 'calendar_event'

export type AssertionStatus = 'pending' | 'pass' | 'fail' | 'skipped'

/** Thread subscription relation (docs/15 §9.1, AR35–AR37). */
export type TaskThreadRelation = 'default_owner' | 'anchor'

export type ThreadReleaseReason = 'handback' | 'stopped' | 'superseded' | 'failed'

export type TaskInputStatus = 'pending' | 'delivered' | 'read' | 'returned'

/** Event types written by ⑤. `task.completed` is the success terminal (15 §三). */
export type TaskEventType =
  | 'task.created'
  | 'task.started'
  | 'task.resumed'
  | 'task.waiting_approval'
  | 'task.waiting_input'
  | 'task.input_requested'
  | 'task.paused'
  | 'task.retried'
  | 'task.deferred'
  | 'task.snapshot'
  | 'task.checkpoint'
  | 'task.rollback'
  | 'task.woken'
  | 'task.steered'
  | 'task.verified'
  | 'task.merge'
  | 'task.receipt'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'

/** B4-b isolation unit. Decided when the task is created/claimed, never by the model. */
export type IsolationMode = 'serial' | 'worktree'
export type MergeState = 'none' | 'pending' | 'merged' | 'conflict' | 'abandoned'
export type PrepareState = 'none' | 'running' | 'done' | 'failed'

export interface Task {
  id: string
  projectId: string | null
  conversationId: string | null
  sessionId: string | null
  startCursor: string | null
  intent: string
  /** Slice CH (O1): expert adapter chosen for this task; null = route at execution time. */
  expert?: string | null
  riskLevel: RiskLevel
  /**
   * L2: the level a human approved for this task; null/undefined means no
   * tool-level exemption. Written only by `resumeFromApproval` and cleared by
   * any intent change or new round.
   */
  approvedLevel?: RiskLevel | null
  status: TaskStatus
  plan: Json | null
  attempt: number
  maxAttempts: number
  leaseOwner: string | null
  leaseExpiresAt: string | null
  correlationId: string
  round: number
  /** Message that started the task; anchor fallback in `v_task_anchors`. */
  originMsgId: string | null
  /** Short unguessable routing hint (15 §9.2); never an authorization input. */
  taskRef: string | null
  /** B4-b: `serial` (workspace root) or `worktree` (one git worktree per task). */
  isolation: IsolationMode
  worktreePath: string | null
  baseCommit: string | null
  branch: string | null
  mergeState: MergeState
  prepareState: PrepareState
  preparedAt: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Slice BK (I5): cumulative model usage across attempts; null = unrecorded. */
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
}

export interface TaskEvent {
  id: string
  taskId: string
  seq: number
  type: TaskEventType
  payload: Json | null
  createdAt: string
}

export interface TaskAssertion {
  id: string
  taskId: string
  kind: AssertionKind
  /** Parameters only; `kind` lives in its own column. */
  spec: JsonObject
  status: AssertionStatus
  evidence: Json | null
  checkedAt: string | null
}

export interface Receipt {
  id: string
  taskId: string
  round: number | null
  summary: string
  evidenceLocator: string | null
  externalMsgId: string | null
  deliveredAt: string | null
  createdAt: string
}

/**
 * Slice AP: a result already produced on the same thread. Only the fields the
 * executor needs to build context — which task, when, and what it reported.
 */
export interface ThreadResult {
  taskId: string
  taskRef: string | null
  finishedAt: string
  summary: string
}

/** One live or released subscription of a task to a thread (15 §9.1). */
export interface TaskThread {
  id: string
  taskId: string
  threadId: string
  relation: TaskThreadRelation
  anchorMsgId: string | null
  createdAt: string
  releasedAt: string | null
  releaseReason: ThreadReleaseReason | null
}

/** One inbound message queued for a task; the body is never copied (AR2). */
export interface TaskInput {
  id: string
  taskId: string
  inboxId: string
  round: number
  status: TaskInputStatus
  deliveredAt: string | null
  readAt: string | null
  errorCode: string | null
  createdAt: string
}

/**
 * One step boundary of a task (13 §3.4). Writes made while a checkpoint is open
 * carry its id in `file_preimages.checkpoint_id`, so a failed step can be undone
 * without rewinding the steps that already succeeded.
 */
export interface TaskCheckpoint {
  id: string
  taskId: string
  /** 1-based order inside the task. */
  seq: number
  label: string | null
  status: 'open' | 'committed' | 'aborted'
  createdAt: string
  closedAt: string | null
}

export interface ThreadOccupancy {
  defaultOwnerTaskId: string | null
  live: string[]
  wakeable: string[]
}

export type TaskErrorCode =
  | 'invalid-task'
  | 'invalid-transition'
  | 'invalid-assertion'
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'criteria-required'
  | 'rollback-failed'
  | 'verification-failed'
  | 'verification-incomplete'
  | 'transient'
  | 'unknown'

export class TaskError extends Error {
  constructor(readonly code: TaskErrorCode, message: string) {
    super(message)
    this.name = 'TaskError'
  }
}

export const TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled']

export const RISK_LEVELS: readonly RiskLevel[] = ['R0', 'R1', 'R2', 'R3']

export const ASSERTION_KINDS: readonly AssertionKind[] = [
  'exit_code',
  'file_exists',
  'port_listening',
  'service_active',
  'unit_restarted',
  'http_status',
  'git_diff_matches',
  'page_contains',
  'mail_archived',
  'mail_sent',
  'mail_drafted',
  'calendar_event',
]

/**
 * Allowed edges. Anything not listed is refused — the state machine is a
 * whitelist, not a blacklist (terminal states have no outgoing edge).
 *
 * `succeeded` still has no generic out-edge. The single controlled exception is
 * `wakeTask` (AR37): it re-queues a succeeded task (`round + 1`) only when the
 * task still holds a live thread subscription and the caller was re-verified.
 *
 * `waiting_approval → queued` is likewise a controlled out-edge, owned by
 * `resumeFromApproval` (Slice I): the worker only claims `queued`, so an
 * approval re-queues the task instead of forcing it into `running`.
 */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'cancelled'],
  // `running → queued` is the retry edge (13 §3.3): only transient port errors
  // may re-queue, and only while `attempt < max_attempts`.
  running: ['queued', 'waiting_approval', 'waiting_input', 'paused', 'succeeded', 'failed', 'cancelled'],
  waiting_approval: ['running', 'paused', 'failed', 'cancelled'],
  // `waiting_input → queued` is the owner's answer edge (Slice AR): only
  // `steerTask` may take it, so the worker can re-claim after a supplement.
  waiting_input: ['running', 'queued', 'paused', 'failed', 'cancelled'],
  // `paused → queued` is the owner resume edge (B3 v2): `resumeTask` re-queues
  // a watchdog-paused task so the worker can claim it from the top.
  paused: ['running', 'queued', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** R2+ needs executable success criteria (13 §3.1, 17 §8.7). */
export function requiresCriteria(riskLevel: RiskLevel): boolean {
  return riskLevel === 'R2' || riskLevel === 'R3'
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_STATUSES.includes(to)) {
    throw new TaskError('invalid-transition', `unknown status ${JSON.stringify(to)}`)
  }
  if (isTerminal(from)) {
    throw new TaskError('invalid-transition', `${from} is terminal; no transition to ${to}`)
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new TaskError(
      'invalid-transition',
      `cannot move from ${from} to ${to}; allowed: ${ALLOWED_TRANSITIONS[from].join(' / ') || 'none'}`,
    )
  }
}

/**
 * `merge_state` edges (15 §10.5). Unlike task status this is a separate,
 * post-terminal dimension: a succeeded task is only "branch ready", and a
 * failed merge must not silently overwrite or disappear.
 */
export const ALLOWED_MERGE_TRANSITIONS: Record<MergeState, readonly MergeState[]> = {
  none: ['pending', 'abandoned'],
  pending: ['merged', 'conflict', 'abandoned'],
  conflict: ['pending', 'abandoned'],
  merged: [],
  abandoned: [],
}

export function assertMergeTransition(from: MergeState, to: MergeState): void {
  if (from === to) return
  if (!ALLOWED_MERGE_TRANSITIONS[from].includes(to)) {
    throw new TaskError(
      'invalid-task',
      `cannot move merge_state from ${from} to ${to}; allowed: ${ALLOWED_MERGE_TRANSITIONS[from].join(' / ') || 'none'}`,
    )
  }
}

export function eventTypeFor(from: TaskStatus, to: TaskStatus): TaskEventType {
  if (to === 'running') return from === 'queued' ? 'task.started' : 'task.resumed'
  if (to === 'queued') return 'task.retried'
  if (to === 'succeeded') return 'task.completed'
  if (to === 'failed') return 'task.failed'
  if (to === 'cancelled') return 'task.cancelled'
  if (to === 'waiting_approval') return 'task.waiting_approval'
  if (to === 'waiting_input') return 'task.waiting_input'
  return 'task.paused'
}

/** UUIDv7 (time-ordered) without pulling another dependency. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16)
  const ts = BigInt(now)
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
