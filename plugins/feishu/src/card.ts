/**
 * Feishu interactive cards for approvals (docs/14 §五/§六).
 *
 * Card JSON stays here on purpose: ① only carries a protocol-neutral payload
 * (`kind: 'approval_card' | 'approval_result'`), and this adapter is the only
 * place that knows what a Feishu card looks like (AR32).
 *
 * The buttons carry `approval_id` + `decision` + `nonce` + `channel_id`
 * (docs/14 §五). Decisions are never taken from card text — the button value is
 * the only thing trusted, and ③ remains the approval of record (AR10).
 */

import type { Json } from './transport.js'

export interface ApprovalCardPayload {
  readonly kind: 'approval_card'
  readonly approvalId: string
  readonly level: string
  readonly summary: string
  readonly nonce: string
  readonly impact?: Json
  readonly expiresAt?: string | null
  readonly channelId?: string | null
  /** Fallback copy for channels that cannot render cards. */
  readonly text?: string
  /** Optional addressing hint when the thread lookup is not wired. */
  readonly chatId?: string | null
}

export interface ApprovalResultPayload {
  readonly kind: 'approval_result'
  readonly approvalId: string
  readonly decision: 'approved' | 'rejected' | 'expired'
  readonly status?: string | null
  readonly text?: string
  /** Card message to patch; absent or empty means "send text instead". */
  readonly externalMsgId?: string | null
}

/** Read-only detail view (Slice L); rendered as a separate card, never a patch. */
export interface ApprovalDetailPayload {
  readonly kind: 'approval_detail'
  readonly approvalId: string
  readonly level: string
  readonly summary: string
  readonly status?: string | null
  readonly stage?: number | null
  readonly requestedAt?: string | null
  readonly expiresAt?: string | null
  readonly decidedAt?: string | null
  readonly decidedBy?: string | null
  readonly impact?: Json
  readonly task?: {
    readonly taskId?: string | null
    readonly taskRef?: string | null
    readonly intent?: string | null
    readonly riskLevel?: string | null
    readonly status?: string | null
    readonly plan?: Json
    readonly assertions?: readonly { kind?: string; status?: string; spec?: Json }[]
  } | null
  readonly text?: string
}

/** R3's second step (Slice L): patch the original card into an explicit confirm card. */
export interface ApprovalConfirmPayload {
  readonly kind: 'approval_confirm'
  readonly approvalId: string
  readonly level: string
  readonly summary: string
  readonly nonce: string
  readonly expiresAt?: string | null
  readonly externalMsgId?: string | null
  readonly text?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export function isApprovalCardPayload(payload: Json): payload is Json & ApprovalCardPayload {
  const record = asRecord(payload)
  return record !== null
    && record.kind === 'approval_card'
    && nonEmpty(record.approvalId) !== null
    && nonEmpty(record.level) !== null
    && nonEmpty(record.summary) !== null
    && nonEmpty(record.nonce) !== null
}

export function isApprovalResultPayload(payload: Json): payload is Json & ApprovalResultPayload {
  const record = asRecord(payload)
  return record !== null
    && record.kind === 'approval_result'
    && nonEmpty(record.approvalId) !== null
    && (record.decision === 'approved' || record.decision === 'rejected')
}

export function isApprovalDetailPayload(payload: Json): payload is Json & ApprovalDetailPayload {
  const record = asRecord(payload)
  return record !== null
    && record.kind === 'approval_detail'
    && nonEmpty(record.approvalId) !== null
    && nonEmpty(record.level) !== null
    && nonEmpty(record.summary) !== null
}

export function isApprovalConfirmPayload(payload: Json): payload is Json & ApprovalConfirmPayload {
  const record = asRecord(payload)
  return record !== null
    && record.kind === 'approval_confirm'
    && nonEmpty(record.approvalId) !== null
    && nonEmpty(record.level) !== null
    && nonEmpty(record.summary) !== null
    && nonEmpty(record.nonce) !== null
}

function shortTime(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null
  const iso = value.includes('T') ? value : value.replace(' ', 'T')
  const trimmed = iso.slice(0, 16).replace('T', ' ')
  return trimmed === '' ? null : trimmed
}

const MAX_IMPACT_LINES = 10
const MAX_IMPACT_CHARS = 200

/** Render `impact` as `key: value` lines; empty when nothing useful is there. */
export function formatImpact(impact: Json | undefined): string {
  if (impact === undefined || impact === null) return ''
  if (typeof impact === 'string') return impact.slice(0, MAX_IMPACT_CHARS)
  const record = asRecord(impact)
  if (record === null) return Array.isArray(impact) ? JSON.stringify(impact).slice(0, MAX_IMPACT_CHARS) : String(impact)
  return Object.entries(record)
    .slice(0, MAX_IMPACT_LINES)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key}: ${(text ?? '').slice(0, MAX_IMPACT_CHARS)}`
    })
    .join('\n')
}

function actionValue(payload: ApprovalCardPayload, decision: 'approve' | 'reject' | 'details'): Json {
  const value: Record<string, Json> = {
    approval_id: payload.approvalId,
    decision,
    nonce: payload.nonce,
  }
  if (payload.channelId !== null && payload.channelId !== undefined && payload.channelId !== '') {
    value.channel_id = payload.channelId
  }
  return value
}

function button(text: string, type: 'primary' | 'default' | 'danger', value: Json): Json {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: text },
    value,
  }
}

/** Build the "please confirm" card: title + summary + impact + validity + 2 buttons. */
export function buildApprovalCard(payload: ApprovalCardPayload): Json {
  const impact = formatImpact(payload.impact)
  const expires = shortTime(payload.expiresAt)
  const meta = [`审批 ${payload.approvalId}`]
  if (expires !== null) meta.push(`有效期至 ${expires}`)

  const elements: Json[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `**要做什么**\n${payload.summary}` } },
  ]
  if (impact !== '') {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**影响**\n${impact}` } })
  }
  elements.push({ tag: 'hr' })
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: meta.join('\n') } })
  elements.push({
    tag: 'action',
    actions: [
      button('批准', 'primary', actionValue(payload, 'approve')),
      button('拒绝', 'default', actionValue(payload, 'reject')),
      button('看详情', 'default', actionValue(payload, 'details')),
    ],
  })

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `需要确认 · ${payload.level}` },
    },
    elements,
  }
}

/** Build the decided card (no buttons — the approval is already settled). */
export function buildApprovalResultCard(payload: {
  approvalId: string
  decision: 'approved' | 'rejected' | 'expired'
  decidedAt?: string | null
}): Json {
  const approved = payload.decision === 'approved'
  const expired = payload.decision === 'expired'
  const at = shortTime(payload.decidedAt)
  const content = [`审批 ${payload.approvalId}`]
  if (at !== null) content.push(`更新于 ${at}`)
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: approved ? 'green' : expired ? 'grey' : 'red',
      title: { tag: 'plain_text', content: approved ? '已批准' : expired ? '已过期' : '已拒绝' },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: content.join('\n') } }],
  }
}

const MAX_SECTION_CHARS = 600

function clip(value: string): string {
  return value.length <= MAX_SECTION_CHARS ? value : `${value.slice(0, MAX_SECTION_CHARS)}…`
}

function section(title: string, body: string): Json {
  return { tag: 'div', text: { tag: 'lark_md', content: `**${title}**\n${clip(body)}` } }
}

function planLines(plan: Json | undefined): string {
  if (plan === undefined || plan === null) return ''
  if (typeof plan === 'string') return plan
  if (Array.isArray(plan)) {
    return plan
      .slice(0, 8)
      .map((step, index) => `${index + 1}. ${typeof step === 'string' ? step : JSON.stringify(step)}`)
      .join('\n')
  }
  const record = asRecord(plan)
  if (record !== null) {
    return Object.entries(record)
      .slice(0, 8)
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join('\n')
  }
  return String(plan)
}

function assertionLines(
  assertions: readonly { kind?: string; status?: string; spec?: Json }[] | undefined,
): string {
  if (assertions === undefined || assertions.length === 0) return ''
  return assertions
    .slice(0, 8)
    .map((item) => {
      const kind = item.kind ?? 'assertion'
      const detail = item.spec === undefined ? '' : ` ${JSON.stringify(item.spec)}`
      const status = item.status === undefined ? '' : `（${item.status}）`
      return `- ${kind}${detail}${status}`
    })
    .join('\n')
}

/**
 * Read-only detail card (Slice L): what the approval is about, why it is risky
 * (risk level, criteria, plan) and where it is in the timeline. It deliberately
 * carries no decision buttons — viewing must never change the approval.
 */
export function buildApprovalDetailCard(payload: ApprovalDetailPayload): Json {
  const task = payload.task ?? null
  const meta = [`审批 ${payload.approvalId}`, `风险 ${payload.level}`]
  const status = payload.status ?? 'pending'
  meta.push(status === 'pending' && (payload.stage ?? 0) > 0 ? '状态 pending（已点一次，待二次确认）' : `状态 ${status}`)
  const requested = shortTime(payload.requestedAt)
  const expires = shortTime(payload.expiresAt)
  const decided = shortTime(payload.decidedAt)
  if (requested !== null) meta.push(`发起 ${requested}`)
  if (expires !== null) meta.push(`有效期至 ${expires}`)
  if (decided !== null) meta.push(`决定 ${decided}${payload.decidedBy === null || payload.decidedBy === undefined ? '' : ` · ${payload.decidedBy}`}`)

  const elements: Json[] = [section('要做什么', payload.summary)]

  if (task !== null) {
    const taskMeta = [
      task.taskRef === null || task.taskRef === undefined ? null : `任务 ${task.taskRef}`,
      task.riskLevel === null || task.riskLevel === undefined ? null : `风险 ${task.riskLevel}`,
      task.status === null || task.status === undefined ? null : `状态 ${task.status}`,
      task.intent === null || task.intent === undefined ? null : `目标 ${task.intent}`,
    ].filter((line): line is string => line !== null)
    if (taskMeta.length > 0) elements.push(section('任务', taskMeta.join('\n')))
  }

  const impact = formatImpact(payload.impact)
  if (impact !== '') elements.push(section('影响', impact))

  const criteria = assertionLines(task?.assertions)
  elements.push(section('判据', criteria === '' ? '未登记可执行判据' : criteria))

  const plan = planLines(task?.plan)
  if (plan !== '') elements.push(section('计划', plan))

  elements.push({ tag: 'hr' })
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: meta.join('\n') } })
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: '_只读视图：查看详情不会改变审批状态，也不会消耗确认次数。_' },
  })

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `审批详情 · ${payload.level}` },
    },
    elements,
  }
}

/**
 * R3 second step (Slice L): the confirmation card replaces the original one.
 * Its primary button carries `decision: 'confirm'`, so only an explicit second
 * action settles the approval; another "approve" click changes nothing.
 */
export function buildApprovalConfirmCard(payload: ApprovalConfirmPayload): Json {
  const expires = shortTime(payload.expiresAt)
  const meta = [`审批 ${payload.approvalId}`, `风险 ${payload.level}`]
  if (expires !== null) meta.push(`有效期至 ${expires}`)

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: `${payload.level} · 请再次确认` },
    },
    elements: [
      section('要做什么', payload.summary),
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '这是高风险操作：刚才的「批准」只记录了第一步，**点击「确认执行」才会真正放行**。',
        },
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: meta.join('\n') } },
      {
        tag: 'action',
        actions: [
          button('确认执行', 'danger', {
            approval_id: payload.approvalId,
            decision: 'confirm',
            nonce: payload.nonce,
          }),
          button('拒绝', 'default', {
            approval_id: payload.approvalId,
            decision: 'reject',
            nonce: payload.nonce,
          }),
        ],
      },
    ],
  }
}
