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

/**
 * Slice AS: an attachment referenced by an inbound message. Normalization is
 * pure — the channel downloads the resource afterwards (`messageResource.get`),
 * so this is metadata only. `key` is the Feishu `image_key` / `file_key`.
 */
export type InboundAttachmentKind = 'image' | 'file' | 'audio' | 'video'

export interface InboundAttachment {
  readonly kind: InboundAttachmentKind
  readonly key: string
  readonly name: string | null
  readonly sizeBytes: number | null
  readonly durationMs: number | null
}

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
   * `{ raw, ... }` otherwise. Slice AS adds `attachments` for image/file/
   * audio/media/post messages. Always carries `messageType` and
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

function numberish(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

function attachment(
  kind: InboundAttachmentKind,
  key: unknown,
  extra: { name?: unknown; size?: unknown; duration?: unknown } = {},
): InboundAttachment | null {
  const fileKey = asText(key)
  if (fileKey === null) return null
  return {
    kind,
    key: fileKey,
    name: asText(extra.name),
    sizeBytes: numberish(extra.size),
    durationMs: numberish(extra.duration),
  }
}

/** Image / file / audio / media message payloads (docs/14 §三). */
function extractAttachments(messageType: string, record: LooseRecord | null): InboundAttachment[] {
  if (record === null) return []
  const one = (value: InboundAttachment | null): InboundAttachment[] => value === null ? [] : [value]
  switch (messageType) {
    case 'image':
      return one(attachment('image', record.image_key))
    case 'file':
      return one(attachment('file', record.file_key, {
        name: record.file_name,
        size: record.file_size,
      }))
    case 'audio':
      return one(attachment('audio', record.file_key, {
        name: record.file_name,
        duration: record.duration,
      }))
    case 'media':
      return one(attachment('video', record.file_key, {
        name: record.file_name,
        duration: record.duration,
      }))
    default:
      // sticker / share_chat / ... stay text-less with `raw` only.
      return []
  }
}

/** Rich post: title + lines of text, inline images collected in order. */
function extractPost(parsed: Json): { text: string; images: InboundAttachment[] } | null {
  const record = asRecord(parsed)
  if (record === null) return null
  const lines: string[] = []
  const images: InboundAttachment[] = []
  // Feishu: `{ title, content: [[{tag:'text'|'img'|'a'|'at'|'emotion'}]] }`
  const rows = Array.isArray(record.content) ? record.content : []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const parts: string[] = []
    for (const rawPart of row) {
      const part = asRecord(rawPart)
      if (part === null) continue
      if (part.tag === 'img') {
        const image = attachment('image', part.image_key)
        if (image !== null) images.push(image)
        continue
      }
      if (typeof part.text === 'string') parts.push(part.text)
    }
    if (parts.length > 0) lines.push(parts.join(''))
  }
  const title = asText(record.title)
  const body = [title, ...lines].filter((line): line is string => line !== null && line.trim() !== '').join('\n')
  if (body === '' && images.length === 0) return null
  return { text: body, images }
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
  // Slice AS: rich posts carry their own text plus inline images; other media
  // messages carry a key we hand to the channel for download.
  const post = messageType === 'post' ? extractPost(parsed) : null
  const attachments = messageType === 'post'
    ? post?.images ?? []
    : extractAttachments(messageType, parsedRecord)
  const bodyText = text ?? post?.text ?? null
  // Plain JSON: `InboundAttachment` is an interface, and `Json` requires an
  // implicit index signature, so map field by field.
  const attachmentJson: Json = attachments.map((item) => ({
    kind: item.kind,
    key: item.key,
    name: item.name,
    sizeBytes: item.sizeBytes,
    durationMs: item.durationMs,
  }))
  const content: Json = bodyText !== null
    ? {
      text: bodyText,
      messageType,
      externalMsgId,
      ...attachments.length === 0 ? {} : { attachments: attachmentJson },
    }
    : {
      messageType,
      externalMsgId,
      raw: parsed,
      ...attachments.length === 0 ? {} : { attachments: attachmentJson },
    }

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
