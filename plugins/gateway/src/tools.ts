import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  GatewayError,
  ROUTE_ACTIONS,
  SESSION_KINDS,
  type RouteAction,
  type SessionKind,
} from './model.js'
import { resolveFollowUp } from './ingest.js'
import { createGatewayStore, type GatewayStore } from './store.js'

/** Plugin name registered with the dsh Loader. */
export const name = 'dsh-wfxm-gateway'

/** Host services this plugin consumes. */
export const inject = ['tools']

/**
 * Risk baseline per tool (11 §九·补 A). All three are R0: `say` only enqueues
 * an outbound message (the dispatcher delivers), and the other two are routing
 * bookkeeping that changes no system state.
 */
export const GATEWAY_TOOL_RISK = {
  say: 'R0',
  thread_lookup: 'R0',
  disposition_record: 'R0',
  outbox_retry: 'R1',
} as const satisfies Record<string, 'R0' | 'R1'>

/** Port attribution (17 §4.1): `say` is Channel; the other three are ① APIs. */
export const GATEWAY_TOOL_PORT = {
  say: 'Channel',
  thread_lookup: 'Gateway',
  disposition_record: 'Gateway',
  outbox_retry: 'Gateway',
} as const

interface Logger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

interface ContextLike {
  tools?: { register(tool: ToolDefinition): void }
  logger?: Logger
  effect?(run: () => () => void): unknown
  on?(event: string, handler: () => void): void
}

export interface GatewayToolsDeps {
  store: GatewayStore
}

/** Same ops database as governance/svcops/knowledge/tasks (single `ops.sqlite`, 15 §二). */
export function gatewayDbPath(): string {
  if (process.env.DSH_WFXM_AUDIT_DB) return process.env.DSH_WFXM_AUDIT_DB
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'ops.sqlite')
}

const OUTBOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    topic: { type: 'string', required: true },
    status: { type: 'string', required: true },
    attempts: { type: 'integer', required: true },
    threadId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    replyToMsgId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    taskId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    createdAt: { type: 'string', required: true },
  },
} as const

const SESSION_ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    channelId: { type: 'string', required: true },
    chatId: { type: 'string', required: true },
    sessionKind: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    projectId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    updatedAt: { type: 'string', required: true },
  },
} as const

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    triggerId: { type: 'string', required: true },
    action: { type: 'string', required: true },
    targetTaskId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    threadId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    reason: { type: 'string', required: true },
    confidence: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
    promptVersion: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    createdAt: { type: 'string', required: true },
  },
} as const

const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const

const THREAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    channelId: { type: 'string', required: true },
    chatId: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    topicId: { ...NULLABLE_STRING, required: true },
    rootMsgId: { ...NULLABLE_STRING, required: true },
    projectId: { ...NULLABLE_STRING, required: true },
    createdAt: { type: 'string', required: true },
    lastMsgAt: { ...NULLABLE_STRING, required: true },
  },
} as const

const FOLLOW_UP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    available: { type: 'boolean', required: true },
    taskId: { ...NULLABLE_STRING, required: true },
    status: { ...NULLABLE_STRING, required: true },
    round: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    ambiguous: { type: 'boolean', required: true },
    candidates: { type: 'array', required: true, items: { type: 'string' } },
    matchedBy: { ...NULLABLE_STRING, required: true },
    requiresGrantCheck: { type: 'boolean', required: true },
  },
} as const

const LOOKUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    routes: { type: 'array', required: true, items: SESSION_ROUTE_SCHEMA },
    decisions: { type: 'array', required: true, items: DECISION_SCHEMA },
    thread: { oneOf: [THREAD_SCHEMA, { type: 'null' }], required: true },
    followUp: { oneOf: [FOLLOW_UP_SCHEMA, { type: 'null' }], required: true },
  },
} as const

function renderRoute(route: { channelId: string; chatId: string; sessionKind: string; sessionId: string }): string {
  return `${route.channelId}/${route.chatId} ${route.sessionKind} → ${route.sessionId}`
}

function renderDecision(decision: { action: string; reason: string }): string {
  return `${decision.action} — ${decision.reason}`
}

/**
 * Register the gateway tools. Identity pairing and outbox delivery are *not*
 * tools: binding is an admin (Web channel) action per AR26, and delivery is the
 * dispatcher's job with an injected transport.
 */
export function registerGatewayTools(ctx: ContextLike, deps: GatewayToolsDeps): void {
  const registry = ctx.tools
  if (registry === undefined) {
    throw new Error('gateway: ctx.tools is missing; mount the plugin in a scope that owns the tools registry')
  }

  registry.register(defineTool({
    name: 'say',
    description: 'Reply to the owner through the gateway outbox (module ①). This only enqueues the message; the single dispatcher delivers it and records the transport message id. Use `threadId` (and `replyToMsgId` when replying in place) from the inbound message.',
    parameters: {
      text: { type: 'string', required: true, description: 'What to tell the owner.' },
      threadId: { type: 'string', required: true, description: 'Thread (channel chat / topic) to reply in.' },
      replyToMsgId: { type: 'string', description: 'Anchor message id; replies in place, never opens a new chat.' },
      taskId: { type: 'string', description: 'Task this message belongs to, when it is a task receipt / progress note.' },
    },
    output: {
      schema: OUTBOX_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `queued ${value.id} for ${value.threadId ?? '(no thread)'} (${value.status})`,
      }],
    },
    async execute(args) {
      return deps.store.enqueueOutbox({
        topic: 'say',
        payload: { text: args.text },
        threadId: args.threadId,
        ...args.replyToMsgId === undefined ? {} : { replyToMsgId: args.replyToMsgId },
        ...args.taskId === undefined ? {} : { taskId: args.taskId },
      })
    },
  }))

  registry.register(defineTool({
    name: 'thread_lookup',
    description: 'Read the thread routing state (module ①, read-only): the thread anchor, which session its chat maps to, the recorded route decisions, and whether a follow-up belongs to a live task. Use it before answering a follow-up so the reply lands in the right place and is not attached to the wrong task.',
    parameters: {
      threadId: { type: 'string', description: 'Thread anchor id (threads.id) from the inbound message.' },
      chatId: { type: 'string', description: 'Channel chat id, used to find the sticky session route.' },
      channelId: { type: 'string', description: 'Channel instance; defaults to the thread channel when a thread is known.' },
      sessionKind: {
        type: 'string',
        enum: [...SESSION_KINDS],
        description: 'orchestrator (the single foreground session) or chat (Web deep session).',
      },
      replyToMsgId: { type: 'string', description: 'Message being replied to; resolves the task anchor when it matches.' },
      limit: { type: 'integer', description: 'Max decisions, 1-50. Defaults to 20.' },
    },
    output: {
      schema: LOOKUP_SCHEMA,
      render: (_args, value) => {
        const lines: string[] = []
        if (value.thread !== null) {
          lines.push(`thread ${value.thread.id} (${value.thread.kind}) ${value.thread.channelId}/${value.thread.chatId}`)
        }
        lines.push(...value.routes.map(renderRoute))
        lines.push(...value.decisions.map(renderDecision))
        if (value.followUp !== null && value.followUp.available) {
          if (value.followUp.taskId !== null) lines.push(`follow-up → task ${value.followUp.taskId}`)
          else if (value.followUp.ambiguous) lines.push(`follow-up ambiguous: ${value.followUp.candidates.join(', ')}`)
        }
        return [{ type: 'text', text: lines.length === 0 ? 'no route for this thread' : lines.join('\n') }]
      },
    },
    async execute(args) {
      if (args.threadId === undefined && args.chatId === undefined) {
        throw new GatewayError('invalid-input', 'thread_lookup needs threadId or chatId')
      }
      const thread = args.threadId === undefined ? null : deps.store.getThread(args.threadId)
      const chatId = args.chatId ?? thread?.chatId
      const channelId = args.channelId ?? thread?.channelId
      const routes = chatId === undefined
        ? []
        : deps.store.listSessionRoutes({
          chatId,
          ...channelId === undefined ? {} : { channelId },
          ...args.sessionKind === undefined ? {} : { sessionKind: args.sessionKind as SessionKind },
        })
      const decisions = args.threadId === undefined
        ? []
        : deps.store.listRouteDecisions({
          threadId: args.threadId,
          limit: Math.min(50, Math.max(1, args.limit ?? 20)),
        })
      const followUp = chatId === undefined || channelId === undefined
        ? null
        : resolveFollowUp(deps.store, {
          channelId,
          chatId,
          threadId: args.threadId ?? null,
          replyToMsgId: args.replyToMsgId ?? null,
        })
      return { routes, decisions, thread, followUp }
    },
  }))

  registry.register(defineTool({
    name: 'disposition_record',
    description: 'Record what the gateway did with an inbound message and why (module ①, append-only). This answers "why did it not respond" / "why was this attached to that task" without reading the conversation.',
    parameters: {
      triggerId: { type: 'string', required: true, description: 'inbox.id of the triggering message.' },
      action: {
        type: 'string',
        required: true,
        enum: [...ROUTE_ACTIONS],
        description: 'answer / ack / ask / accept / attach / ignore / stop / wake.',
      },
      reason: { type: 'string', required: true, description: 'Why this disposition; one sentence.' },
      targetTaskId: { type: 'string', description: 'Task attached or addressed, when applicable.' },
      threadId: { type: 'string', description: 'Thread the message belongs to.' },
      confidence: { type: 'number', description: 'Routing confidence 0..1, when known.' },
      promptVersion: { type: 'string', description: 'Router prompt version, when the decision came from a model.' },
    },
    output: {
      schema: DECISION_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `recorded ${value.action} for ${value.triggerId}`,
      }],
    },
    async execute(args) {
      return deps.store.appendRouteDecision({
        triggerId: args.triggerId,
        action: args.action as RouteAction,
        reason: args.reason,
        ...args.targetTaskId === undefined ? {} : { targetTaskId: args.targetTaskId },
        ...args.threadId === undefined ? {} : { threadId: args.threadId },
        ...args.confidence === undefined ? {} : { confidence: args.confidence },
        ...args.promptVersion === undefined ? {} : { promptVersion: args.promptVersion },
      })
    },
  }))

  registry.register(defineTool({
    name: 'outbox_retry',
    description:
      'Requeue a failed outbox row (module ①). Use when the dispatcher has given up on a channel delivery (6 failed attempts) but you want to try again. Returns the row after retry; only rows in `failed` state can be retried.',
    parameters: {
      id: { type: 'string', description: 'outbox.id of the failed row. Optional when `all` is true.' },
      all: { type: 'boolean', description: 'Retry every row currently in `failed` state instead of one id.' },
      limit: { type: 'integer', description: 'Max rows to retry when `all` is true (default 20, max 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          retried: { type: 'integer', required: true, description: 'Number of rows requeued.' },
          rows: { type: 'array', items: OUTBOX_SCHEMA, required: true },
          errors: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `requeued ${value.retried} row(s)`,
          ...value.rows.map((row: { id: string; status: string; attempts: number; topic: string }) =>
            `• ${row.id.slice(0, 8)}… ${row.topic} (was failed×${row.attempts} → now ${row.status})`),
          ...value.errors.map((e: { id: string; error: string }) => `! ${e.id.slice(0, 8)}… ${e.error}`),
        ].join('\n'),
      }],
    },
    async execute(args) {
      const { id, all, limit } = args
      const store = deps.store
      if (all === true) {
        const cap = Math.min(100, Math.max(1, limit ?? 20))
        const rows = store.listOutbox({ status: 'failed', limit: cap })
        let retried = 0
        const updated: typeof rows = []
        const errors: { id: string; error: string }[] = []
        for (const row of rows) {
          try {
            updated.push(store.requeueOutbox(row.id))
            retried += 1
          } catch (err) {
            errors.push({
              id: row.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        return { retried, rows: updated, errors }
      }
      if (typeof id !== 'string' || id.length === 0) {
        throw new GatewayError('invalid-input', 'either id or all=true is required')
      }
      try {
        const row = store.requeueOutbox(id)
        return { retried: 1, rows: [row], errors: [] }
      } catch (err) {
        return {
          retried: 0,
          rows: [],
          errors: [{
            id,
            error: err instanceof Error ? err.message : String(err),
          }],
        }
      }
    },
  }))
}

/** Bundle entry point: open the gateway store, then register the tools. */
export function apply(ctx: ContextLike): void {
  const store = createGatewayStore(gatewayDbPath())
  ctx.logger?.info?.(`[gateway] inbox/outbox ready at ${gatewayDbPath()}`)
  // cordis has no `dispose` event; fiber-bound effects run on plugin unload.
  ctx.effect?.(() => () => store.close())
  ctx.logger?.info?.(
    '[gateway] outbox dispatcher not started: no channel transport is configured yet (inject OutboxTransport to deliver)',
  )
  registerGatewayTools(ctx, { store })
}
