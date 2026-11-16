import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayStore, ingestInbound, createOutboxDispatcher } from '@dsh-wfxm/gateway'
import {
  FEISHU_TEXT_SEGMENT_LIMIT,
  FeishuTransportError,
  apply,
  buildApprovalCard,
  buildApprovalConfirmCard,
  buildApprovalDetailCard,
  buildApprovalResultCard,
  classifyFeishuError,
  createFeishuChannel,
  createFeishuTransport,
  inject,
  loadFeishuBotConfig,
  name,
  normalizeFeishuCardActionEvent,
  normalizeFeishuMessageEvent,
  outboundText,
  resolveLarkDomain,
  resolveSecretRef,
  segmentText,
  toCardActionResponse,
} from '../lib/index.js'

let pass = 0
let fail = 0
async function check(label, fn) {
  try {
    const ok = await fn()
    if (ok) {
      pass++
      console.log(`PASS  ${label}`)
    } else {
      fail++
      console.log(`FAIL  ${label}`)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'feishu-'))

// -- fixtures -------------------------------------------------------------------

const makeTextEvent = (overrides = {}) => ({
  schema: '2.0',
  header: { event_id: 'evt_1', event_type: 'im.message.receive_v1', app_id: 'cli_a1' },
  event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user1' } },
    message: {
      message_id: 'om_msg1',
      chat_id: 'oc_chat1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '你好' }),
      create_time: '1730000000000',
      ...overrides.message,
    },
    ...overrides.event,
  },
  ...overrides,
})

// -- normalization ---------------------------------------------------------------

await check('text event normalizes into the ① ingest shape', () => {
  const event = makeTextEvent()
  event.event.message.thread_id = 'omt_topic1'
  event.event.message.parent_id = 'om_parent'
  const normalized = normalizeFeishuMessageEvent(event, { now: () => new Date('2026-11-10T00:00:00Z') })
  return normalized !== null
    && normalized.kind === 'message'
    && normalized.channelId === 'cli_a1'
    && normalized.msgId === 'evt_1'
    && normalized.externalUserId === 'ou_user1'
    && normalized.chatId === 'oc_chat1'
    && normalized.topicId === 'omt_topic1'
    && normalized.replyToMsgId === 'om_parent'
    && normalized.externalMsgId === 'om_msg1'
    && normalized.messageType === 'text'
    && normalized.content.text === '你好'
    && normalized.content.externalMsgId === 'om_msg1'
    && normalized.receivedAt === '2026-11-10T00:00:00.000Z'
})

await check('the SDK-flattened envelope (header merged top-level) is accepted', () => {
  const event = makeTextEvent()
  const flat = { ...event.header, ...event.event }
  const normalized = normalizeFeishuMessageEvent(flat)
  return normalized !== null && normalized.msgId === 'evt_1' && normalized.content.text === '你好'
})

await check('bot-authored messages are dropped (loop prevention)', () => {
  const event = makeTextEvent()
  event.event.sender.sender_type = 'app'
  return normalizeFeishuMessageEvent(event) === null
})

await check('malformed events (no event_id / open_id / message) drop instead of throwing', () => {
  return normalizeFeishuMessageEvent(null) === null
    && normalizeFeishuMessageEvent({}) === null
    && normalizeFeishuMessageEvent({ header: { app_id: 'x' }, event: {} }) === null
    && normalizeFeishuMessageEvent(makeTextEvent({ header: { app_id: 'cli_a1' } })) === null // no event_id
})

await check('non-text messages keep the raw payload; broken content json stays raw', () => {
  const image = makeTextEvent()
  image.event.message.message_type = 'image'
  image.event.message.content = JSON.stringify({ image_key: 'img_1' })
  const broken = makeTextEvent()
  broken.event.message.content = '{not json'
  const a = normalizeFeishuMessageEvent(image)
  const b = normalizeFeishuMessageEvent(broken)
  return a !== null && a.content.messageType === 'image' && a.content.raw.image_key === 'img_1'
    && b !== null && b.content.raw === '{not json' && b.content.messageType === 'text'
})

await check('defaultChannelId fills a missing app_id', () => {
  const event = makeTextEvent()
  delete event.header.app_id
  const normalized = normalizeFeishuMessageEvent(event, { defaultChannelId: 'cli_fallback' })
  return normalized !== null && normalized.channelId === 'cli_fallback'
})

// -- segmentation -----------------------------------------------------------------

await check('short text is one segment; long text splits at newline within the limit', () => {
  const short = segmentText('abc')
  const body = `${'x'.repeat(FEISHU_TEXT_SEGMENT_LIMIT - 10)}\n${'y'.repeat(500)}`
  const long = segmentText(body)
  return short.length === 1 && short[0] === 'abc'
    && long.length === 2
    && long[0].length === FEISHU_TEXT_SEGMENT_LIMIT - 10
    && long[1].length === 500
    && long.every((segment) => segment.length <= FEISHU_TEXT_SEGMENT_LIMIT)
})

await check('no newline means a hard cut, and surrogate pairs are never split', () => {
  const hard = segmentText('a'.repeat(FEISHU_TEXT_SEGMENT_LIMIT + 5))
  const emoji = `${'a'.repeat(FEISHU_TEXT_SEGMENT_LIMIT - 1)}😀${'b'.repeat(10)}`
  const pair = segmentText(emoji)
  return hard.length === 2
    && hard[0].length === FEISHU_TEXT_SEGMENT_LIMIT
    && hard[1].length === 5
    && pair[0].endsWith('a') // the emoji moved wholly into the second segment
    && pair.join('') === emoji
})

// -- error classification ------------------------------------------------------------

await check('rate-limit / permission / network / timeout map onto the right codes', () => {
  return classifyFeishuError({ code: 99991400, msg: 'trigger frequency control' }).code === 'rate-limited'
    && classifyFeishuError({ code: 99991663, msg: 'bot not in chat' }).code === 'rejected'
    && classifyFeishuError({ code: 99991672, msg: 'no im:resource scope' }).code === 'rejected'
    && classifyFeishuError({ response: { status: 429 } }).code === 'rate-limited'
    && classifyFeishuError({ response: { status: 500 } }).code === 'unavailable'
    && classifyFeishuError({ response: { status: 401 } }).code === 'rejected'
    && classifyFeishuError({ response: { status: 413 } }).code === 'too-large'
    && classifyFeishuError({ response: { status: 500, data: { code: 99991401 } } }).code === 'rate-limited'
    && classifyFeishuError(new Error('fetch failed')).code === 'unavailable'
    && classifyFeishuError(Object.assign(new Error('aborted'), { name: 'TimeoutError' })).code === 'timeout'
    && classifyFeishuError({ code: 123456789, msg: 'mystery' }).code === 'unavailable'
})

await check('unknown codes are retryable and permanent codes are not', () => {
  const rateLimited = new FeishuTransportError('rate-limited', 'x')
  const rejected = new FeishuTransportError('rejected', 'x')
  return rateLimited.retryable === true
    && rejected.retryable === false
    && rateLimited.name === 'TransportError' // the structural marker ① matches on
})

// -- transport (fake lark client) ------------------------------------------------------

const fakeClient = (behavior = {}) => {
  const calls = []
  return {
    calls,
    im: {
      v1: {
        message: {
          create: async (input) => {
            calls.push({ method: 'create', input })
            if (behavior.createError !== undefined) throw behavior.createError
            return behavior.createResponse ?? { code: 0, msg: 'success', data: { message_id: 'om_sent' } }
          },
          reply: async (input) => {
            calls.push({ method: 'reply', input })
            if (behavior.replyError !== undefined) throw behavior.replyError
            return behavior.replyResponse ?? { code: 0, msg: 'success', data: { message_id: 'om_replied' } }
          },
          ...behavior.noPatch === true ? {} : {
            patch: async (input) => {
              calls.push({ method: 'patch', input })
              if (behavior.patchError !== undefined) throw behavior.patchError
              return behavior.patchResponse ?? { code: 0, msg: 'success', data: {} }
            },
          },
        },
      },
    },
  }
}

const delivery = (overrides = {}) => ({
  id: 'outbox_1',
  topic: 'say',
  payload: { text: 'hello' },
  attempts: 1,
  taskId: null,
  threadId: null,
  replyToMsgId: null,
  ...overrides,
})

await check('replyToMsgId wins and uses the reply API; the ack carries message_id', async () => {
  const client = fakeClient()
  const transport = createFeishuTransport({ client })
  const ack = await transport.send(delivery({ replyToMsgId: 'om_anchor' }))
  const call = client.calls[0]
  return transport.transport === 'feishu'
    && call.method === 'reply'
    && call.input.path.message_id === 'om_anchor'
    && JSON.parse(call.input.data.content).text === 'hello'
    && call.input.data.uuid === 'outbox_1'
    && ack.externalMsgId === 'om_replied'
})

await check('threadId resolves to chat_id via the host-injected resolver', async () => {
  const client = fakeClient()
  const transport = createFeishuTransport({
    client,
    resolveChatId: (threadId) => (threadId === 'thr_1' ? 'oc_resolved' : null),
  })
  const ack = await transport.send(delivery({ threadId: 'thr_1' }))
  const call = client.calls[0]
  return call.method === 'create'
    && call.input.params.receive_id_type === 'chat_id'
    && call.input.data.receive_id === 'oc_resolved'
    && ack.externalMsgId === 'om_sent'
})

await check('explicit payload chatId / openId are honored without a resolver', async () => {
  const client = fakeClient()
  const transport = createFeishuTransport({ client })
  await transport.send(delivery({ payload: { text: 'a', chatId: 'oc_direct' } }))
  await transport.send(delivery({ payload: { text: 'b', openId: 'ou_direct' } }))
  return client.calls[0].input.data.receive_id === 'oc_direct'
    && client.calls[0].input.params.receive_id_type === 'chat_id'
    && client.calls[1].input.data.receive_id === 'ou_direct'
    && client.calls[1].input.params.receive_id_type === 'open_id'
})

await check('no address at all is a permanent rejected failure', async () => {
  const transport = createFeishuTransport({ client: fakeClient() })
  await assert.rejects(
    () => transport.send(delivery()),
    (error) => error.name === 'TransportError' && error.code === 'rejected' && error.retryable === false,
  )
  return true
})

await check('a payload without text/summary is rejected, not sent', async () => {
  const client = fakeClient()
  const transport = createFeishuTransport({ client })
  await assert.rejects(
    () => transport.send(delivery({ payload: { image: 'x' }, replyToMsgId: 'om_a' })),
    (error) => error.code === 'rejected',
  )
  return client.calls.length === 0 && outboundText({ summary: 's' }) === 's'
})

await check('long text is segmented in order; the ack carries the first message_id', async () => {
  let n = 0
  const client = fakeClient()
  client.im.v1.message.reply = async (input) => {
    client.calls.push({ method: 'reply', input })
    n += 1
    return { code: 0, msg: 'success', data: { message_id: `om_seg${n}` } }
  }
  const transport = createFeishuTransport({ client })
  const text = `${'x'.repeat(FEISHU_TEXT_SEGMENT_LIMIT)}\n${'y'.repeat(FEISHU_TEXT_SEGMENT_LIMIT)}`
  const ack = await transport.send(delivery({ replyToMsgId: 'om_anchor', payload: { text } }))
  return client.calls.length === 2
    && client.calls[0].input.data.uuid === 'outbox_1'
    && client.calls[1].input.data.uuid === 'outbox_1:1'
    && ack.externalMsgId === 'om_seg1'
})

await check('a non-zero lark code in a resolved body is classified like a throw', async () => {
  const transport = createFeishuTransport({
    client: fakeClient({ replyResponse: { code: 99991663, msg: 'bot not in chat', data: {} } }),
  })
  await assert.rejects(
    () => transport.send(delivery({ replyToMsgId: 'om_anchor' })),
    (error) => error.code === 'rejected' && error.retryable === false,
  )
  return true
})

await check('a body without message_id fails loudly instead of a fake ack', async () => {
  const transport = createFeishuTransport({
    client: fakeClient({ replyResponse: { code: 0, msg: 'success', data: {} } }),
  })
  await assert.rejects(
    () => transport.send(delivery({ replyToMsgId: 'om_anchor' })),
    (error) => error.code === 'unavailable' && /message_id/.test(error.message),
  )
  return true
})

await check('a thrown SDK error is classified (rate-limited is retryable)', async () => {
  const transport = createFeishuTransport({
    client: fakeClient({ replyError: { code: 99991400, msg: 'trigger frequency control' } }),
  })
  await assert.rejects(
    () => transport.send(delivery({ replyToMsgId: 'om_anchor' })),
    (error) => error.code === 'rate-limited' && error.retryable === true,
  )
  return true
})

// -- card action (inbound) --------------------------------------------------------------

const fakeLarkModule = (hooks = {}) => {
  const state = { startOptions: null, closed: false, constructed: null }
  class FakeWSClient {
    constructor(params) {
      state.constructed = params
      this.params = params
    }
    start(options) {
      state.startOptions = options
      if (hooks.autoReady !== false) queueMicrotask(() => this.params.onReady?.())
    }
    close() {
      state.closed = true
    }
  }
  class FakeEventDispatcher {
    constructor(params) {
      this.params = params
      this.handlers = null
    }
    async register(handlers) {
      this.handlers = handlers
      state.handlers = handlers
    }
  }
  return { state, WSClient: FakeWSClient, EventDispatcher: FakeEventDispatcher, LoggerLevel: { info: 2 }, Domain: { Feishu: 'https://open.feishu.cn' } }
}

const makeCardEvent = () => ({
  schema: '2.0',
  header: { event_id: 'evt_card_1', event_type: 'card.action.trigger', app_id: 'cli_a1' },
  event: {
    operator: { open_id: 'ou_user1' },
    action: {
      tag: 'button',
      value: { approval_id: 'ap_1', decision: 'approve', nonce: 'n_1', channel_id: 'cli_a1' },
    },
    context: { open_message_id: 'om_card1', open_chat_id: 'oc_chat1' },
  },
})

await check('card 1: a button click normalizes into the ① card_action shape', () => {
  const normalized = normalizeFeishuCardActionEvent(makeCardEvent(), {
    now: () => new Date('2026-11-11T00:00:00Z'),
  })
  return normalized !== null
    && normalized.kind === 'card_action'
    && normalized.channelId === 'cli_a1'
    && normalized.msgId === 'evt_card_1'
    && normalized.externalUserId === 'ou_user1'
    && normalized.chatId === 'oc_chat1'
    && normalized.externalMsgId === 'om_card1'
    && normalized.replyToMsgId === 'om_card1'
    && normalized.action.approval_id === 'ap_1'
    && normalized.action.decision === 'approve'
    && normalized.action.nonce === 'n_1'
    && normalized.receivedAt === '2026-11-11T00:00:00.000Z'
})

await check('card 1b: flattened envelope works; malformed clicks are dropped', () => {
  const flat = { ...makeCardEvent().header, ...makeCardEvent().event }
  const normalized = normalizeFeishuCardActionEvent(flat)
  const noOperator = makeCardEvent()
  delete noOperator.event.operator
  const noAction = makeCardEvent()
  delete noAction.event.action
  return normalized !== null
    && normalized.msgId === 'evt_card_1'
    && normalized.action.nonce === 'n_1'
    && normalizeFeishuCardActionEvent(null) === null
    && normalizeFeishuCardActionEvent({}) === null
    && normalizeFeishuCardActionEvent(noOperator) === null
    && normalizeFeishuCardActionEvent(noAction) === null
})

await check('card 2: the channel subscribes card.action.trigger and hands clicks to the sink', async () => {
  const lark = fakeLarkModule()
  const clicks = []
  const channel = createFeishuChannel({
    appId: 'cli_a1',
    appSecret: 's',
    onMessage: () => {},
    onCardAction: (action) => clicks.push(action),
    lark,
  })
  await channel.start()
  const registered = Object.keys(lark.state.handlers).sort()
  await lark.state.handlers['card.action.trigger'](makeCardEvent())
  await channel.stop()
  return registered.length === 2
    && registered.includes('im.message.receive_v1')
    && registered.includes('card.action.trigger')
    && clicks.length === 1
    && clicks[0].action.approval_id === 'ap_1'
})

await check('card 2b: without a sink the click event is not subscribed and a warning is logged', async () => {
  const lark = fakeLarkModule()
  const warns = []
  const channel = createFeishuChannel({
    appId: 'cli_a1',
    appSecret: 's',
    onMessage: () => {},
    logger: { info() {}, warn: (msg, meta) => warns.push({ msg, meta }), error() {} },
    lark,
  })
  await channel.start()
  const registered = Object.keys(lark.state.handlers)
  await channel.stop()
  return registered.length === 1
    && registered[0] === 'im.message.receive_v1'
    && warns.length === 1
    && warns[0].msg.includes('card.action.trigger')
})

// -- card callback response (Feishu requires a toast within a few seconds) ---------------

async function clickWith(sink) {
  const lark = fakeLarkModule()
  const channel = createFeishuChannel({
    appId: 'cli_a1',
    appSecret: 's',
    onMessage: () => {},
    ...(sink === undefined ? {} : { onCardAction: sink }),
    lark,
  })
  await channel.start()
  const response = await lark.state.handlers['card.action.trigger'](makeCardEvent())
  await channel.stop()
  return response
}

await check('card 2c: a successful sink returns a success toast the caller can render', async () => {
  const response = await clickWith(() => ({ ok: true, toast: '已批准' }))
  return response.toast.type === 'success' && response.toast.content === '已批准'
})

await check('card 2d: an already-handled sink returns a warning toast (not an error)', async () => {
  const response = await clickWith(() => ({ ok: false, toast: '该审批已处理' }))
  return response.toast.type === 'warning' && response.toast.content === '该审批已处理'
})

await check('card 2e: a throwing sink still answers with an error toast (no silent client)', async () => {
  const response = await clickWith(() => {
    throw new Error('boom')
  })
  return response.toast.type === 'error' && response.toast.content.includes('失败')
})

await check('card 2f: a void sink yields a neutral "已处理" toast', async () => {
  const response = await clickWith(() => {})
  return response.toast.type === 'success' && response.toast.content === '已处理'
})

// -- card rendering + outbound -----------------------------------------------------------

const approvalCardPayload = (overrides = {}) => ({
  kind: 'approval_card',
  approvalId: 'ap_1',
  level: 'R3',
  summary: '重启 nginx',
  impact: { 'host': 'web-1', 'units': ['nginx.service'] },
  expiresAt: '2026-11-11T12:30:00Z',
  nonce: 'n_1',
  channelId: 'cli_a1',
  text: '需要确认 R3：重启 nginx',
  ...overrides,
})

await check('card 3: the approval card carries title, summary, impact, expiry and three buttons', () => {
  const card = buildApprovalCard(approvalCardPayload())
  const actions = card.elements.find((item) => item.tag === 'action')
  const approve = actions.actions[0]
  const reject = actions.actions[1]
  const details = actions.actions[2]
  const body = JSON.stringify(card.elements)
  return card.header.title.content.includes('R3')
    && body.includes('重启 nginx')
    && body.includes('nginx.service')
    && body.includes('2026-11-11 12:30')
    && actions.actions.length === 3
    && approve.text.content === '批准'
    && approve.value.approval_id === 'ap_1'
    && approve.value.decision === 'approve'
    && approve.value.nonce === 'n_1'
    && approve.value.channel_id === 'cli_a1'
    && reject.value.decision === 'reject'
    && details.text.content === '看详情'
    && details.value.decision === 'details'
    && buildApprovalResultCard({ approvalId: 'ap_1', decision: 'approved' }).header.title.content === '已批准'
    && buildApprovalResultCard({ approvalId: 'ap_1', decision: 'rejected' }).header.template === 'red'
    && buildApprovalResultCard({ approvalId: 'ap_1', decision: 'expired' }).header.title.content === '已过期'
    && buildApprovalResultCard({ approvalId: 'ap_1', decision: 'expired' }).header.template === 'grey'
})

await check('card 4: approval_card is sent as an interactive message, not text', async () => {
  const client = fakeClient()
  const transport = createFeishuTransport({ client })
  const ack = await transport.send(delivery({
    topic: 'approval.card',
    replyToMsgId: 'om_anchor',
    payload: approvalCardPayload(),
  }))
  const call = client.calls[0]
  const content = JSON.parse(call.input.data.content)
  return call.method === 'reply'
    && call.input.data.msg_type === 'interactive'
    && content.header.title.content.includes('R3')
    && call.input.data.uuid === 'outbox_1'
    && ack.externalMsgId === 'om_replied'
})

await check('card 5: approval_result patches the original card in place', async () => {
  const client = fakeClient()
  const transport = createFeishuTransport({ client })
  const ack = await transport.send(delivery({
    topic: 'approval.update',
    replyToMsgId: 'ignored',
    payload: {
      kind: 'approval_result',
      approvalId: 'ap_1',
      decision: 'approved',
      externalMsgId: 'om_card1',
      text: '已批准',
    },
  }))
  const call = client.calls[0]
  const content = JSON.parse(call.input.data.content)
  return client.calls.length === 1
    && call.method === 'patch'
    && call.input.path.message_id === 'om_card1'
    && content.header.title.content === '已批准'
    && ack.externalMsgId === 'om_card1'
})

await check('card 6: a failed or unavailable patch degrades to a text message', async () => {
  const failing = fakeClient({ patchError: { code: 230001, msg: 'card not found' } })
  const failingTransport = createFeishuTransport({ client: failing, logger: { info() {}, warn() {}, error() {} } })
  const ackA = await failingTransport.send(delivery({
    topic: 'approval.update',
    replyToMsgId: 'om_card1',
    payload: { kind: 'approval_result', approvalId: 'ap_1', decision: 'rejected', externalMsgId: 'om_card1', text: '已拒绝' },
  }))

  const noPatch = fakeClient({ noPatch: true })
  const noPatchTransport = createFeishuTransport({ client: noPatch })
  const ackB = await noPatchTransport.send(delivery({
    topic: 'approval.update',
    replyToMsgId: 'om_card1',
    payload: { kind: 'approval_result', approvalId: 'ap_1', decision: 'approved', externalMsgId: 'om_card1', text: '已批准' },
  }))

  const silent = fakeClient({ noPatch: true })
  const silentTransport = createFeishuTransport({ client: silent })
  await assert.rejects(
    () => silentTransport.send(delivery({
      topic: 'approval.update',
      replyToMsgId: 'om_card1',
      payload: { kind: 'approval_result', approvalId: 'ap_1', decision: 'approved', externalMsgId: 'om_card1' },
    })),
    (error) => error.code === 'rejected' && /no text/.test(error.message),
  )

  return failing.calls.map((call) => call.method).join(',') === 'patch,reply'
    && JSON.parse(failing.calls[1].input.data.content).text === '已拒绝'
    && ackA.externalMsgId === 'om_replied'
    && noPatch.calls.length === 1
    && noPatch.calls[0].method === 'reply'
    && ackB.externalMsgId === 'om_replied'
    && silent.calls.length === 0
})

await check('card 7: the details card shows intent, risk, criteria, plan and has no buttons', () => {
  const card = buildApprovalDetailCard({
    kind: 'approval_detail',
    approvalId: 'ap_1',
    level: 'R3',
    summary: '重启 nginx 托管服务',
    status: 'pending',
    stage: 1,
    requestedAt: '2026-11-11T12:00:00.000Z',
    expiresAt: '2026-11-11T12:30:00.000Z',
    decidedAt: null,
    impact: { unit: 'nginx.service' },
    task: {
      taskId: 'tk_1',
      taskRef: '8h99a67zp6',
      intent: '重启 nginx 使新配置生效',
      riskLevel: 'R3',
      status: 'waiting_approval',
      plan: ['备份配置', 'restart nginx', 'curl /healthz'],
      assertions: [{ kind: 'service_active', status: 'pending', spec: { unit: 'nginx.service' } }],
    },
  })
  const body = JSON.stringify(card.elements)
  return card.header.title.content.includes('R3')
    && body.includes('重启 nginx 托管服务')
    && body.includes('nginx.service')
    && body.includes('待二次确认')
    && body.includes('8h99a67zp6')
    && body.includes('重启 nginx 使新配置生效')
    && body.includes('备份配置')
    && body.includes('restart nginx')
    && body.includes('service_active')
    && body.includes('只读视图')
    && !card.elements.some((item) => item.tag === 'action')
})

await check('card 8: approval_detail is sent as a separate interactive card', async () => {
  const client = fakeClient()
  const transport = createFeishuTransport({ client })
  const ack = await transport.send(delivery({
    topic: 'approval.detail',
    replyToMsgId: 'om_anchor',
    payload: {
      kind: 'approval_detail',
      approvalId: 'ap_1',
      level: 'R3',
      summary: '重启 nginx',
      status: 'pending',
      text: 'R3 · 重启 nginx',
    },
  }))
  const call = client.calls[0]
  const content = JSON.parse(call.input.data.content)
  return call.method === 'reply'
    && call.input.data.msg_type === 'interactive'
    && content.header.title.content.includes('审批详情')
    && ack.externalMsgId === 'om_replied'
})

await check('card 9: R3 confirmation patches the original card with a confirm button', async () => {
  const client = fakeClient()
  const transport = createFeishuTransport({ client })
  const ack = await transport.send(delivery({
    topic: 'approval.confirm',
    replyToMsgId: 'om_card1',
    payload: {
      kind: 'approval_confirm',
      approvalId: 'ap_1',
      level: 'R3',
      summary: '重启 nginx',
      nonce: 'n_1',
      expiresAt: '2026-11-11T12:30:00.000Z',
      externalMsgId: 'om_card1',
      text: 'R3 需要再次确认',
    },
  }))
  const call = client.calls[0]
  const content = JSON.parse(call.input.data.content)
  const action = content.elements.find((item) => item.tag === 'action')
  const confirm = action.actions[0]
  const reject = action.actions[1]
  return client.calls.length === 1
    && call.method === 'patch'
    && call.input.path.message_id === 'om_card1'
    && content.header.title.content.includes('请再次确认')
    && action.actions.length === 2
    && confirm.text.content === '确认执行'
    && confirm.value.decision === 'confirm'
    && confirm.value.approval_id === 'ap_1'
    && confirm.value.nonce === 'n_1'
    && reject.value.decision === 'reject'
    && ack.externalMsgId === 'om_card1'
    && buildApprovalConfirmCard({
      kind: 'approval_confirm',
      approvalId: 'ap_2',
      level: 'R3',
      summary: 'x',
      nonce: 'n_2',
    }).header.template === 'red'
})

await check('card 9b: patched cards opt into update_multi', () => {
  const cards = [
    buildApprovalCard(approvalCardPayload()),
    buildApprovalConfirmCard({
      kind: 'approval_confirm',
      approvalId: 'ap_3',
      level: 'R3',
      summary: 'x',
      nonce: 'n_3',
    }),
    buildApprovalResultCard({ approvalId: 'ap_3', decision: 'approved' }),
  ]
  return cards.every((card) => card.config.update_multi === true)
})

await check('card 9c: callback answers can carry the next card atomically', () => {
  const card = { type: 'raw', data: { header: { template: 'red' } } }
  const confirm = toCardActionResponse({
    ok: true,
    toast: '已批准第一步，请点击「确认执行」',
    card,
  })
  const rejected = toCardActionResponse({ ok: false, toast: '处理失败：x' })
  return confirm.toast.type === 'success'
    && confirm.card === card
    && rejected.toast.type === 'warning'
    && rejected.card === undefined
    && toCardActionResponse(undefined).toast.content === '已处理'
})

await check('card 10: an unpatched confirmation degrades to a text reminder', async () => {
  const client = fakeClient({ noPatch: true })
  const transport = createFeishuTransport({ client })
  const ack = await transport.send(delivery({
    topic: 'approval.confirm',
    replyToMsgId: 'om_card1',
    payload: {
      kind: 'approval_confirm',
      approvalId: 'ap_1',
      level: 'R3',
      summary: '重启 nginx',
      nonce: 'n_1',
      externalMsgId: 'om_card1',
      text: '这是 R3 操作，需要再次确认',
    },
  }))
  return client.calls.length === 1
    && client.calls[0].method === 'reply'
    && JSON.parse(client.calls[0].input.data.content).text.includes('需要再次确认')
    && ack.externalMsgId === 'om_replied'
})

// -- channel (fake SDK module) ----------------------------------------------------------

await check('channel start wires WSClient with appId and resolves on ready', async () => {
  const lark = fakeLarkModule()
  const channel = createFeishuChannel({ appId: 'cli_a1', appSecret: 's', onMessage: () => {}, lark })
  await channel.start()
  assert.equal(lark.state.constructed.appId, 'cli_a1')
  assert.ok(lark.state.startOptions.eventDispatcher)
  await channel.stop()
  return channel.ready === false && lark.state.closed === true
})

await check('a received event is normalized and handed to onMessage', async () => {
  const lark = fakeLarkModule()
  const received = []
  const channel = createFeishuChannel({ appId: 'cli_a1', appSecret: 's', onMessage: (msg) => received.push(msg), lark })
  await channel.start()
  await lark.state.handlers['im.message.receive_v1'](makeTextEvent())
  await channel.stop()
  return received.length === 1
    && received[0].msgId === 'evt_1'
    && received[0].channelId === 'cli_a1'
    && received[0].content.text === '你好'
})

await check('a throwing onMessage is caught and logged, the connection survives', async () => {
  const lark = fakeLarkModule()
  const errors = []
  const logger = { info() {}, warn() {}, error: (msg, meta) => errors.push({ msg, meta }) }
  const channel = createFeishuChannel({
    appId: 'cli_a1',
    appSecret: 's',
    onMessage: () => { throw new Error('sink exploded') },
    logger,
    lark,
  })
  await channel.start()
  await lark.state.handlers['im.message.receive_v1'](makeTextEvent())
  const alive = channel.ready === true
  await channel.stop()
  return errors.length === 1
    && errors[0].meta.error === 'sink exploded'
    && errors[0].meta.msgId === 'evt_1'
    && JSON.stringify(errors[0].meta).includes('你好') === false // metadata only, never content
    && alive
})

await check('start fails loudly when ready never comes (AR13)', async () => {
  const lark = fakeLarkModule({ autoReady: false })
  const channel = createFeishuChannel({
    appId: 'cli_a1',
    appSecret: 's',
    onMessage: () => {},
    lark,
    readyTimeoutMs: 50,
  })
  await assert.rejects(() => channel.start(), /not ready/)
  return true
})

// -- credential resolution --------------------------------------------------------------

await check('bot config parses, selects by appId, and secretRef resolves from the store', () => {
  const configPath = join(dir, 'feishu-config.json')
  const credentialsPath = join(dir, 'credentials.yaml')
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    bots: [
      { id: 'b1', appId: 'cli_one', secretRef: 'SECRET_ONE', domain: '', botOpenId: 'ou_bot1' },
      { id: 'b2', appId: 'cli_two', secretRef: 'SECRET_TWO', domain: 'https://open.larksuite.com' },
    ],
  }))
  writeFileSync(credentialsPath, [
    'records:',
    '  something/else:',
    '    kind: grant',
    'refs:',
    '  SECRET_ONE: plain-secret-one',
    '  SECRET_TWO: "quoted-secret-two"',
    'other:',
    '  x: y',
    '',
  ].join('\n'))
  const first = loadFeishuBotConfig({ configPath })
  const second = loadFeishuBotConfig({ configPath, appId: 'cli_two' })
  return first.appId === 'cli_one'
    && first.secretRef === 'SECRET_ONE'
    && first.domain === null
    && second.domain === 'https://open.larksuite.com'
    && resolveSecretRef('SECRET_ONE', { credentialsPath }) === 'plain-secret-one'
    && resolveSecretRef('SECRET_TWO', { credentialsPath }) === 'quoted-secret-two'
})

await check('missing config / unknown secretRef fail loudly (AR13)', () => {
  assert.throws(() => loadFeishuBotConfig({ configPath: join(dir, 'nope.json') }), /cannot read bot config/)
  assert.throws(
    () => resolveSecretRef('MISSING', { credentialsPath: join(dir, 'credentials.yaml') }),
    /not found/,
  )
  return true
})

await check('plugin seam: name/inject/apply exist and apply registers nothing', () => {
  const logs = []
  apply({ logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } })
  return name === 'dsh-wfxm-feishu'
    && Array.isArray(inject)
    && logs.length === 1
})

await check('domain mapping: enum names and URLs resolve, garbage throws', () => {
  const sdkDomain = { Feishu: 'https://open.feishu.cn', LarkSuite: 'https://open.larksuite.com' }
  return resolveLarkDomain('feishu', sdkDomain) === sdkDomain.Feishu
    && resolveLarkDomain('lark', sdkDomain) === sdkDomain.LarkSuite
    && resolveLarkDomain(null, sdkDomain) === sdkDomain.Feishu
    && resolveLarkDomain('', sdkDomain) === sdkDomain.Feishu
    && resolveLarkDomain('https://custom.example.com', sdkDomain) === 'https://custom.example.com'
    && (() => {
      try {
        resolveLarkDomain('wechat', sdkDomain)
        return false
      } catch {
        return true
      }
    })()
})

// -- pairing end-to-end through the normalized shape (① gateway, real store) --------------

const store = createGatewayStore(join(dir, 'ops.sqlite'))
const owner = store.createActor({ displayName: 'owner' })

const ingestFeishu = async (event) => {
  const normalized = normalizeFeishuMessageEvent(event, { defaultChannelId: 'cli_a1' })
  assert.ok(normalized, 'fixture must normalize')
  return ingestInbound({ store }, {
    channelId: normalized.channelId,
    msgId: normalized.msgId,
    externalUserId: normalized.externalUserId,
    kind: normalized.kind,
    content: normalized.content,
    chatId: normalized.chatId,
    topicId: normalized.topicId,
    rootMsgId: normalized.rootMsgId,
    replyToMsgId: normalized.replyToMsgId,
  })
}

await check('pairing: mint → feishu /bind → bound, code spent, subsequent messages route', async () => {
  const minted = store.mintPairingCode({ actorId: owner.id, channelId: 'cli_a1' })
  const bind = await ingestFeishu(makeTextEvent({
    header: { event_id: 'evt_bind_1', event_type: 'im.message.receive_v1', app_id: 'cli_a1' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_new' } },
      message: { message_id: 'om_b1', chat_id: 'oc_c1', message_type: 'text', content: JSON.stringify({ text: `/bind ${minted.code}` }) },
    },
  }))
  const follow = await ingestFeishu(makeTextEvent({
    header: { event_id: 'evt_after_1', event_type: 'im.message.receive_v1', app_id: 'cli_a1' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_new' } },
      message: { message_id: 'om_b2', chat_id: 'oc_c1', message_type: 'text', content: JSON.stringify({ text: '磁盘怎么样' }) },
    },
  }))
  return bind.bypassReason === 'pairing'
    && bind.actor.id === owner.id
    && bind.inbox.status === 'done'
    && !bind.disposition.reason.includes(minted.code)
    && follow.bypassReason === null
    && follow.target.kind === 'orchestrator'
})

await check('pairing: replayed /bind and second claimant are both silent rejects', async () => {
  const minted = store.mintPairingCode({ actorId: owner.id })
  const first = await ingestFeishu(makeTextEvent({
    header: { event_id: 'evt_bind_2', event_type: 'im.message.receive_v1', app_id: 'cli_a1' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_claim1' } },
      message: { message_id: 'om_c1', chat_id: 'oc_c2', message_type: 'text', content: JSON.stringify({ text: `/bind ${minted.code}` }) },
    },
  }))
  const second = await ingestFeishu(makeTextEvent({
    header: { event_id: 'evt_bind_3', event_type: 'im.message.receive_v1', app_id: 'cli_a1' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_claim2' } },
      message: { message_id: 'om_c2', chat_id: 'oc_c2', message_type: 'text', content: JSON.stringify({ text: `/bind ${minted.code}` }) },
    },
  }))
  return first.bypassReason === 'pairing'
    && second.bypassReason === 'unpaired'
    && second.inbox.status === 'rejected'
    && store.resolveActor('cli_a1', 'ou_claim2') === null
})

await check('pairing: expired code is a silent reject; unpaired non-/bind is unchanged', async () => {
  const expired = store.mintPairingCode({ actorId: owner.id, now: new Date(Date.now() - 10 * 60_000) })
  const bind = await ingestFeishu(makeTextEvent({
    header: { event_id: 'evt_bind_4', event_type: 'im.message.receive_v1', app_id: 'cli_a1' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_late' } },
      message: { message_id: 'om_d1', chat_id: 'oc_c3', message_type: 'text', content: JSON.stringify({ text: `/bind ${expired.code}` }) },
    },
  }))
  const plain = await ingestFeishu(makeTextEvent({
    header: { event_id: 'evt_plain_1', event_type: 'im.message.receive_v1', app_id: 'cli_a1' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_stray' } },
      message: { message_id: 'om_d2', chat_id: 'oc_c3', message_type: 'text', content: JSON.stringify({ text: 'hello?' }) },
    },
  }))
  return bind.bypassReason === 'unpaired' && bind.inbox.status === 'rejected'
    && plain.bypassReason === 'unpaired' && plain.inbox.status === 'rejected'
    && store.resolveActor('cli_a1', 'ou_late') === null
})

await check('transport + dispatcher: a structural rejection fails the row without retries', async () => {
  const dispatcherStore = createGatewayStore(join(dir, 'dispatch.sqlite'))
  dispatcherStore.createActor({ displayName: 'o' })
  const item = dispatcherStore.enqueueOutbox({ topic: 'say', payload: { text: 'hi' } })
  const transport = createFeishuTransport({
    client: fakeClient({ replyError: { code: 99991663, msg: 'bot not in chat' } }),
  })
  const dispatcher = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'D' })
  const report = await dispatcher.runOnce()
  const row = dispatcherStore.getOutbox(item.id)
  dispatcherStore.close()
  return report.failed === 1
    && row.status === 'failed'
    && row.attempts === 1 // structural TransportError honored: no backoff retries
})

store.close()

console.log(`\nfeishu: ${pass} passed, ${fail} failed`)
rmSync(dir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
