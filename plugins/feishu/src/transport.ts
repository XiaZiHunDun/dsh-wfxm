/**
 * Outbound transport for the Feishu channel (docs/14 §五 · 15 §五).
 *
 * Implements ①'s `OutboxTransport` contract structurally (AR32/AR33): this
 * module never imports the gateway; `TransportShape` / `DeliveryShape` mirror
 * `plugins/gateway/src/port.ts` field-for-field, and `FeishuTransportError`
 * carries the documented `TransportError` shape (`name` / `code` /
 * `retryable`) which ① honours via its structural check.
 *
 * Addressing rule: `replyToMsgId` wins (reply API keeps threading), then an
 * explicit `chatId` / `openId` in the payload, then the host-injected
 * `resolveChatId(threadId)`. No address at all is a permanent `rejected`
 * failure — the row can never become deliverable by retrying.
 */

import { resolveLarkDomain } from './channel.js'
import {
  buildApprovalCard,
  buildApprovalConfirmCard,
  buildApprovalDetailCard,
  buildApprovalResultCard,
  isApprovalCardPayload,
  isApprovalConfirmPayload,
  isApprovalDetailPayload,
  isApprovalResultPayload,
} from './card.js'
import { FEISHU_TEXT_SEGMENT_LIMIT, segmentText } from './segment.js'

// -- structural mirror of ① port.ts (keep in sync manually; AR32 forbids the import) ---

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type TransportErrorCode =
  | 'unavailable'
  | 'rejected'
  | 'too-large'
  | 'timeout'
  | 'rate-limited'

const RETRYABLE: Record<TransportErrorCode, boolean> = {
  unavailable: true,
  rejected: false,
  'too-large': false,
  timeout: true,
  'rate-limited': true,
}

/** Same name/code/retryable shape as ① `TransportError` — matched structurally. */
export class FeishuTransportError extends Error {
  readonly retryable: boolean

  constructor(readonly code: TransportErrorCode, message: string) {
    super(message)
    this.name = 'TransportError'
    this.retryable = RETRYABLE[code]
  }
}

export interface DeliveryShape {
  readonly id: string
  readonly topic: string
  readonly payload: Json
  readonly attempts: number
  readonly taskId: string | null
  readonly threadId: string | null
  readonly replyToMsgId: string | null
}

export interface TransportShape {
  readonly transport: string
  send(delivery: DeliveryShape): Promise<{ externalMsgId?: string | null }>
}

// -- narrow lark client seam (satisfied by @larksuiteoapi/node-sdk `Client`) -------------

export interface FeishuMessageApi {
  create(input: {
    params: { receive_id_type: string }
    data: { receive_id: string; msg_type: string; content: string; uuid?: string }
  }): Promise<unknown>
  reply(input: {
    path: { message_id: string }
    data: { msg_type: string; content: string; uuid?: string }
  }): Promise<unknown>
  /** Update an interactive card in place (docs/14 §六). Optional: fall back to text. */
  patch?(input: {
    path: { message_id: string }
    data: { content: string }
  }): Promise<unknown>
}

export interface FeishuClientLike {
  readonly im: { readonly v1: { readonly message: FeishuMessageApi } }
}

// -- error classification -----------------------------------------------------------------

/** Feishu frequency-control codes → retryable rate-limit (docs/14 §七). */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([99991400, 99991401, 99991403, 99991404])
/** Permanent failures: retrying will never help, fail the row immediately. */
const REJECTED_CODES: ReadonlySet<number> = new Set([
  230001, // invalid request parameter
  230002, // invalid request
  99991663, // bot is not in the chat
  99991672, // missing im:resource permission scope
])

interface ClassifiedError {
  code: TransportErrorCode
  detail: string
}

function extractErrorInfo(error: unknown): {
  larkCode: number | null
  httpStatus: number | null
  message: string
  name: string
} {
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown
    msg?: unknown
    message?: unknown
    name?: unknown
    response?: { status?: unknown; data?: { code?: unknown; msg?: unknown } }
  }
  const larkCode = typeof record.code === 'number' && record.code !== 0
    ? record.code
    : typeof record.response?.data?.code === 'number' && record.response.data.code !== 0
      ? record.response.data.code
      : null
  const httpStatus = typeof record.response?.status === 'number' ? record.response.status : null
  const message = typeof record.message === 'string'
    ? record.message
    : typeof record.msg === 'string'
      ? record.msg
      : typeof record.response?.data?.msg === 'string'
        ? record.response.data.msg
        : String(error)
  const name = typeof record.name === 'string' ? record.name : ''
  return { larkCode, httpStatus, message, name }
}

/** Map any SDK / network failure onto ①'s transport error semantics. */
export function classifyFeishuError(error: unknown): ClassifiedError {
  const { larkCode, httpStatus, message, name } = extractErrorInfo(error)

  if (larkCode !== null) {
    if (RATE_LIMIT_CODES.has(larkCode)) return { code: 'rate-limited', detail: message }
    if (REJECTED_CODES.has(larkCode)) return { code: 'rejected', detail: message }
    // Unknown API codes: retryable — the row fails loudly after the attempt
    // ceiling instead of being misfiled as permanent (13 §3.2).
    return { code: 'unavailable', detail: message }
  }
  if (httpStatus !== null) {
    if (httpStatus === 429) return { code: 'rate-limited', detail: message }
    if (httpStatus === 413) return { code: 'too-large', detail: message }
    if (httpStatus === 401 || httpStatus === 403) return { code: 'rejected', detail: message }
    if (httpStatus >= 500) return { code: 'unavailable', detail: message }
    return { code: 'rejected', detail: message }
  }
  if (name === 'TimeoutError' || name === 'AbortError' || /timed?\s*out/i.test(message)) {
    return { code: 'timeout', detail: message }
  }
  return { code: 'unavailable', detail: message }
}

/** The SDK resolves non-zero `{code, msg}` bodies too — treat both paths alike. */
function assertApiOk(response: unknown): void {
  const body = response as { code?: unknown; msg?: unknown } | null
  if (body !== null && typeof body === 'object' && typeof body.code === 'number' && body.code !== 0) {
    const classified = classifyFeishuError(body)
    throw new FeishuTransportError(classified.code, classified.detail)
  }
}

function unwrapMessageId(response: unknown): string {
  assertApiOk(response)
  const body = response as { data?: { message_id?: unknown } } | null
  const messageId = body?.data?.message_id
  if (typeof messageId !== 'string' || messageId === '') {
    throw new FeishuTransportError('unavailable', 'feishu send returned no message_id')
  }
  return messageId
}

// -- transport ----------------------------------------------------------------------------

export interface FeishuTransportLogger {
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface FeishuTransportOptions {
  /** Narrow lark `Client` (`client.im.v1.message`); see `createLarkClient`. */
  readonly client: FeishuClientLike
  /**
   * Host-composed thread lookup (AR33: the host reads ①'s `threads` row and
   * hands us the chat id; this plugin never touches the store).
   */
  readonly resolveChatId?: (threadId: string) => string | null | Promise<string | null>
  readonly logger?: FeishuTransportLogger
  readonly maxSegmentChars?: number
  /**
   * Feishu ignores `message.patch` issued while the card-action callback is
   * still being answered (the client re-renders the callback's card). Hosts
   * should defer approval patches slightly; tests keep the default of 0.
   */
  readonly patchDelayMs?: number
}

/** Render the outbound text for a ① payload; `null` means undeliverable. */
export function outboundText(payload: Json): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, Json>
  if (typeof record.text === 'string') return record.text
  if (typeof record.summary === 'string') return record.summary
  return null
}

export function createFeishuTransport(options: FeishuTransportOptions): TransportShape {
  const { client } = options
  const maxSegmentChars = options.maxSegmentChars ?? FEISHU_TEXT_SEGMENT_LIMIT

  const addressOf = async (delivery: DeliveryShape): Promise<
    | { kind: 'reply'; messageId: string }
    | { kind: 'create'; receiveIdType: 'chat_id' | 'open_id'; receiveId: string }
  > => {
    if (delivery.replyToMsgId !== null && delivery.replyToMsgId !== '') {
      return { kind: 'reply', messageId: delivery.replyToMsgId }
    }
    const payload = (typeof delivery.payload === 'object' && delivery.payload !== null
      ? delivery.payload
      : {}) as Record<string, Json>
    if (typeof payload.chatId === 'string' && payload.chatId !== '') {
      return { kind: 'create', receiveIdType: 'chat_id', receiveId: payload.chatId }
    }
    if (typeof payload.openId === 'string' && payload.openId !== '') {
      return { kind: 'create', receiveIdType: 'open_id', receiveId: payload.openId }
    }
    if (delivery.threadId !== null && options.resolveChatId !== undefined) {
      const chatId = await options.resolveChatId(delivery.threadId)
      if (chatId !== null && chatId !== '') {
        return { kind: 'create', receiveIdType: 'chat_id', receiveId: chatId }
      }
    }
    throw new FeishuTransportError(
      'rejected',
      `delivery ${delivery.id} has no address (no replyToMsgId / chatId / openId / thread)`,
    )
  }

  const sendMessage = async (
    address: Awaited<ReturnType<typeof addressOf>>,
    msgType: string,
    content: string,
    uuid: string,
  ): Promise<string> => {
    try {
      if (address.kind === 'reply') {
        const response = await client.im.v1.message.reply({
          path: { message_id: address.messageId },
          data: { msg_type: msgType, content, uuid },
        })
        return unwrapMessageId(response)
      }
      const response = await client.im.v1.message.create({
        params: { receive_id_type: address.receiveIdType },
        data: { receive_id: address.receiveId, msg_type: msgType, content, uuid },
      })
      return unwrapMessageId(response)
    } catch (error) {
      if (error instanceof FeishuTransportError) throw error
      const classified = classifyFeishuError(error)
      throw new FeishuTransportError(classified.code, classified.detail)
    }
  }

  const sendSegment = (
    address: Awaited<ReturnType<typeof addressOf>>,
    text: string,
    uuid: string,
  ): Promise<string> => sendMessage(address, 'text', JSON.stringify({ text }), uuid)

  /**
   * Patch a card we rendered (docs/14 §六/§七). Returns the card id on success,
   * `null` when patching is impossible or failed — the caller then falls back to
   * a plain text message instead of losing the state change.
   */
  const patchCard = async (
    delivery: DeliveryShape,
    messageId: string | null | undefined,
    card: Json,
  ): Promise<string | null> => {
    const id = typeof messageId === 'string' ? messageId : ''
    const patch = client.im.v1.message.patch
    if (id === '' || typeof patch !== 'function') return null
    try {
      const delay = options.patchDelayMs ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const response = await patch.call(client.im.v1.message, {
        path: { message_id: id },
        data: { content: JSON.stringify(card) },
      })
      assertApiOk(response)
      return id
    } catch (error) {
      options.logger?.warn('feishu card patch failed; falling back to text', {
        delivery: delivery.id,
        messageId: id,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  return {
    transport: 'feishu',
    async send(delivery) {
      const payload = delivery.payload

      // Approval card: the adapter renders the channel-native card; ① only
      // supplied the neutral payload (docs/14 §五).
      if (isApprovalCardPayload(payload)) {
        const address = await addressOf(delivery)
        const messageId = await sendMessage(
          address,
          'interactive',
          JSON.stringify(buildApprovalCard(payload)),
          delivery.id,
        )
        return { externalMsgId: messageId }
      }

      // Decision result: patch the card in place, else send the text fallback.
      if (isApprovalResultPayload(payload)) {
        const patched = await patchCard(
          delivery,
          payload.externalMsgId,
          buildApprovalResultCard({
            approvalId: payload.approvalId,
            decision: payload.decision,
          }),
        )
        if (patched !== null) return { externalMsgId: patched }
        const fallback = typeof payload.text === 'string' && payload.text !== '' ? payload.text : null
        if (fallback === null) {
          throw new FeishuTransportError(
            'rejected',
            `delivery ${delivery.id} (topic ${delivery.topic}) cannot be patched and has no text`,
          )
        }
        const address = await addressOf(delivery)
        const messageId = await sendMessage(address, 'text', JSON.stringify({ text: fallback }), delivery.id)
        return { externalMsgId: messageId }
      }

      // R3 second step (Slice L): replace the original card with the explicit
      // confirmation card; a failed patch falls back to a text reminder.
      if (isApprovalConfirmPayload(payload)) {
        const patched = await patchCard(delivery, payload.externalMsgId, buildApprovalConfirmCard(payload))
        if (patched !== null) return { externalMsgId: patched }
        const fallback = typeof payload.text === 'string' && payload.text !== '' ? payload.text : null
        if (fallback === null) {
          throw new FeishuTransportError(
            'rejected',
            `delivery ${delivery.id} (topic ${delivery.topic}) cannot be patched and has no text`,
          )
        }
        const address = await addressOf(delivery)
        const messageId = await sendMessage(address, 'text', JSON.stringify({ text: fallback }), delivery.id)
        return { externalMsgId: messageId }
      }

      // Read-only "details" (Slice L): always a new card, never a patch — the
      // pending approval card must stay where it is.
      if (isApprovalDetailPayload(payload)) {
        const address = await addressOf(delivery)
        const messageId = await sendMessage(
          address,
          'interactive',
          JSON.stringify(buildApprovalDetailCard(payload)),
          delivery.id,
        )
        return { externalMsgId: messageId }
      }

      const text = outboundText(payload)
      if (text === null || text === '') {
        throw new FeishuTransportError(
          'rejected',
          `delivery ${delivery.id} (topic ${delivery.topic}) has no text payload`,
        )
      }
      const address = await addressOf(delivery)
      const segments = segmentText(text, maxSegmentChars)
      let firstMessageId: string | null = null
      for (let index = 0; index < segments.length; index += 1) {
        // ① hands us `outbox.id` as the idempotency key (13 §3.2); segment
        // suffixes keep multi-part sends distinct for Feishu's uuid dedup.
        const uuid = index === 0 ? delivery.id : `${delivery.id}:${index}`
        const messageId = await sendSegment(address, segments[index]!, uuid)
        firstMessageId ??= messageId
      }
      if (segments.length > 1) {
        options.logger?.warn('feishu message split into segments', {
          delivery: delivery.id,
          segments: segments.length,
        })
      }
      return { externalMsgId: firstMessageId }
    },
  }
}

/** Real SDK client construction; isolated so tests never import the SDK. */
export async function createLarkClient(credentials: {
  appId: string
  appSecret: string
  /** Enum name ('feishu' / 'lark') or a full base URL. */
  domain?: string | null
}): Promise<FeishuClientLike> {
  const lark = await import('@larksuiteoapi/node-sdk')
  return new lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: resolveLarkDomain(credentials.domain, lark.Domain as unknown as Record<string, string>),
  }) as unknown as FeishuClientLike
}
