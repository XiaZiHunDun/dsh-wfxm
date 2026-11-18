/**
 * Inbound ingest: admission → dedup → thread anchor → triage → route.
 *
 * Order is fixed by docs/11 §5.3 and §13.3: an unpaired identity is rejected
 * before triage, an approval answer / structured control command bypasses the
 * model entirely, and a message that hits a task anchor is delivered to that
 * task instead of the foreground orchestrator.
 *
 * Module ① never reads ⑤'s tables: anchors come from the read-only view
 * `v_task_anchors` (docs/15 §9.5), and delivery to a task is left to ⑤ (the
 * result carries the target; this slice records the disposition only).
 */

import {
  type Actor,
  type InboxItem,
  type InboxKind,
  type Json,
  type JsonObject,
  type RouteDecision,
  type ThreadRecord,
} from './model.js'
import type { GatewayStore } from './store.js'
import {
  parseCardAction,
  type ApprovalAnswerOutcome,
  type ApprovalAnswerPort,
  type ApprovalAnswerReport,
  type ApprovalDetailOutcome,
  type ApprovalDetailPort,
} from './approval.js'
import { relayToTask, type TaskRelayPort, type TaskRelayReport } from './task-relay.js'
import { controlTask, type TaskControlPort, type TaskControlReport } from './task-control.js'
import { wakeTask, type GrantCheckPort, type TaskWakePort, type WakeReport } from './wake.js'
import {
  listProjectChoices,
  parseProjectCommand,
  resolveProject,
  type ProjectChoice,
  type ProjectLookupPort,
  type ProjectResolution,
} from './project-resolver.js'
import { inboundText } from './text.js'

export type TriageIntent = 'approval_answer' | 'control' | 'event' | 'chat' | 'command'

export const TRIAGE_INTENTS: readonly TriageIntent[] = [
  'approval_answer',
  'control',
  'event',
  'chat',
  'command',
]

/** Structured control commands that bypass the model (11 §5.3). */
export const CONTROL_COMMANDS: readonly string[] = ['stop', 'pause', 'resume', 'rollback', 'status']

/**
 * Owner-facing aliases for a bare chat command. Chinese is the product language,
 * and the stall notice tells the owner to reply `停止 <ref>` — without these the
 * message would be routed as a new task instead of a control frame.
 */
const CONTROL_ALIASES: Record<string, string> = {
  stop: 'stop',
  pause: 'pause',
  resume: 'resume',
  rollback: 'rollback',
  status: 'status',
  停止: 'stop',
  暂停: 'pause',
  继续: 'resume',
  恢复: 'resume',
  回滚: 'rollback',
  状态: 'status',
}

export type BypassReason =
  | 'duplicate'
  | 'unpaired'
  | 'pairing'
  | 'approval'
  | 'control'
  | 'project'
  | 'system-message'
  | 'task-anchor'
  | 'ambiguous-task'
  | 'ambiguous-project'

export type RouteTarget =
  | { kind: 'orchestrator'; sessionKind: 'orchestrator' }
  | { kind: 'task'; taskId: string }
  | { kind: 'approval' }
  | { kind: 'control'; command: string; taskId?: string }
  | {
    kind: 'project'
    command: 'use' | 'list'
    projectId: string | null
    name: string | null
    candidates: ProjectChoice[]
  }
  | { kind: 'ask'; candidates: string[] }
  | { kind: 'none' }

export interface FollowUpResolution {
  /** False when ⑤ has not created `v_task_anchors` yet; callers fail soft. */
  available: boolean
  taskId: string | null
  status: string | null
  round: number | null
  /** Frozen project of the anchored task (⑤ v4); null when ⑤ has not recorded one. */
  projectId: string | null
  /** More than one live / wakeable task in the chat: ask which one. */
  ambiguous: boolean
  candidates: string[]
  matchedBy: 'anchor' | 'single-live' | 'single-wakeable' | null
  /** A finished task may only be woken after Grant re-verification (AR37). */
  requiresGrantCheck: boolean
}

export interface FollowUpQuery {
  channelId: string
  chatId: string
  threadId?: string | null
  replyToMsgId?: string | null
  /** Anchoring a paused task is only correct for structured control frames. */
  includePaused?: boolean
}

export interface IngestInboundInput {
  channelId: string
  msgId: string
  /** Channel identity (Feishu open_id); absent means unpaired. */
  externalUserId?: string | null
  kind?: InboxKind
  content: Json
  chatId?: string | null
  topicId?: string | null
  rootMsgId?: string | null
  replyToMsgId?: string | null
  projectId?: string | null
  now?: Date
}

/** A model-backed triage may return `null` to fall back to `defaultTriage`. */
export type TriageClassifier = (
  input: IngestInboundInput,
) => TriageIntent | null | Promise<TriageIntent | null>

export interface IngestDeps {
  store: GatewayStore
  classify?: TriageClassifier
  /** Host-composed relay onto ⑤'s module API; absent means routing only. */
  relay?: TaskRelayPort | null
  /** Host-composed control onto ⑤'s `task_control`; absent means routing only. */
  control?: TaskControlPort | null
  /** Host-composed re-check onto ③'s `verify` (AR37); absent = never wake. */
  grantCheck?: GrantCheckPort | null
  /** Host-composed wake onto ⑤'s `wakeTask` (AR37); absent = never wake. */
  wake?: TaskWakePort | null
  /** Host-composed read onto ⑥'s project API (11 §5.3.1); absent means anchor-only. */
  project?: ProjectLookupPort | null
  /** Host-composed answer onto ③'s `approvals.answer`; absent = approvals unwired. */
  approval?: ApprovalAnswerPort | null
  /** Host-composed read onto ③/⑤ for the read-only "details" button. */
  approvalDetails?: ApprovalDetailPort | null
  /**
   * Slice AO.1: identical plain-text messages in one thread inside this window
   * are treated as duplicates (default 60s, `0` disables). Guards against a
   * client retry/double-send being mistaken for a supplement and aborting the
   * live attempt.
   */
  duplicateWindowMs?: number
}

export interface IngestResult {
  inbox: InboxItem
  duplicate: boolean
  actor: Actor | null
  thread: ThreadRecord | null
  intent: TriageIntent | null
  target: RouteTarget
  bypassReason: BypassReason | null
  disposition: RouteDecision | null
  followUp: FollowUpResolution | null
  /** Present when the message hit a task anchor (delivery to ⑤). */
  relay?: TaskRelayReport | null
  /** Present for a structured control command (stop / pause / resume / status). */
  control?: TaskControlReport | null
  /** Present when a finished task was considered for a wake (AR37). */
  wake?: WakeReport | null
  /** Which project this turn was bound to, and how (11 §5.3.1). */
  project?: ProjectResolution | null
  /** Present for an approval card action, whether or not ③ accepted it. */
  approval?: ApprovalAnswerOutcome | null
  /** Present for the read-only "details" button; never a decision. */
  details?: ApprovalDetailOutcome | null
  /** `triage-unavailable` / `relay-unavailable` / `control-unavailable` / `wake-unavailable` / `approval-unavailable`. */
  error:
    | 'triage-unavailable'
    | 'relay-unavailable'
    | 'control-unavailable'
    | 'wake-unavailable'
    | 'approval-unavailable'
    | null
}

const LIVE_STATUSES: readonly string[] = [
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  // `paused` only anchors when the inbound *is* a control frame: there is no chat
  // entry to resume/stop one, so a plain message must start a new task instead of
  // queueing into a task that can never run again (2026-11-13 实测).
  'paused',
]

const WAKEABLE_STATUSES: readonly string[] = ['succeeded']

function isJsonObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function controlCommand(content: Json): string | null {
  if (!isJsonObject(content)) return null
  for (const key of ['control', 'command']) {
    const value = content[key]
    if (typeof value === 'string' && CONTROL_COMMANDS.includes(value)) return value
  }
  // A bare chat command (`停止 <ref>` / `stop <ref>`): the whole message must be
  // the command plus an optional task ref, so a sentence that merely mentions
  // 停止 still goes to the model instead of stopping something by accident.
  const text = content.text
  if (typeof text === 'string') {
    // English may stand alone (`stop`); Chinese must carry a ref, because words
    // like 继续 are ordinary chat ("继续") and must not hijack the conversation.
    const english = /^\s*(stop|pause|resume|rollback|status)(?:\s+[A-Za-z0-9_-]{4,})?\s*$/i.exec(text)
    const chinese = /^\s*(停止|暂停|继续|恢复|回滚|状态)\s+[A-Za-z0-9_-]{4,}\s*$/.exec(text)
    const token = english?.[1] ?? chinese?.[1]
    if (token !== undefined) {
      const canonical = CONTROL_ALIASES[token] ?? CONTROL_ALIASES[token.toLowerCase()]
      if (canonical !== undefined) return canonical
    }
  }
  return null
}

/** `rollback` only: the step to undo; absent = whole task. */
function controlCheckpointId(content: Json): string | null {
  if (!isJsonObject(content)) return null
  const value = content.checkpointId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function textOf(content: Json): string | null {
  if (!isJsonObject(content)) return null
  const text = content.text
  return typeof text === 'string' ? text : null
}

/**
 * docs/14 §四 pairing handshake: an unpaired `/bind <code>` message consumes a
 * one-time code and binds the identity. Returns the bound actor on success;
 * `null` for "not a bind attempt" and for any failure (the caller then falls
 * through to the silent reject — no oracle about the pairing system).
 */
function tryConsumePairingCode(store: GatewayStore, input: IngestInboundInput): Actor | null {
  if (input.externalUserId === undefined || input.externalUserId === null) return null
  const text = textOf(input.content)
  if (text === null) return null
  const match = /^\s*\/bind\s+([A-Za-z0-9][A-Za-z0-9-]*)\s*$/.exec(text)
  if (match === null || match[1] === undefined) return null
  try {
    const { actor } = store.consumePairingCode({
      code: match[1],
      channelId: input.channelId,
      externalUserId: input.externalUserId,
    })
    return actor
  } catch {
    return null
  }
}

/** Deterministic, protocol-agnostic triage (11 §5.3); a model may override it. */
export function defaultTriage(input: IngestInboundInput): TriageIntent {
  if (input.kind === 'card_action') return 'approval_answer'
  if (input.kind === 'control') return 'control'
  if (isJsonObject(input.content)) {
    if (typeof input.content.event === 'string' || input.content.type === 'event') return 'event'
    if (controlCommand(input.content) !== null) return 'control'
    const text = input.content.text
    if (typeof text === 'string' && text.trim().startsWith('/')) return 'command'
  }
  return 'chat'
}

interface AnchorAggregate {
  taskId: string
  status: string | null
  round: number | null
  projectId: string | null
  anchors: Set<string>
}

/**
 * Resolve a follow-up against the live task anchors of a chat (13 §3.3).
 * Anchors beat "the only live task"; without an anchor a single live task is
 * still unambiguous, two or more require asking. Nothing is inferred from the
 * text itself — no semantic guessing (13 §3.3 硬规则).
 */
export function resolveFollowUp(
  store: GatewayStore,
  query: FollowUpQuery,
): FollowUpResolution {
  if (!store.hasTaskAnchorView()) {
    return {
      available: false,
      taskId: null,
      status: null,
      round: null,
      projectId: null,
      ambiguous: false,
      candidates: [],
      matchedBy: null,
      requiresGrantCheck: false,
    }
  }

  const threadIds: string[] = []
  if (query.threadId !== undefined && query.threadId !== null && query.threadId !== '') {
    threadIds.push(query.threadId)
  }
  for (const thread of store.listThreads({
    channelId: query.channelId,
    chatId: query.chatId,
    limit: 200,
  })) {
    if (!threadIds.includes(thread.id)) threadIds.push(thread.id)
  }

  const anchors = new Map<string, AnchorAggregate>()
  for (const threadId of threadIds) {
    for (const anchor of store.listTaskAnchors(threadId)) {
      const existing = anchors.get(anchor.taskId)
      if (existing === undefined) {
        anchors.set(anchor.taskId, {
          taskId: anchor.taskId,
          status: anchor.status,
          round: anchor.round,
          projectId: anchor.projectId ?? null,
          anchors: new Set(anchor.anchorMsgId === null ? [] : [anchor.anchorMsgId]),
        })
      } else if (anchor.anchorMsgId !== null) {
        existing.anchors.add(anchor.anchorMsgId)
        if (existing.projectId === null) existing.projectId = anchor.projectId ?? null
      }
    }
  }

  const all = [...anchors.values()]

  if (query.replyToMsgId !== undefined && query.replyToMsgId !== null && query.replyToMsgId !== '') {
    const hit = all.find((entry) => entry.anchors.has(query.replyToMsgId as string))
    if (hit !== undefined) {
      return {
        available: true,
        taskId: hit.taskId,
        status: hit.status,
        round: hit.round,
        projectId: hit.projectId,
        ambiguous: false,
        candidates: [hit.taskId],
        matchedBy: 'anchor',
        requiresGrantCheck: hit.status !== null && WAKEABLE_STATUSES.includes(hit.status),
      }
    }
  }

  const live = all.filter((entry) => entry.status !== null
    && LIVE_STATUSES.includes(entry.status)
    && (entry.status !== 'paused' || query.includePaused === true))
  if (live.length === 1) {
    return {
      available: true,
      taskId: live[0].taskId,
      status: live[0].status,
      round: live[0].round,
      projectId: live[0].projectId,
      ambiguous: false,
      candidates: [live[0].taskId],
      matchedBy: 'single-live',
      requiresGrantCheck: false,
    }
  }
  if (live.length > 1) {
    return {
      available: true,
      taskId: null,
      status: null,
      round: null,
      projectId: null,
      ambiguous: true,
      candidates: live.map((entry) => entry.taskId),
      matchedBy: null,
      requiresGrantCheck: false,
    }
  }

  const wakeable = all.filter(
    (entry) => entry.status !== null && WAKEABLE_STATUSES.includes(entry.status),
  )
  if (wakeable.length === 1) {
    return {
      available: true,
      taskId: wakeable[0].taskId,
      status: wakeable[0].status,
      round: wakeable[0].round,
      projectId: wakeable[0].projectId,
      ambiguous: false,
      candidates: [wakeable[0].taskId],
      matchedBy: 'single-wakeable',
      requiresGrantCheck: true,
    }
  }
  if (wakeable.length > 1) {
    return {
      available: true,
      taskId: null,
      status: null,
      round: null,
      projectId: null,
      ambiguous: true,
      candidates: wakeable.map((entry) => entry.taskId),
      matchedBy: null,
      requiresGrantCheck: false,
    }
  }

  return {
    available: true,
    taskId: null,
    status: null,
    round: null,
    projectId: null,
    ambiguous: false,
    candidates: [],
    matchedBy: null,
    requiresGrantCheck: false,
  }
}

const ORCHESTRATOR: RouteTarget = { kind: 'orchestrator', sessionKind: 'orchestrator' }

const DEFAULT_DUPLICATE_WINDOW_MS = 60_000

/**
 * True when this message repeats the immediately previous user message in the
 * same thread inside the window. The current row is already stored, so history
 * ends with it; compare the last two user turns.
 */
function repeatsPrevious(
  store: GatewayStore,
  threadId: string | null,
  text: string | null,
  now: Date,
  windowMs: number,
): boolean {
  if (threadId === null || text === null || text === '' || windowMs <= 0) return false
  const users = store.threadHistory(threadId, 6).filter((turn) => turn.role === 'user')
  if (users.length < 2) return false
  const last = users[users.length - 1]
  const previous = users[users.length - 2]
  if (last.text !== text || previous.text !== text) return false
  const delta = now.getTime() - Date.parse(previous.at)
  return Number.isFinite(delta) && delta >= 0 && delta <= windowMs
}

function lastDecision(store: GatewayStore, triggerId: string): RouteDecision | null {
  const decisions = store.listRouteDecisions({ triggerId })
  return decisions.length === 0 ? null : decisions[decisions.length - 1]
}

function duplicateResult(store: GatewayStore, inbox: InboxItem): IngestResult {
  return {
    inbox,
    duplicate: true,
    actor: inbox.actorId === null ? null : store.getActor(inbox.actorId),
    thread: inbox.threadId === null ? null : store.getThread(inbox.threadId),
    intent: null,
    target: { kind: 'none' },
    bypassReason: 'duplicate',
    disposition: lastDecision(store, inbox.id),
    followUp: null,
    error: null,
  }
}

/**
 * Normalize one inbound message. The row is stored before anything else so a
 * replay can never be processed twice (AR28) and an unpaired identity is still
 * auditable.
 */
export async function ingestInbound(
  deps: IngestDeps,
  input: IngestInboundInput,
): Promise<IngestResult> {
  const { store } = deps
  const now = input.now ?? new Date()

  const existing = store.findInbox(input.channelId, input.msgId)
  if (existing !== null) return duplicateResult(store, existing)

  const resolved = input.externalUserId === undefined || input.externalUserId === null
    ? null
    : store.resolveActor(input.channelId, input.externalUserId)

  // Unpaired: silent reject, but the row and the reason are kept (11 §5.3).
  if (resolved === null) {
    const stored = store.acceptInbound({
      channelId: input.channelId,
      msgId: input.msgId,
      ...input.kind === undefined ? {} : { kind: input.kind },
      actorId: null,
      content: input.content,
      chatId: input.chatId ?? null,
      threadId: null,
      replyToMsgId: input.replyToMsgId ?? null,
    })
    if (stored.duplicate) return duplicateResult(store, stored.inbox)

    // docs/14 §四: an unpaired identity may claim a one-time pairing code with
    // `/bind <code>`. Any failure (unknown / expired / consumed code) falls
    // through to the same silent reject — the channel must not learn whether
    // a pairing system exists.
    const pairedActor = tryConsumePairingCode(store, input)
    if (pairedActor !== null) {
      const done = store.updateInboxStatus(stored.inbox.id, 'done')
      const disposition = store.appendRouteDecision({
        triggerId: done.id,
        action: 'accept',
        // Never include the code itself; it lives only in the inbox row (audit).
        reason: `pairing code consumed; identity bound to actor ${pairedActor.id}`,
        threadId: null,
      })
      return {
        inbox: done,
        duplicate: false,
        actor: pairedActor,
        thread: null,
        intent: null,
        target: { kind: 'none' },
        bypassReason: 'pairing',
        disposition,
        followUp: null,
        error: null,
      }
    }

    const rejected = store.updateInboxStatus(stored.inbox.id, 'rejected', 'unpaired')
    const disposition = store.appendRouteDecision({
      triggerId: rejected.id,
      action: 'ignore',
      reason: 'unpaired identity: silent reject (audit only)',
      threadId: null,
    })
    return {
      inbox: rejected,
      duplicate: false,
      actor: null,
      thread: null,
      intent: null,
      target: { kind: 'none' },
      bypassReason: 'unpaired',
      disposition,
      followUp: null,
      error: null,
    }
  }

  const thread = input.chatId === undefined || input.chatId === null
    ? null
    : store.resolveThread({
      channelId: input.channelId,
      chatId: input.chatId,
      topicId: input.topicId ?? null,
      rootMsgId: input.rootMsgId ?? null,
      projectId: input.projectId ?? null,
      now,
    })

  const stored = store.acceptInbound({
    channelId: input.channelId,
    msgId: input.msgId,
    ...input.kind === undefined ? {} : { kind: input.kind },
    actorId: resolved.actor.id,
    content: input.content,
    chatId: input.chatId ?? null,
    threadId: thread?.id ?? null,
    replyToMsgId: input.replyToMsgId ?? null,
  })
  if (stored.duplicate) return duplicateResult(store, stored.inbox)
  const inbox = stored.inbox
  const threadId = thread?.id ?? null

  // Slice AO.1: a client retry (new msg id, same text) must not be mistaken for
  // a supplement — that would abort a healthy running attempt. Only plain
  // messages can be duplicates; controls and card actions are always handled.
  const duplicateWindowMs = deps.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS
  const messageText = (input.kind ?? 'message') === 'message' ? inboundText(input.content) : null
  if (repeatsPrevious(store, threadId, messageText, now, duplicateWindowMs)) {
    const disposition = store.appendRouteDecision({
      triggerId: inbox.id,
      action: 'ignore',
      reason: `duplicate content within ${Math.round(duplicateWindowMs / 1000)}s`,
      threadId,
    })
    return {
      inbox: store.updateInboxStatus(inbox.id, 'done'),
      duplicate: true,
      actor: resolved.actor,
      thread,
      intent: null,
      target: { kind: 'none' },
      bypassReason: 'duplicate',
      disposition,
      followUp: null,
      error: null,
    }
  }

  let intent: TriageIntent
  try {
    const classified = deps.classify === undefined ? null : await deps.classify(input)
    intent = classified ?? defaultTriage(input)
  } catch {
    // Fail-closed: no execution, row stays `accepted` for a later retry.
    return {
      inbox,
      duplicate: false,
      actor: resolved.actor,
      thread,
      intent: null,
      target: { kind: 'none' },
      bypassReason: null,
      disposition: null,
      followUp: null,
      error: 'triage-unavailable',
    }
  }

  // 1. Approval answer: bypass the model, ③ owns consumption of the nonce.
  // The card is a view (AR10): only the button value is trusted, and only ③
  // may decide whether the nonce is still valid.
  if (intent === 'approval_answer') {
    const parsed = parseCardAction(input.content)
    const action = parsed.action

    // Not a decision (malformed value): audit and leave the approval untouched —
    // never consume a nonce by accident.
    if (action === null) {
      const disposition = store.appendRouteDecision({
        triggerId: inbox.id,
        action: 'ignore',
        reason: `card action ignored: ${parsed.problem}`,
        threadId,
      })
      return {
        inbox: store.updateInboxStatus(inbox.id, 'done'),
        duplicate: false,
        actor: resolved.actor,
        thread,
        intent,
        target: { kind: 'approval' },
        bypassReason: 'approval',
        disposition,
        followUp: null,
        approval: null,
        error: null,
      }
    }

    // Read-only "details" (Slice L): ③ is read, never answered, so status and
    // nonce are untouched. A missing store is loud in the disposition, not a
    // silent no-op.
    if (action.decision === 'details') {
      let details: ApprovalDetailOutcome
      if (deps.approvalDetails === undefined || deps.approvalDetails === null) {
        details = { ok: false, code: 'approval-unavailable', approvalId: action.approvalId }
      } else {
        try {
          const report = deps.approvalDetails.details({
            approvalId: action.approvalId,
            actorId: resolved.actor.id,
          })
          details = { ...report, approvalId: action.approvalId }
        } catch {
          details = { ok: false, code: 'approval-unavailable', approvalId: action.approvalId }
        }
      }
      const disposition = store.appendRouteDecision({
        triggerId: inbox.id,
        action: 'answer',
        reason: details.ok
          ? `approval ${action.approvalId} details shown (read-only)`
          : `approval ${action.approvalId} details unavailable: ${details.code}`,
        threadId,
      })
      return {
        inbox: store.updateInboxStatus(inbox.id, 'done'),
        duplicate: false,
        actor: resolved.actor,
        thread,
        intent,
        target: { kind: 'approval' },
        bypassReason: 'approval',
        disposition,
        followUp: null,
        approval: null,
        details,
        error: null,
      }
    }

    // The card's `confirm` button is ③'s `confirmed` decision.
    const decision: 'approved' | 'rejected' | 'confirmed'
      = action.decision === 'confirm' ? 'confirmed' : action.decision

    let report: ApprovalAnswerReport | null = null
    if (deps.approval !== undefined && deps.approval !== null) {
      try {
        report = deps.approval.answer({
          approvalId: action.approvalId,
          decision,
          actorId: resolved.actor.id,
          nonce: action.nonce,
        })
      } catch {
        report = null
      }
    }

    // AR13: no store (or a throwing one) is loud, never a silent no-op.
    if (report === null) {
      const failed = store.updateInboxStatus(inbox.id, 'failed', 'approval-unavailable')
      const disposition = store.appendRouteDecision({
        triggerId: failed.id,
        action: 'answer',
        reason: `approval ${action.approvalId} ${decision} not applied: approval store unavailable`,
        threadId,
      })
      return {
        inbox: failed,
        duplicate: false,
        actor: resolved.actor,
        thread,
        intent,
        target: { kind: 'approval' },
        bypassReason: 'approval',
        disposition,
        followUp: null,
        approval: {
          approvalId: action.approvalId,
          decision,
          ok: false,
          code: 'approval-unavailable',
        },
        error: 'approval-unavailable',
      }
    }

    const ok = report.ok === true
    const code = typeof report.code === 'string' && report.code.length > 0
      ? report.code
      : ok ? 'ok' : 'unknown'
    // R3's first "approve" click is a recorded, expected intermediate state:
    // the inbox is done (not failed) and the host renders the confirmation card.
    const confirmRequired = !ok && code === 'confirm-required'
    const settled = ok || confirmRequired
      ? store.updateInboxStatus(inbox.id, 'done')
      : store.updateInboxStatus(inbox.id, 'failed', code)
    const disposition = store.appendRouteDecision({
      triggerId: settled.id,
      action: 'answer',
      reason: ok
        ? `approval ${action.approvalId} ${decision} accepted (${report.status ?? 'decided'})`
        : confirmRequired
          ? `approval ${action.approvalId} ${decision} staged: second confirmation required`
          : `approval ${action.approvalId} ${decision} refused: ${code}`,
      threadId,
    })
    return {
      inbox: settled,
      duplicate: false,
      actor: resolved.actor,
      thread,
      intent,
      target: { kind: 'approval' },
      bypassReason: 'approval',
      disposition,
      followUp: null,
      approval: {
        approvalId: action.approvalId,
        decision,
        ok,
        code,
        ...report.status === undefined ? {} : { status: report.status },
        ...report.taskId === undefined ? {} : { taskId: report.taskId },
        ...report.taskStatus === undefined ? {} : { taskStatus: report.taskStatus },
        ...report.stage === undefined ? {} : { stage: report.stage },
        ...report.nonce === undefined ? {} : { nonce: report.nonce },
      },
      error: null,
    }
  }

  // 1.5 Explicit project commands (`/use <alias>` / `/projects`): bypass the
  // model and, on a hit, move this chat's sticky project (11 §5.3.1).
  if (intent === 'command') {
    const command = parseProjectCommand(textOf(input.content))
    if (command !== null) {
      const resolution: ProjectResolution = command.kind === 'list'
        ? {
          available: deps.project !== undefined && deps.project !== null,
          projectId: null,
          name: null,
          matchedBy: 'asked',
          ambiguous: true,
          candidates: listProjectChoices(deps.project ?? null),
        }
        : resolveProject({ port: deps.project ?? null, explicitAlias: command.alias })

      const chatId = thread?.chatId ?? input.chatId ?? null
      if (command.kind === 'use' && resolution.projectId !== null && chatId !== null) {
        // Sticky per chat; never invents a session id if the chat has no route.
        store.setSessionProject({
          channelId: input.channelId,
          chatId,
          sessionKind: 'orchestrator',
          projectId: resolution.projectId,
        })
      }

      const reason = command.kind === 'list'
        ? `explicit project list: ${resolution.candidates.length} candidates`
        : resolution.projectId === null
          ? `explicit switch to an unknown alias; asked with ${resolution.candidates.length} candidates`
          : `explicit project switch to ${resolution.name ?? resolution.projectId}`
      const disposition = store.appendRouteDecision({
        triggerId: inbox.id,
        action: resolution.projectId === null ? 'ask' : 'ack',
        reason,
        threadId,
        projectId: resolution.projectId,
        projectMatchedBy: resolution.matchedBy,
      })
      return {
        inbox: store.updateInboxStatus(inbox.id, 'triaged'),
        duplicate: false,
        actor: resolved.actor,
        thread,
        intent,
        target: {
          kind: 'project',
          command: command.kind,
          projectId: resolution.projectId,
          name: resolution.name,
          candidates: resolution.candidates,
        },
        bypassReason: 'project',
        disposition,
        followUp: null,
        project: resolution,
        error: null,
      }
    }
  }

  // 2. Structured control command: stop / pause / resume / rollback / status.
  if (intent === 'control') {
    const command = controlCommand(input.content) ?? 'status'
    const followUp = thread === null
      ? null
      : resolveFollowUp(store, {
        channelId: input.channelId,
        chatId: thread.chatId,
        threadId: thread.id,
        replyToMsgId: input.replyToMsgId ?? null,
        includePaused: true,
      })
    const targetTaskId = followUp !== null ? followUp.taskId : null
    const live = followUp !== null
      && followUp.status !== null
      && LIVE_STATUSES.includes(followUp.status)

    let control: TaskControlReport | null = null
    if (targetTaskId !== null) {
      try {
        control = controlTask(deps.control ?? null, {
          command,
          taskId: targetTaskId,
          live,
          status: followUp?.status ?? null,
          checkpointId: controlCheckpointId(input.content),
        })
      } catch {
        // A control command that cannot reach ⑤ is not a silent no-op.
        const failed = store.updateInboxStatus(inbox.id, 'failed', 'control-unavailable')
        const disposition = store.appendRouteDecision({
          triggerId: inbox.id,
          action: command === 'stop' ? 'stop' : 'ack',
          reason: `control ${command} could not reach the task runtime; inbox marked failed`,
          threadId,
          targetTaskId,
        })
        return {
          inbox: failed,
          duplicate: false,
          actor: resolved.actor,
          thread,
          intent,
          target: { kind: 'control', command, taskId: targetTaskId },
          bypassReason: 'control',
          disposition,
          followUp,
          control: null,
          error: 'control-unavailable',
        }
      }
    }

    const reason = targetTaskId === null
      ? `structured control command bypass: ${command} (no anchored task)`
      : `control ${command} on ${targetTaskId}: ${control?.executed === true
        ? `executed (${control.action})`
        : control?.skipped ?? 'not executed'}`
    const disposition = store.appendRouteDecision({
      triggerId: inbox.id,
      action: command === 'stop' ? 'stop' : 'ack',
      reason,
      threadId,
      ...targetTaskId === null ? {} : { targetTaskId },
    })
    return {
      inbox: store.updateInboxStatus(inbox.id, 'triaged'),
      duplicate: false,
      actor: resolved.actor,
      thread,
      intent,
      target: {
        kind: 'control',
        command,
        ...targetTaskId === null ? {} : { taskId: targetTaskId },
      },
      bypassReason: 'control',
      disposition,
      followUp,
      control,
      error: null,
    }
  }

  // 3. Bot / CI identity: never wakes a task, never enters the front stage.
  if (resolved.actor.kind === 'system') {
    const followUp = thread === null
      ? null
      : resolveFollowUp(store, {
        channelId: input.channelId,
        chatId: thread.chatId,
        threadId: thread.id,
        replyToMsgId: input.replyToMsgId ?? null,
      })
    const attached = followUp !== null && followUp.taskId !== null
    const disposition = store.appendRouteDecision({
      triggerId: inbox.id,
      action: attached ? 'attach' : 'ignore',
      reason: attached
        ? 'system message attached to a live task as context; never wakes it'
        : 'system message recorded only; never wakes a task',
      threadId,
      ...attached ? { targetTaskId: followUp.taskId } : {},
    })
    return {
      inbox: store.updateInboxStatus(inbox.id, 'triaged'),
      duplicate: false,
      actor: resolved.actor,
      thread,
      intent,
      target: attached ? { kind: 'task', taskId: followUp.taskId as string } : { kind: 'none' },
      bypassReason: 'system-message',
      disposition,
      followUp,
      error: null,
    }
  }

  // 4. Anchor resolution (13 §3.3), between dedup and triage.
  const followUp = thread === null
    ? null
    : resolveFollowUp(store, {
      channelId: input.channelId,
      chatId: thread.chatId,
      threadId: thread.id,
      replyToMsgId: input.replyToMsgId ?? null,
    })

  // 4.5 Project binding for this turn (11 §5.3.1): anchor → sticky → single → ask.
  const project = resolveProject({
    port: deps.project ?? null,
    anchorProjectId: followUp?.projectId ?? null,
    stickyProjectId: thread === null
      ? null
      : store.getSessionRoute(input.channelId, thread.chatId, 'orchestrator')?.projectId ?? null,
  })

  if (followUp !== null && followUp.taskId !== null && threadId !== null) {
    const taskId = followUp.taskId
    const live = followUp.status !== null && LIVE_STATUSES.includes(followUp.status)
    const wakeable = followUp.requiresGrantCheck

    // 4.6 AR37: a finished task may only be woken after ③ re-verifies the actor,
    // and the waking message must be deliverable. All three ports present is
    // what turns "attach only" into a real wake; otherwise we keep the marker.
    if (wakeable && deps.grantCheck != null && deps.wake != null && deps.relay != null) {
      let wake: WakeReport
      try {
        wake = wakeTask(
          { grant: deps.grantCheck, wake: deps.wake },
          {
            taskId,
            actorId: resolved.actor.id,
            reason: `anchored reply to a finished task (round ${followUp.round ?? '?'})`,
          },
        )
      } catch {
        const failed = store.updateInboxStatus(inbox.id, 'failed', 'wake-unavailable')
        const disposition = store.appendRouteDecision({
          triggerId: inbox.id,
          action: 'wake',
          reason: 'anchored to a finished task but the wake failed; inbox marked failed (AR37)',
          threadId,
          targetTaskId: taskId,
          projectId: project.projectId,
          projectMatchedBy: project.matchedBy,
        })
        return {
          inbox: failed,
          duplicate: false,
          actor: resolved.actor,
          thread,
          intent,
          target: { kind: 'task', taskId },
          bypassReason: 'task-anchor',
          disposition,
          followUp,
          relay: null,
          wake: null,
          project,
          error: 'wake-unavailable',
        }
      }

      // Re-verification failed (`revoked`, `not-found`, `scope-mismatch`, ...):
      // never attach, never enter the task. The reply is unowned and goes to the
      // foreground for triage instead of resurrecting a finished task (AR37).
      if (!wake.woken) {
        return {
          inbox: store.updateInboxStatus(inbox.id, 'routed'),
          duplicate: false,
          actor: resolved.actor,
          thread,
          intent,
          target: ORCHESTRATOR,
          bypassReason: null,
          disposition: null,
          followUp,
          wake,
          project,
          error: null,
        }
      }

      let relay: TaskRelayReport
      try {
        relay = relayToTask(deps.relay, {
          taskId,
          threadId,
          inboxId: inbox.id,
          replyToMsgId: input.replyToMsgId ?? null,
          matchedBy: followUp.matchedBy,
          live: true,
        })
      } catch {
        const failed = store.updateInboxStatus(inbox.id, 'failed', 'relay-unavailable')
        const disposition = store.appendRouteDecision({
          triggerId: inbox.id,
          action: 'wake',
          reason: 'task woken but the waking message could not be relayed; inbox marked failed',
          threadId,
          targetTaskId: taskId,
          projectId: project.projectId,
          projectMatchedBy: project.matchedBy,
        })
        return {
          inbox: failed,
          duplicate: false,
          actor: resolved.actor,
          thread,
          intent,
          target: { kind: 'task', taskId },
          bypassReason: 'task-anchor',
          disposition,
          followUp,
          relay: null,
          wake,
          project,
          error: 'relay-unavailable',
        }
      }

      const disposition = store.appendRouteDecision({
        triggerId: inbox.id,
        action: 'wake',
        reason: `Grant re-verification passed (AR37); woken into round ${wake.round ?? '?'} and the reply was queued`,
        threadId,
        targetTaskId: taskId,
        projectId: project.projectId,
        projectMatchedBy: project.matchedBy,
      })
      return {
        inbox: store.updateInboxStatus(inbox.id, 'triaged'),
        duplicate: false,
        actor: resolved.actor,
        thread,
        intent,
        target: { kind: 'task', taskId },
        bypassReason: 'task-anchor',
        disposition,
        followUp,
        relay,
        wake,
        project,
        error: null,
      }
    }

    if (live || wakeable) {
      let relay: TaskRelayReport
      try {
        relay = relayToTask(deps.relay ?? null, {
          taskId,
          threadId,
          inboxId: inbox.id,
          replyToMsgId: input.replyToMsgId ?? null,
          matchedBy: followUp.matchedBy,
          live,
        })
      } catch {
        // Delivery failed after the anchor decision: keep the reason and mark
        // the row failed instead of pretending the task received it.
        const failed = store.updateInboxStatus(inbox.id, 'failed', 'relay-unavailable')
        const disposition = store.appendRouteDecision({
          triggerId: inbox.id,
          action: 'attach',
          reason: 'anchored to a task but the task relay failed; inbox marked failed (15 §9.6)',
          threadId,
          targetTaskId: taskId,
          projectId: project.projectId,
          projectMatchedBy: project.matchedBy,
        })
        return {
          inbox: failed,
          duplicate: false,
          actor: resolved.actor,
          thread,
          intent,
          target: { kind: 'task', taskId },
          bypassReason: 'task-anchor',
          disposition,
          followUp,
          relay: null,
          project,
          error: 'relay-unavailable',
        }
      }
      const disposition = store.appendRouteDecision({
        triggerId: inbox.id,
        action: 'attach',
        reason: live
          ? `anchored to ${followUp.matchedBy ?? 'live'} task; delivered to its current round`
          : 'anchored to a finished task; Grant re-verification (AR37) required before wake',
        threadId,
        targetTaskId: taskId,
        projectId: project.projectId,
        projectMatchedBy: project.matchedBy,
      })
      return {
        inbox: store.updateInboxStatus(inbox.id, 'triaged'),
        duplicate: false,
        actor: resolved.actor,
        thread,
        intent,
        target: { kind: 'task', taskId },
        bypassReason: 'task-anchor',
        disposition,
        followUp,
        relay,
        project,
        error: null,
      }
    }
    // `failed` / `cancelled` / `paused`: no waking — fall through to triage.
  }

  // Task ambiguity is more actionable than project ambiguity: ask about the
  // task first (`followUp.ambiguous` is handled below).
  if (project.ambiguous && !(followUp !== null && followUp.ambiguous)) {
    const disposition = store.appendRouteDecision({
      triggerId: inbox.id,
      action: 'ask',
      reason: project.available
        ? `ambiguous project: ${project.candidates.length} candidates, no anchor or stickiness`
        : 'project lookup unavailable; ask instead of guessing',
      threadId,
      projectMatchedBy: project.matchedBy,
    })
    return {
      inbox: store.updateInboxStatus(inbox.id, 'triaged'),
      duplicate: false,
      actor: resolved.actor,
      thread,
      intent,
      target: {
        kind: 'project',
        command: 'use',
        projectId: null,
        name: null,
        candidates: project.candidates,
      },
      bypassReason: 'ambiguous-project',
      disposition,
      followUp,
      project,
      error: null,
    }
  }

  if (followUp !== null && followUp.ambiguous) {
    const disposition = store.appendRouteDecision({
      triggerId: inbox.id,
      action: 'ask',
      reason: `ambiguous task ownership: ${followUp.candidates.length} live tasks in this chat`,
      threadId,
      projectId: project.projectId,
      projectMatchedBy: project.matchedBy,
    })
    return {
      inbox: store.updateInboxStatus(inbox.id, 'triaged'),
      duplicate: false,
      actor: resolved.actor,
      thread,
      intent,
      target: { kind: 'ask', candidates: followUp.candidates },
      bypassReason: 'ambiguous-task',
      disposition,
      followUp,
      project,
      error: null,
    }
  }

  // 5. Everything else (chat / command / event / unanchored) goes to the single
  // foreground orchestrator. The orchestrator records its own disposition.
  return {
    inbox: store.updateInboxStatus(inbox.id, 'routed'),
    duplicate: false,
    actor: resolved.actor,
    thread,
    intent,
    target: ORCHESTRATOR,
    bypassReason: null,
    disposition: null,
    followUp,
    project,
    error: null,
  }
}
