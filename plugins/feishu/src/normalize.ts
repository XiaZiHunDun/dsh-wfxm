/**
 * Inbound normalization for the Feishu long connection (docs/14 §三).
 *
 * Pure and SDK-free on purpose: the WS layer hands us the raw event object
 * (the lark SDK flattens schema-2.0 envelopes — `header` and `event` merged
 * top-level — but the nested shape is accepted too) and we return the
 * protocol-neutral shape the host feeds to ① `ingestInbound`. Replay dedup by
 * `msgId` (`event_id`) is ①'s job (AR28) — nothing is dropped here except
 * malformed events and bot-authored messages (loop prevention).
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface NormalizedInbound {
  readonly kind: 'message'
  /** Feishu app id — the ① channel instance id. */
  readonly channelId: string
  /** `event_id` — ①'s `(channel_id, msg_id)` dedup key (AR28). */
  readonly msgId: string
  /** Sender `open_id`; identity pairing is ①'s job. */
  readonly externalUserId: string
  readonly chatId: string
  /** Feishu `thread_id` (topic group); maps to ① `topicId`. */
  readonly topicId: string | null
  readonly rootMsgId: string | null
  /** `parent_id` — the message this one replies to, if any. */
  readonly replyToMsgId: string | null
  /** Feishu `message_id` of this inbound message. */
  readonly externalMsgId: string
  /** Feishu `message_type` (`text`, `image`, ...). */
  readonly messageType: string
  /**
   * `{ text, ... }` for text messages (① commands read `content.text`);
   * `{ raw, ... }` otherwise. Always carries `messageType` and
   * `externalMsgId` so the ① inbox row is self-contained.
   */
  readonly content: Json
  /** Local receive clock — channel timestamps are never trusted (14 §三). */
  readonly receivedAt: string
}

export interface NormalizeOptions {
  /** Fallback when the envelope carries no `app_id` (single-bot setups). */
  readonly defaultChannelId?: string
  readonly now?: () => Date
}

/**
 * A `card.action.trigger` event (button click), normalized for ①.
 *
 * The button value is passed through untouched: ① decides whether it is an
 * approval answer (`approval_id` / `decision` / `nonce`) or something else, and
 * the approval of record stays in ③ (AR10). `msgId` is again the dedup key.
 */
export interface NormalizedCardAction {
  readonly kind: 'card_action'
  readonly channelId: string
  /** `event_id` — replays of the same click collapse onto one inbox row (AR28). */
  readonly msgId: string
  /** `operator.open_id` who clicked. */
  readonly externalUserId: string
  readonly chatId: string | null
  /** `context.open_message_id` — the card itself (used to patch it later). */
  readonly externalMsgId: string | null
  /** Reply to the card message so a text fallback lands under it. */
  readonly replyToMsgId: string | null
  /** `action.value` verbatim. */
  readonly action: Json
  readonly receivedAt: string
}

interface LooseRecord {
  [key: string]: unknown
}

function asRecord(value: unknown): LooseRecord | null {
  return typeof value === 'object' && value !== null ? value as LooseRecord : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Parse the Feishu message `content` JSON string without ever throwing. */
export function parseFeishuContent(raw: unknown): Json {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as Json
  } catch {
    return raw
  }
}

/**
 * Normalize one `im.message.receive_v1` event. Returns `null` when the event
 * is malformed or bot-authored — the caller logs metadata, never content.
 */
export function normalizeFeishuMessageEvent(
  event: unknown,
  options?: NormalizeOptions,
): NormalizedInbound | null {
  const root = asRecord(event)
  if (root === null) return null
  // The SDK flattens schema 2.0 (`{...header, ...event}`); accept both shapes.
  const header = asRecord(root.header) ?? root
  const body = asRecord(root.event) ?? root

  const sender = asRecord(body.sender)
  if (sender?.sender_type === 'app') return null // bot-authored: loop prevention
  const senderId = asRecord(sender?.sender_id)
  const externalUserId = asText(senderId?.open_id)
  const message = asRecord(body.message) ?? {}

  const msgId = asText(header.event_id)
  const channelId = asText(header.app_id) ?? options?.defaultChannelId ?? null
  const externalMsgId = asText(message?.message_id)
  const chatId = asText(message?.chat_id)
  const messageType = asText(message?.message_type)
  if (
    msgId === null || channelId === null || externalUserId === null
    || externalMsgId === null || chatId === null || messageType === null
  ) {
    return null
  }

  const parsed = parseFeishuContent(message.content)
  const parsedRecord = asRecord(parsed)
  const text = messageType === 'text' && typeof parsedRecord?.text === 'string'
    ? parsedRecord.text
    : null
  const content: Json = text === null
    ? { messageType, externalMsgId, raw: parsed }
    : { text, messageType, externalMsgId }

  return {
    kind: 'message',
    channelId,
    msgId,
    externalUserId,
    chatId,
    topicId: asText(message.thread_id),
    rootMsgId: asText(message.root_id),
    replyToMsgId: asText(message.parent_id),
    externalMsgId,
    messageType,
    content,
    receivedAt: (options?.now ?? (() => new Date()))().toISOString(),
  }
}

/** Keep only JSON-serializable values; anything else becomes `null`. */
function toJson(value: unknown): Json {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value)) as Json
  } catch {
    return null
  }
}

/**
 * Normalize one `card.action.trigger` event (docs/14 §二/§六).
 *
 * Returns `null` for malformed events; a valid event without a button value is
 * still returned (with `action: null`) so ① can audit the ignored click instead
 * of it disappearing.
 */
export function normalizeFeishuCardActionEvent(
  event: unknown,
  options?: NormalizeOptions,
): NormalizedCardAction | null {
  const root = asRecord(event)
  if (root === null) return null
  // The SDK flattens schema 2.0 (`{...header, ...event}`); accept both shapes.
  const header = asRecord(root.header) ?? root
  const body = asRecord(root.event) ?? root

  const operator = asRecord(body.operator)
  const externalUserId = asText(operator?.open_id)
  const action = asRecord(body.action)
  const context = asRecord(body.context)

  const msgId = asText(header.event_id)
  const channelId = asText(header.app_id) ?? options?.defaultChannelId ?? null
  if (msgId === null || channelId === null || externalUserId === null || action === null) return null

  const cardMessageId = asText(context?.open_message_id)
  return {
    kind: 'card_action',
    channelId,
    msgId,
    externalUserId,
    chatId: asText(context?.open_chat_id),
    externalMsgId: cardMessageId,
    replyToMsgId: cardMessageId,
    action: toJson(action.value),
    receivedAt: (options?.now ?? (() => new Date()))().toISOString(),
  }
}
