/**
 * Channel gateway model (module ①, docs/15 §三 · §九).
 *
 * Pure constants, types and small helpers. The store owns persistence, the
 * dispatcher owns delivery; both import from here so the state names, the
 * route actions and the retry ladder exist in exactly one place.
 */

import { randomBytes } from 'node:crypto'

/** JSON value, matching the shape the host's tool schema inference produces. */
export type Json = string | number | boolean | null | Json[] | JsonObject

export interface JsonObject {
  [key: string]: Json
}

export type InboxStatus = 'accepted' | 'triaged' | 'routed' | 'done' | 'failed' | 'rejected'

export type InboxKind = 'message' | 'card_action' | 'control'

export type ActorKind = 'owner' | 'system'

export type SessionKind = 'orchestrator' | 'chat'

export type RouteAction =
  | 'answer'
  | 'ack'
  | 'ask'
  | 'accept'
  | 'attach'
  | 'ignore'
  | 'stop'
  | 'wake'

export type OutboxStatus = 'pending' | 'sent' | 'failed'

/** Inbound message, persisted before anything else happens (AR28). */
export interface InboxItem {
  id: string
  channelId: string
  msgId: string
  kind: InboxKind
  actorId: string | null
  content: Json
  /** Channel chat id (Feishu chat_id; B1 §9.2). */
  chatId: string | null
  /** Thread (topic / root rotation); the dedup key stays `(channel_id, msg_id)`. */
  threadId: string | null
  replyToMsgId: string | null
  status: InboxStatus
  errorCode: string | null
  receivedAt: string
  processedAt: string | null
}

export interface Actor {
  id: string
  kind: ActorKind
  displayName: string | null
  createdAt: string
}

export interface ChannelBinding {
  id: string
  actorId: string
  channelId: string
  externalUserId: string
  boundAt: string
  revokedAt: string | null
}

export interface SessionRoute {
  channelId: string
  /** Channel chat id (Feishu `chat_id`) — not a Thread id (15 §9.3). */
  chatId: string
  sessionKind: SessionKind
  sessionId: string
  projectId: string | null
  updatedAt: string
}

export type ThreadKind = 'topic' | 'root'

/**
 * How a message was bound to a project (11 §5.3.1).
 * `asked` means the candidate list was returned instead of guessing.
 */
export type ProjectMatchedBy = 'explicit' | 'anchor' | 'sticky' | 'single' | 'asked'

/**
 * B1 Thread anchor (15 §9.1). Unique per `(channel, chat, kind, topic|root)`;
 * `project_id` is a routing hint only, never an authorization input (AR33).
 */
export interface ThreadRecord {
  id: string
  channelId: string
  chatId: string
  kind: ThreadKind
  topicId: string | null
  rootMsgId: string | null
  projectId: string | null
  createdAt: string
  lastMsgAt: string | null
}

export interface RouteDecision {
  id: string
  triggerId: string
  action: RouteAction
  targetTaskId: string | null
  threadId: string | null
  reason: string
  confidence: number | null
  promptVersion: string | null
  createdAt: string
  /** Which project the message was resolved to (11 §5.3.1); null = project-agnostic. */
  projectId: string | null
  /** How the project was resolved, or `asked` when the user must choose. */
  projectMatchedBy: ProjectMatchedBy | null
}

export interface OutboxItem {
  id: string
  topic: string
  payload: Json
  status: OutboxStatus
  attempts: number
  nextRetryAt: string | null
  createdAt: string
  sentAt: string | null
  leaseOwner: string | null
  leaseExpiresAt: string | null
  externalMsgId: string | null
  lastError: string | null
  taskId: string | null
  threadId: string | null
  replyToMsgId: string | null
}

export type GatewayErrorCode = 'invalid-input' | 'conflict' | 'not-found' | 'invalid-state'

export class GatewayError extends Error {
  constructor(readonly code: GatewayErrorCode, message: string) {
    super(message)
    this.name = 'GatewayError'
  }
}

export const INBOX_STATUSES: readonly InboxStatus[] = [
  'accepted',
  'triaged',
  'routed',
  'done',
  'failed',
  'rejected',
]

export const INBOX_KINDS: readonly InboxKind[] = ['message', 'card_action', 'control']

export const ACTOR_KINDS: readonly ActorKind[] = ['owner', 'system']

export const SESSION_KINDS: readonly SessionKind[] = ['orchestrator', 'chat']

export const THREAD_KINDS: readonly ThreadKind[] = ['topic', 'root']

export const ROUTE_ACTIONS: readonly RouteAction[] = [
  'answer',
  'ack',
  'ask',
  'accept',
  'attach',
  'ignore',
  'stop',
  'wake',
]

export const OUTBOX_STATUSES: readonly OutboxStatus[] = ['pending', 'sent', 'failed']

/** Six attempts, then `failed` (13 §3.2). */
export const OUTBOX_MAX_ATTEMPTS = 6

/** 1s → 5s → 30s → 2m → 10m (13 §3.2). */
export const OUTBOX_BACKOFF_MS = [1000, 5000, 30000, 120000, 600000] as const

/**
 * Delay before the next attempt, given the attempts already started.
 * `null` means "no more retries" (attempts exhausted).
 */
export function outboxBackoffMs(attempts: number): number | null {
  if (attempts >= OUTBOX_MAX_ATTEMPTS) return null
  const index = Math.min(Math.max(attempts - 1, 0), OUTBOX_BACKOFF_MS.length - 1)
  return OUTBOX_BACKOFF_MS[index]
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
