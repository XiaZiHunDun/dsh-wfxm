/**
 * Model-backed front desk (docs/17 §二 `orchestrator`, slice D).
 *
 * The handler is still a `ForegroundHandler`: the host injects it exactly where
 * the rule foreground used to go, so nothing else in the composition changes.
 * What is new is *who decides* — one model turn turns the message into one of
 * three validated decisions (`reply` / `task` / `queue`) instead of every
 * message becoming a task.
 *
 * Guarantees kept by construction:
 *
 * - **#11 the front stage never executes**: it only creates tasks / queues input.
 *   The decision run itself is tool-less (see `assets/frontdesk.patch.yml`).
 * - **The model never widens scope**: `parseDecision` rejects R2/R3 and unknown
 *   shapes; a rejected or failed decision degrades to the deterministic rule
 *   foreground with a `note`, never to a guess.
 * - **A degradation is visible**: the outcome carries `note`, which the host
 *   records as a route decision (AR13: no silent drop, no silent fallback).
 *   A local quick answer carries `note: quick-answer:<kind>` for the same reason.
 */

import type { IngestResult } from '@dsh-wfxm/gateway'
import { planTaskRisk } from '@dsh-wfxm/tasks'
import type { RiskLevel, TaskStore } from '@dsh-wfxm/tasks'
import { parseDecision, type Decision, type DecisionRepeat } from './decision.js'
import { buildDecisionPrompt, type ConversationTurn } from './prompt.js'
import { createQuickAnswer, type QuickAnswer, type QuickChecks, type ResourceSnapshot } from './quick-answer.js'

/**
 * 已由宿主格式化好的提醒视图（本包不 import reminder，保持端口无关）。
 * `when` / `repeatLabel` 由宿主按 `Asia/Shanghai` 生成，模型与确认文案共用。
 */
export interface ReminderView {
  id: string
  text: string
  dueAt: string
  repeat: DecisionRepeat
  when: string
  repeatLabel: string
}

/** 前台能做的提醒写入，仅此三项；端口缺失即能力不存在。 */
export interface ReminderPort {
  create(input: {
    threadId: string
    text: string
    dueAt: string
    repeat: DecisionRepeat
    sourceMsgId: string | null
  }): ReminderView
  listPending(threadId: string, limit?: number): ReminderView[]
  cancel(id: string): ReminderView | null
}

export type ForegroundOutcome =
  | { action: 'task-created'; taskId: string; note?: string }
  | { action: 'input-queued'; taskId: string; inputId: string; note?: string }
  | { action: 'reply'; text: string; threadId: string; note?: string }
  | {
      action: 'reminder-created'
      reminderId: string
      text: string
      dueAt: string
      repeat: DecisionRepeat
      when: string
      repeatLabel: string
      threadId: string
      note?: string
    }
  | { action: 'reminder-list'; items: ReminderView[]; threadId: string; note?: string }
  | {
      action: 'reminder-cancelled'
      reminderId: string
      text: string
      when: string
      threadId: string
      note?: string
    }
  | { action: 'none'; reason: string; note?: string }

export interface ForegroundInput {
  result: IngestResult
  /** Plain text body, already extracted from the channel payload. */
  text: string | null
  /** Recent turns of this thread (旧→新), assembled by the host. */
  history?: readonly ConversationTurn[]
}

export type ForegroundHandler = (
  input: ForegroundInput,
) => ForegroundOutcome | Promise<ForegroundOutcome>

/**
 * Statuses that accept more input instead of starting a new task (#9).
 * `paused` is deliberately absent: a rejected approval leaves the task paused,
 * there is no resume entry yet, so keeping it "live" made every later message
 * attach to a task that can never run again (2026-11-13 实测，线程被永久占住).
 */
export const DEFAULT_LIVE_STATUSES: readonly string[] = [
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
]

/** Shown when the channel sends something the front desk cannot act on. */
export const NON_TEXT_REPLY = '暂时只支持文本消息，请直接发文字。'

export interface OrchestratorForegroundOptions {
  tasks: TaskStore
  /** The model seam: prompt in, raw model text out. `createDshDecisionRunner`. */
  decide: (prompt: string, sessionKey?: string) => Promise<string>
  /** Downgrade path for a failed / rejected decision. Defaults to the rule foreground. */
  fallback?: ForegroundHandler
  liveStatuses?: readonly string[]
  maxReplyChars?: number
  /**
   * ⑤ rejects intents over 500 characters; validating here means an oversized
   * intent degrades instead of throwing inside `createTask`.
   */
  maxIntentChars?: number
  logger?: { warn?(message: string): void } | null
  /**
   * Read-only resource probe (svcops `createResourceProbe`). When set, a
   * short, unambiguous resource question is answered locally instead of
   * spending a decision run — milliseconds instead of seconds.
   */
  probe?: (() => Promise<ResourceSnapshot>) | null
  /** Slice S: read-only unit / port / log checks; absent methods fall through. */
  checks?: QuickChecks | null
  /** Slice AT (J5): 提醒端口；缺失时前台不提供提醒动作。 */
  reminders?: ReminderPort | null
  /**
   * Slice BN (J2): 邮件待办提取端口（只读取数 + 一次模型提取）。
   * 返回已渲染的回复文本；null 表示没有可读取的邮件。
   */
  mailTodos?: ((input: { hours: number }) => Promise<string | null>) | null
  /**
   * Slice BP (J4): 应用日历只读端口，返回已渲染的回复文本；
   * null 表示日历尚未创建。异常由前台转成可读话术。
   */
  calendarView?: ((input: { days: number }) => Promise<string | null>) | null
  /** 可注入时钟（测试与提醒的相对时间换算）。 */
  now?: () => Date
}

interface LiveTask {
  id: string
  status: string
  intent: string
}

/** 「从邮件里提取最近 7 天的待办」这类明确请求；hours 已夹到 1..168。 */
export interface MailTodoRequest {
  hours: number
}

const MAIL_WORD = /(邮件|邮箱|收件箱|\binbox\b|\bmail\b)/i
const TODO_WORD = /(待办|待处理|要处理|需要处理|待跟进|要做的事|该处理|to[- ]?do)/i
/** 带副作用的邮件操作交给模型/执行者，不在这里劫持。 */
const MAIL_TODO_BLOCK = /(归档|删除|移除|清空|发送|发出|发一封|转发|退订|提醒)/

/** 默认回看 48 小时，与 `mail_todos` 的默认值一致。 */
const DEFAULT_MATCH_HOURS = 48
const MAX_MATCH_HOURS = 168

function matchHours(text: string): number {
  const days = /([0-9]+|[一两三四五六七])\s*(?:天|日)/.exec(text)
  if (days !== null) return clampHours(toNumber(days[1]) * 24)
  const hours = /([0-9]+|[一两三四五六七])\s*(?:个)?(?:小时|钟头|h\b)/i.exec(text)
  if (hours !== null) return clampHours(toNumber(hours[1]))
  if (/(一周|一个星期|一星期|最近一周|本周)/.test(text)) return MAX_MATCH_HOURS
  return DEFAULT_MATCH_HOURS
}

function toNumber(raw: string): number {
  const digits = Number(raw)
  if (Number.isInteger(digits)) return digits
  const numerals: Record<string, number> = { 一: 1, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 }
  return numerals[raw] ?? 0
}

function clampHours(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1
  return value > MAX_MATCH_HOURS ? MAX_MATCH_HOURS : Math.floor(value)
}

/**
 * 确定性识别「从邮件提取待办」。
 *
 * 模型在多轮对话里会把上一轮的回答当成答案（真机复现：重复同一请求只回
 * 「刚查过…」而不调用端口），所以命中这条窄句式时直接走端口，不经过决策
 * 模型。只认「邮件 + 待办/要处理」，带归档/发送/提醒等副作用词一律不拦截。
 */
export function matchMailTodoRequest(text: string): MailTodoRequest | null {
  if (!MAIL_WORD.test(text) || !TODO_WORD.test(text)) return null
  if (MAIL_TODO_BLOCK.test(text)) return null
  return { hours: matchHours(text) }
}

/** 「今天/明天/本周有什么日程」这类只读请求；days 已夹到 1..31。 */
export interface CalendarViewRequest {
  days: number
}

const CALENDAR_WORD = /(日程|日历|calendar)/i
const CALENDAR_VIEW_WORD = /(查看|看看|看一下|看下|有什么|有哪些|多少|哪些|忙不忙|空不空|安排|日程表|议程|排期)/i
/** 写意图/副作用词：交给模型与执行者，不在这里劫持。 */
const CALENDAR_WRITE_PATTERN =
  /(创建|新建|建立|添加|加一个|加个|建一个|建个|约|定在|定到|定个|定一个|修改|改成|更新|调整|推迟|提前|删除|取消|提醒)|安排[^。；;，,]{0,6}(?:会|会议|日程|日历)/
const MULTI_CLAUSE = /[，,。；;]|然后|顺便|再帮我/
const DEFAULT_CALENDAR_DAYS = 7
const MAX_CALENDAR_DAYS = 31

const NUMERALS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

function numeral(raw: string): number {
  const digits = Number(raw)
  if (Number.isInteger(digits)) return digits
  if (raw.length === 1) return NUMERALS[raw] ?? 0
  return 0
}

function clampDays(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1
  return value > MAX_CALENDAR_DAYS ? MAX_CALENDAR_DAYS : Math.floor(value)
}

function calendarDays(text: string): number {
  const days = /([0-9]+|[一二两三四五六七八九十]+)\s*(?:天|日)/.exec(text)
  if (days !== null) return clampDays(numeral(days[1]))
  const weeks = /([0-9]+|[一二两三四五六七八九十]+)\s*(?:个)?(?:周|星期)/.exec(text)
  if (weeks !== null) return clampDays(numeral(weeks[1]) * 7)
  if (/(今天|今日)/.test(text)) return 1
  if (/(明天|明日)/.test(text)) return 2
  if (/(后天)/.test(text)) return 3
  if (/(本周|这周|本星期|这星期)/.test(text)) return 7
  return DEFAULT_CALENDAR_DAYS
}

/**
 * 确定性识别「看看日程」这类只读请求。
 *
 * 只认「日历/日程 + 查看词」的短句；写意图（建/加/改/约/安排会议/取消/
 * 提醒）一律不拦截，交给模型与执行者。误判的代价不对称：误直答会答错，
 * 误交模型只是慢一点。
 */
export function matchCalendarViewRequest(text: string): CalendarViewRequest | null {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 40) return null
  if (MULTI_CLAUSE.test(trimmed)) return null
  if (!CALENDAR_WORD.test(trimmed)) return null
  if (!CALENDAR_VIEW_WORD.test(trimmed)) return null
  if (CALENDAR_WRITE_PATTERN.test(trimmed)) return null
  return { days: calendarDays(trimmed) }
}

function liveTaskOn(tasks: TaskStore, threadId: string, liveStatuses: readonly string[]): LiveTask | null {
  const bindings = tasks.listTaskThreads({ threadId, liveOnly: true })
  for (const binding of bindings) {
    const task = tasks.getTask(binding.taskId)
    if (task !== null && liveStatuses.includes(task.status)) {
      return { id: task.id, status: task.status, intent: task.intent }
    }
  }
  return null
}

export function createOrchestratorForeground(options: OrchestratorForegroundOptions): ForegroundHandler {
  const { tasks, decide } = options
  const liveStatuses = options.liveStatuses ?? DEFAULT_LIVE_STATUSES
  const logger = options.logger ?? null
  const quickAnswer = createQuickAnswer({ tasks, probe: options.probe ?? null, checks: options.checks ?? null })
  const reminders = options.reminders ?? null
  const mailTodos = options.mailTodos ?? null
  const calendarView = options.calendarView ?? null
  const clock = options.now ?? (() => new Date())

  /** Rule-shaped actions, so a model decision and a fallback look the same. */
  function createTask(result: IngestResult, threadId: string, intent: string, risk: RiskLevel): ForegroundOutcome {
    // The model never raises risk; this deterministic layer may (17 §7.1), and
    // attaches the template assertion that makes the escalation verifiable.
    const plan = planTaskRisk(intent, risk)
    const task = tasks.createTask({
      intent,
      riskLevel: plan.risk,
      originMsgId: result.inbox.msgId,
      projectId: result.project?.projectId ?? null,
    })
    for (const assertion of plan.assertions) tasks.addAssertion(task.id, assertion)
    tasks.bindThread({
      taskId: task.id,
      threadId,
      relation: 'default_owner',
      anchorMsgId: result.inbox.msgId,
    })
    return plan.reasons.length === 0
      ? { action: 'task-created', taskId: task.id }
      : { action: 'task-created', taskId: task.id, note: `risk-escalated:${plan.reasons.join(',')}` }
  }

  function queue(result: IngestResult, taskId: string): ForegroundOutcome {
    const input = tasks.enqueueInput({ taskId, inboxId: result.inbox.id })
    return { action: 'input-queued', taskId, inputId: input.id }
  }

  async function degrade(
    input: ForegroundInput,
    threadId: string,
    reason: string,
  ): Promise<ForegroundOutcome> {
    const note = `orchestrator-fallback: ${reason}`
    logger?.warn?.(note)
    if (options.fallback === undefined) {
      // No downgrade path configured: fail loudly instead of dropping the message.
      throw new Error(note)
    }
    const outcome = await options.fallback(input)
    return { ...outcome, note }
  }

  /** Slice BN: 只读提取，直接回话，不建任务、不写邮箱。 */
  async function runMailTodos(threadId: string, hours: number): Promise<ForegroundOutcome> {
    if (mailTodos === null) {
      return { action: 'reply', text: '邮件待办提取暂不可用。', threadId, note: 'mail-todos-unavailable' }
    }
    try {
      const replyText = await mailTodos({ hours })
      if (replyText === null || replyText.trim() === '') {
        return { action: 'reply', text: '没有读取到可提取的邮件。', threadId, note: 'mail-todos-empty' }
      }
      return { action: 'reply', text: replyText, threadId, note: 'mail-todos' }
    } catch (error) {
      logger?.warn?.(`mail todos failed: ${error instanceof Error ? error.message : String(error)}`)
      return { action: 'reply', text: '邮件待办提取失败，请稍后再试。', threadId, note: 'mail-todos-failed' }
    }
  }

  /** Slice BP (J4): 只读日程，直接回话，不建任务、不写日历。 */
  async function runCalendarView(threadId: string, days: number): Promise<ForegroundOutcome> {
    if (calendarView === null) {
      return { action: 'reply', text: '日程读取暂不可用。', threadId, note: 'calendar-unavailable' }
    }
    try {
      const replyText = await calendarView({ days })
      if (replyText === null || replyText.trim() === '') {
        return {
          action: 'reply',
          text: '尚未创建「dsh 日程」日历；请先在飞书中创建并订阅。',
          threadId,
          note: 'calendar-missing',
        }
      }
      return { action: 'reply', text: replyText, threadId, note: 'calendar-view' }
    } catch (error) {
      logger?.warn?.(`calendar view failed: ${error instanceof Error ? error.message : String(error)}`)
      return { action: 'reply', text: '日程读取失败，请稍后再试。', threadId, note: 'calendar-view-failed' }
    }
  }

  return async ({ result, text, history }) => {
    if (result.target.kind !== 'orchestrator') {
      return { action: 'none', reason: `target:${result.target.kind}` }
    }
    if (result.duplicate) return { action: 'none', reason: 'duplicate' }
    const thread = result.thread
    if (thread === null) return { action: 'none', reason: 'no-thread' }

    const trimmed = text === null ? '' : text.trim()
    if (trimmed === '') {
      return { action: 'reply', text: NON_TEXT_REPLY, threadId: thread.id }
    }

    // Deterministic first hand (docs/17 principle 2): a read-only status
    // question is answered by a probe, not by a model and not by a task.
    const quick: QuickAnswer | null = await quickAnswer(trimmed, thread.id)
    if (quick !== null) {
      return {
        action: 'reply',
        text: quick.text,
        threadId: thread.id,
        note: `quick-answer:${quick.kind}`,
      }
    }

    // Slice BP (J4): 「看看日程」是只读视图，交给端口直答，不跑模型。
    const calendarRequest = calendarView === null ? null : matchCalendarViewRequest(trimmed)
    if (calendarRequest !== null) return runCalendarView(thread.id, calendarRequest.days)

    // Slice BN: a repeated "提取邮件待办" must hit the port again. Letting the
    // decision model see the previous answer made it reply "刚查过…" instead of
    // re-reading the mailbox (真机复现), so this narrow shape bypasses the model.
    const mailRequest: MailTodoRequest | null = mailTodos === null ? null : matchMailTodoRequest(trimmed)
    if (mailRequest !== null) return runMailTodos(thread.id, mailRequest.hours)

    const live = liveTaskOn(tasks, thread.id, liveStatuses)
    const nowAt = clock()
    // 本轮只读一次：prompt 里的序号与取消时用的是同一份列表。
    const pendingReminders = reminders === null ? [] : reminders.listPending(thread.id, 8)
    const prompt = buildDecisionPrompt({
      text: trimmed,
      projectName: result.project?.name ?? null,
      liveTask: live,
      ...history === undefined ? {} : { history },
      now: nowAt,
      remindersEnabled: reminders !== null,
      todosEnabled: mailTodos !== null,
      calendarEnabled: calendarView !== null,
      reminders: pendingReminders.map((item, index) => ({
        index: index + 1,
        when: item.when,
        text: item.text,
        repeatLabel: item.repeatLabel,
      })),
    })

    let decision: Decision
    try {
      const raw = await decide(prompt, thread.id)
      const parsed = parseDecision(raw, {
        liveTask: live !== null,
        now: nowAt,
        remindersEnabled: reminders !== null,
        todosEnabled: mailTodos !== null,
        calendarEnabled: calendarView !== null,
        ...options.maxReplyChars === undefined ? {} : { maxReplyChars: options.maxReplyChars },
        ...options.maxIntentChars === undefined ? {} : { maxIntentChars: options.maxIntentChars },
      })
      if (!parsed.ok) return await degrade({ result, text, ...history === undefined ? {} : { history } }, thread.id, parsed.reason)
      decision = parsed.decision
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return await degrade({ result, text, ...history === undefined ? {} : { history } }, thread.id, `decision-failed: ${message}`)
    }

    if (decision.action === 'reply') {
      return { action: 'reply', text: decision.text, threadId: thread.id }
    }

    if (decision.action === 'queue') {
      // Validation already required a live task; re-check because the caller
      // may have closed it between the decision and now.
      if (live === null) return await degrade({ result, text }, thread.id, 'queue-without-task')
      return queue(result, live.id)
    }

    // Slice AT (J5): 提醒只是"登记一个未来的通知"，不建任务、不执行外部动作。
    if (decision.action === 'remind') {
      if (reminders === null) {
        return { action: 'reply', text: '提醒功能暂不可用。', threadId: thread.id, note: 'reminder-unavailable' }
      }
      try {
        const created = reminders.create({
          threadId: thread.id,
          text: decision.text,
          dueAt: decision.at,
          repeat: decision.repeat,
          sourceMsgId: result.inbox.msgId,
        })
        return {
          action: 'reminder-created',
          reminderId: created.id,
          text: created.text,
          dueAt: created.dueAt,
          repeat: created.repeat,
          when: created.when,
          repeatLabel: created.repeatLabel,
          threadId: thread.id,
        }
      } catch (error) {
        logger?.warn?.(`reminder create failed: ${error instanceof Error ? error.message : String(error)}`)
        return { action: 'reply', text: '设提醒失败，请稍后再试。', threadId: thread.id, note: 'reminder-failed' }
      }
    }

    if (decision.action === 'reminders') {
      return { action: 'reminder-list', items: [...pendingReminders], threadId: thread.id }
    }

    if (decision.action === 'cancel_remind') {
      const target = pendingReminders[decision.index - 1]
      if (reminders === null || target === undefined) {
        return {
          action: 'reply',
          text: `没有第 ${decision.index} 条待触发的提醒。`,
          threadId: thread.id,
          note: 'reminder-missing',
        }
      }
      const cancelled = reminders.cancel(target.id)
      if (cancelled === null) {
        return { action: 'reply', text: '这条提醒已不存在或已被取消。', threadId: thread.id, note: 'reminder-gone' }
      }
      return {
        action: 'reminder-cancelled',
        reminderId: cancelled.id,
        text: cancelled.text,
        when: cancelled.when,
        threadId: thread.id,
      }
    }

    // Slice BN (J2): 只读提取，直接回话，不建任务、不写邮箱。
    if (decision.action === 'mail_todos') return runMailTodos(thread.id, decision.hours)

    // Slice BP (J4): 只读日程，直接回话，不建任务、不写日历。
    if (decision.action === 'calendar_view') return runCalendarView(thread.id, decision.days)

    // A second task on the same thread would fight the live owner slot (#9), so
    // a work request while something is live is delivered as an input instead.
    if (live !== null) return queue(result, live.id)
    return createTask(result, thread.id, decision.intent, decision.risk)
  }
}
