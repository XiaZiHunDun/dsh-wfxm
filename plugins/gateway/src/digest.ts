/**
 * Conversation digest (docs/05 Step 4 G3): a deterministic, model-free summary
 * of *which* conversations were active in a window and how they turned into
 * work.
 *
 * Deliberate boundaries:
 * - no message body is read or rendered (privacy; same rule as outbound
 *   redaction) — the digest only carries counts, labels and timestamps;
 * - only inbound `message` rows count as conversation; `card_action` and
 *   `control` rows belong to approvals/control, not to a conversation;
 * - a task is counted once per thread, by `createdAt` inside the window, so
 *   the same task cannot inflate the number through several `task_threads`
 *   rows (default owner + anchors).
 *
 * The caller assembles the inputs from ① and ⑤ read APIs; this module never
 * touches a table and never changes state.
 */

import type { InboxKind, InboxStatus, ThreadKind } from './model.js'

export interface ConversationDigestThread {
  threadId: string
  chatId: string
  kind: ThreadKind
  topicId: string | null
}

export interface ConversationDigestMessage {
  threadId: string | null
  chatId: string | null
  kind: InboxKind
  status: InboxStatus
  receivedAt: string
}

export interface ConversationDigestTask {
  taskId: string
  threadId: string
  createdAt: string
  /** The task intent, shown as the conversation's subject (never the raw message). */
  intent?: string | null
}

export interface ConversationDigestWindow {
  from: Date
  to: Date
  /** Max bullet lines after the counts (default 5). */
  maxLines?: number
  /** Replaces `会话日报 MM-DD` (weekly report reuses the same counts). */
  title?: string
}

export interface ConversationDigest {
  conversations: number
  messages: number
  tasks: number
  /** Bullet lines, most recently active first. */
  lines: string[]
  text: string
}

interface Group {
  key: string
  threadId: string | null
  chatId: string | null
  messages: number
  failed: number
  taskIds: Set<string>
  intents: string[]
  lastAt: string
}

const MAX_INTENT = 24
const MAX_INTENTS = 3

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/[\r\n]+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

function inWindow(value: string, from: Date, to: Date): boolean {
  const at = Date.parse(value)
  return Number.isFinite(at) && at >= from.getTime() && at <= to.getTime()
}

function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clock(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '--:--'
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function threadKey(threadId: string): string {
  return `thread:${threadId}`
}

function chatKey(chatId: string): string {
  return `chat:${chatId}`
}

/**
 * Returns `null` when the window has no conversation activity — an empty daily
 * message is noise, exactly what this feature is meant to avoid.
 */
export function summarizeConversationDigest(
  input: {
    threads: readonly ConversationDigestThread[]
    messages: readonly ConversationDigestMessage[]
    tasks: readonly ConversationDigestTask[]
    window: ConversationDigestWindow
  },
): ConversationDigest | null {
  const { from, to } = input.window
  const meta = new Map(input.threads.map((thread) => [thread.threadId, thread]))
  const groups = new Map<string, Group>()

  const group = (key: string, threadId: string | null, chatId: string | null, at: string): Group => {
    const existing = groups.get(key)
    if (existing !== undefined) return existing
    const created: Group = {
      key,
      threadId,
      chatId,
      messages: 0,
      failed: 0,
      taskIds: new Set(),
      intents: [],
      lastAt: at,
    }
    groups.set(key, created)
    return created
  }

  for (const message of input.messages) {
    if (message.kind !== 'message') continue
    if (!inWindow(message.receivedAt, from, to)) continue
    const key = message.threadId !== null
      ? threadKey(message.threadId)
      : message.chatId !== null
        ? chatKey(message.chatId)
        : null
    if (key === null) continue
    const entry = group(key, message.threadId, message.chatId, message.receivedAt)
    entry.messages += 1
    if (message.status === 'failed') entry.failed += 1
    if (message.receivedAt > entry.lastAt) entry.lastAt = message.receivedAt
  }

  for (const task of input.tasks) {
    if (!inWindow(task.createdAt, from, to)) continue
    const key = threadKey(task.threadId)
    const threadsMeta = meta.get(task.threadId)
    const entry = group(key, task.threadId, threadsMeta?.chatId ?? null, task.createdAt)
    if (entry.taskIds.has(task.taskId)) continue
    entry.taskIds.add(task.taskId)
    if (typeof task.intent === 'string' && task.intent.trim() !== '') {
      entry.intents.push(oneLine(task.intent, MAX_INTENT))
    }
    if (task.createdAt > entry.lastAt) entry.lastAt = task.createdAt
  }

  if (groups.size === 0) return null

  let messageTotal = 0
  let taskTotal = 0
  for (const entry of groups.values()) {
    messageTotal += entry.messages
    taskTotal += entry.taskIds.size
  }

  const stamp = `${pad(to.getMonth() + 1)}-${pad(to.getDate())}`
  const headParts = [`会话 ${groups.size}`, `消息 ${messageTotal}`]
  if (taskTotal > 0) headParts.push(`新任务 ${taskTotal}`)
  const head = `${input.window.title ?? `会话日报 ${stamp}`}：${headParts.join(' · ')}`

  const sorted = [...groups.values()].sort((a, b) =>
    b.lastAt === a.lastAt ? a.key.localeCompare(b.key) : b.lastAt.localeCompare(a.lastAt),
  )

  // Two threads can share one chat (a root thread plus a message without a
  // thread id). Identical labels would make the digest look duplicated, so the
  // thread id is appended only when the chat is ambiguous.
  const perChat = new Map<string, number>()
  for (const entry of groups.values()) {
    const chatId = entry.chatId ?? (entry.threadId === null ? null : meta.get(entry.threadId)?.chatId ?? null)
    if (chatId === null) continue
    perChat.set(chatId, (perChat.get(chatId) ?? 0) + 1)
  }

  const lines = sorted.map((entry) => {
    const threadsMeta = entry.threadId === null ? undefined : meta.get(entry.threadId)
    const chatId = entry.chatId ?? threadsMeta?.chatId ?? null
    const ambiguous = chatId !== null && (perChat.get(chatId) ?? 0) > 1 && entry.threadId !== null
    const suffix = ambiguous && entry.threadId !== null ? `/${shortId(entry.threadId)}` : ''
    const name = threadsMeta?.kind === 'topic'
      ? `话题 ${shortId(threadsMeta.topicId ?? entry.threadId ?? entry.key)}`
      : `会话 ${shortId(chatId ?? entry.threadId ?? entry.key)}${suffix}`
    const parts = [`· ${name}`, entry.failed > 0
      ? `消息 ${entry.messages}（失败 ${entry.failed}）`
      : `消息 ${entry.messages}`]
    if (entry.taskIds.size > 0) {
      const names = entry.intents.slice(0, MAX_INTENTS)
      parts.push(names.length === 0
        ? `新任务 ${entry.taskIds.size}`
        : `新任务 ${entry.taskIds.size}：${names.join('；')}`)
    }
    parts.push(`最后 ${clock(entry.lastAt)}`)
    return parts.join(' · ')
  })

  const maxLines = Math.max(0, Math.floor(input.window.maxLines ?? 5))
  const visible = lines.slice(0, maxLines)

  return {
    conversations: groups.size,
    messages: messageTotal,
    tasks: taskTotal,
    lines: visible,
    text: visible.length === 0 ? head : `${head}\n${visible.join('\n')}`,
  }
}
