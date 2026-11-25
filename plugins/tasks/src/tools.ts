import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAX_ASSERTIONS, prepareAssertions, type AssertionValidationOptions } from './assertions.js'
import { TaskError, requiresCriteria, type RiskLevel, type Task, type TaskStatus } from './model.js'
import { rollbackTask, type CheckpointRollbackPort } from './rollback.js'
import { createTaskStore, type TaskStore } from './store.js'
import { completeTask, verifyTask, type VerificationResult, type VerifyContext } from './verify.js'

/** Plugin name registered with the dsh Loader. */
export const name = 'dsh-wfxm-tasks'

/** Host services this plugin consumes. */
export const inject = ['tools']

/**
 * Risk baseline per tool (11 §九·补 A). `task_submit` inherits the declared
 * risk at execution time; enqueueing itself is local and reversible (R1).
 */
export const TASK_TOOL_RISK = {
  task_submit: 'R1',
  task_status: 'R0',
  task_control: 'R1',
  /**
   * Restoring pre-images only touches files the task itself wrote (bounded,
   * local, reversible) → R1 per 11 §九·补 A. The trigger is always explicit.
   */
  task_rollback: 'R1',
} as const satisfies Record<string, 'R0' | 'R1'>

export const TASK_TOOL_PORT = 'TaskRuntime'

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

export interface TaskToolsDeps {
  store: TaskStore
  /** ⑦ adapter (`createPreimageRollbackPort`); absent = `task_rollback` fails loudly. */
  rollbackPort?: CheckpointRollbackPort
  /** Static assertion allowlists (registered units / ports / hostnames / roots). */
  assertionOptions?: AssertionValidationOptions
  /** Adapter hooks for assertion kinds that need SvcOps / Browser / git. */
  verify?: Omit<VerifyContext, 'execExitCode'>
  now?: () => Date
}

/** Same ops database as governance/svcops/knowledge (single `ops.sqlite`, 15 §二). */
export function taskDbPath(): string {
  if (process.env.DSH_WFXM_AUDIT_DB) return process.env.DSH_WFXM_AUDIT_DB
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'ops.sqlite')
}

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    projectId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    conversationId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    sessionId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    startCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    intent: { type: 'string', required: true },
    riskLevel: { type: 'string', required: true },
    status: { type: 'string', required: true },
    attempt: { type: 'integer', required: true },
    maxAttempts: { type: 'integer', required: true },
    correlationId: { type: 'string', required: true },
    round: { type: 'integer', required: true },
    originMsgId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    taskRef: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    createdAt: { type: 'string', required: true },
    startedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    finishedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  },
} as const

const ASSERTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    spec: { type: 'json', required: true },
    status: { type: 'string', required: true },
    evidence: { oneOf: [{ type: 'json' }, { type: 'null' }], required: true },
    checkedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  },
} as const

const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true },
    type: { type: 'string', required: true },
    payload: { oneOf: [{ type: 'json' }, { type: 'null' }], required: true },
    createdAt: { type: 'string', required: true },
  },
} as const

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assertionId: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    status: { type: 'string', required: true },
    evidence: { type: 'json', required: true },
    checkedAt: { type: 'string', required: true },
  },
} as const

const VERIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    overall: { type: 'string', required: true },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        pass: { type: 'integer', required: true },
        fail: { type: 'integer', required: true },
        skipped: { type: 'integer', required: true },
      },
    },
    results: { type: 'array', required: true, items: RESULT_SCHEMA },
    checkedAt: { type: 'string', required: true },
  },
} as const

const SUBMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { ...TASK_SCHEMA, required: true },
    assertionIds: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer', required: true },
    tasks: { type: 'array', required: true, items: TASK_SCHEMA },
    task: { oneOf: [TASK_SCHEMA, { type: 'null' }], required: true },
    assertions: { type: 'array', required: true, items: ASSERTION_SCHEMA },
    events: { type: 'array', required: true, items: EVENT_SCHEMA },
  },
} as const

const CONTROL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    task: { ...TASK_SCHEMA, required: true },
    verification: { oneOf: [VERIFICATION_SCHEMA, { type: 'null' }], required: true },
  },
} as const

const CHECKPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    taskId: { type: 'string', required: true },
    seq: { type: 'integer', required: true },
    label: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    status: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    closedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  },
} as const

const ROLLBACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { ...TASK_SCHEMA, required: true },
    checkpointId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    restored: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          state: { type: 'string', required: true },
        },
      },
    },
    closedCheckpoints: { type: 'array', required: true, items: { type: 'string' } },
    checkpoints: { type: 'array', required: true, items: CHECKPOINT_SCHEMA },
  },
} as const

/** Assertions are declared as typed objects; the static validator is the gate. */
const ASSERTION_ITEM = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'exit_code', required: true },
        expected: { type: 'integer', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'file_exists', required: true },
        path: { type: 'string', required: true },
        sha256: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'port_listening', required: true },
        port: { type: 'integer', required: true },
        host: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'service_active', required: true },
        unit: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'unit_restarted', required: true },
        unit: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'http_status', required: true },
        url: { type: 'string', required: true },
        expected: { type: 'integer' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'git_diff_matches', required: true },
        ref: { type: 'string', required: true },
        paths: { type: 'array', items: { type: 'string' } },
        expect: { type: 'string', enum: ['changed', 'unchanged'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'page_contains', required: true },
        url: { type: 'string', required: true },
        selector: { type: 'string', required: true },
        expect: { type: 'string', required: true },
      },
    },
  ],
} as const

interface RenderTask {
  id: string
  status: string
  riskLevel: string
  attempt: number
  maxAttempts: number
  intent: string
}

interface RenderVerification {
  overall: string
  counts: { pass: number; fail: number; skipped: number }
  results: Array<{ kind: string; status: string }>
}

function renderTask(task: RenderTask): string {
  return `${task.id} ${task.status} ${task.riskLevel} attempt ${task.attempt}/${task.maxAttempts} — ${task.intent}`
}

function renderVerification(verification: RenderVerification): string {
  const head = `verify ${verification.overall} — pass ${verification.counts.pass} / fail ${verification.counts.fail} / skipped ${verification.counts.skipped}`
  return [
    head,
    ...verification.results.map((result) => `- ${result.kind}: ${result.status}`),
  ].join('\n')
}

/**
 * Register the task tools. The state machine is enforced by the store; these
 * tools are a thin, typed surface over it.
 */
export function registerTaskTools(ctx: ContextLike, deps: TaskToolsDeps): void {
  const registry = ctx.tools
  if (registry === undefined) {
    throw new Error('tasks: ctx.tools is missing; mount the plugin in a scope that owns the tools registry')
  }
  const now = deps.now ?? (() => new Date())
  const verifyContext = (execExitCode?: number | null): VerifyContext => ({
    ...deps.verify,
    now,
    ...execExitCode === undefined ? {} : { execExitCode },
  })

  registry.register(defineTool({
    name: 'task_submit',
    description: `Submit one task (module ⑤). Declare how success will be judged with executable assertions (${MAX_ASSERTIONS} max): exit_code / file_exists / port_listening / service_active / unit_restarted / http_status / git_diff_matches / page_contains. R2 and R3 tasks without assertions are rejected (17 §8.7). Tasks start queued.`,
    parameters: {
      intent: { type: 'string', required: true, description: 'What the task must achieve, one sentence.' },
      riskLevel: { type: 'string', required: true, enum: ['R0', 'R1', 'R2', 'R3'], description: 'Declared risk; R2+ requires assertions.' },
      projectId: { type: 'string', description: 'Project scope (module ⑥ id).' },
      conversationId: { type: 'string', description: 'Originating conversation.' },
      sessionId: { type: 'string', description: 'dsh session id.' },
      startCursor: { type: 'string', description: 'Task start position in the session (AR1).' },
      maxAttempts: { type: 'integer', description: 'Retry ceiling, 1-10. Defaults to 2.' },
      round: { type: 'integer', description: 'Thread round, defaults to 1.' },
      resources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Declared non-file resources (port:<proto>:<port> / db:<path> / unit:<name> / docker:<project> / git:<repoRoot>). Leased before execution when DSH_WFXM_RESOURCE_LOCKS=1.',
      },
      assertions: {
        type: 'array',
        items: ASSERTION_ITEM,
        description: 'Executable success criteria; read-only checks evaluated after execution.',
      },
    },
    output: {
      schema: SUBMIT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `submitted ${renderTask(value.task)} (${value.assertionIds.length} assertion(s))`,
      }],
    },
    async execute(args) {
      const prepared = prepareAssertions(args.assertions, deps.assertionOptions)
      if (requiresCriteria(args.riskLevel as RiskLevel) && prepared.length === 0) {
        throw new TaskError(
          'criteria-required',
          `${args.riskLevel} tasks must declare at least one executable assertion (13 §3.1)`,
        )
      }
      const task = deps.store.createTask({
        intent: args.intent,
        riskLevel: args.riskLevel as RiskLevel,
        ...args.projectId === undefined ? {} : { projectId: args.projectId },
        ...args.conversationId === undefined ? {} : { conversationId: args.conversationId },
        ...args.sessionId === undefined ? {} : { sessionId: args.sessionId },
        ...args.startCursor === undefined ? {} : { startCursor: args.startCursor },
        ...args.maxAttempts === undefined ? {} : { maxAttempts: args.maxAttempts },
        ...args.round === undefined ? {} : { round: args.round },
        ...args.resources === undefined || args.resources.length === 0
          ? {}
          : { plan: { resources: args.resources } },
      })
      const assertionIds = prepared.map((assertion) => deps.store.addAssertion(task.id, assertion).id)
      return { task, assertionIds }
    },
  }))

  registry.register(defineTool({
    name: 'task_status',
    description: 'Read task state (module ⑤). With taskId: the task, its assertions and its event trail. Without: list tasks filtered by status / project. Read-only.',
    parameters: {
      taskId: { type: 'string', description: 'Exact task id.' },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'waiting_approval', 'waiting_input', 'paused', 'succeeded', 'failed', 'cancelled'],
        description: 'Status filter for listing.',
      },
      projectId: { type: 'string', description: 'Project filter for listing.' },
      limit: { type: 'integer', description: 'Max rows, 1-50. Defaults to 20.' },
    },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.task == null
          ? (value.total === 0 ? 'no tasks' : `${value.total} task(s)\n${value.tasks.map(renderTask).join('\n')}`)
          : `${renderTask(value.task)}\n${value.assertions.map((a) => `- ${a.kind}: ${a.status}`).join('\n')}`,
      }],
    },
    async execute(args) {
      if (args.taskId !== undefined) {
        const task = deps.store.getTask(args.taskId)
        return {
          total: task === null ? 0 : 1,
          tasks: task === null ? [] : [task],
          task,
          assertions: task === null ? [] : deps.store.listAssertions(task.id),
          events: task === null ? [] : deps.store.listEvents(task.id),
        }
      }
      const limit = Math.min(50, Math.max(1, args.limit ?? 20))
      const tasks = deps.store.listTasks({
        ...args.status === undefined ? {} : { status: args.status as TaskStatus },
        ...args.projectId === undefined ? {} : { projectId: args.projectId },
        limit,
      })
      return { total: tasks.length, tasks, task: null, assertions: [], events: [] }
    },
  }))

  registry.register(defineTool({
    name: 'task_control',
    description: 'Drive one task (module ⑤): pause / resume / cancel / fail / verify / complete. Execution is started only by the worker claiming the task; `resume` merely re-queues a paused task, and approval is decided by the owner, never by this tool. `complete` runs the Verifier and only then allows succeeded; a failed or undecidable assertion refuses success. Terminal transitions write a receipt.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Target task id.' },
      action: {
        type: 'string',
        required: true,
        enum: ['pause', 'resume', 'cancel', 'fail', 'verify', 'complete'],
        description: 'Control action.',
      },
      reason: { type: 'string', description: 'Why (written to the event trail / receipt).' },
      summary: { type: 'string', description: 'Receipt summary for cancel / fail / complete.' },
      evidenceLocator: { type: 'string', description: 'Where the evidence lives (file / url / audit id).' },
      execExitCode: { type: 'integer', description: 'Recorded exit code of the executed command, for exit_code assertions.' },
    },
    output: {
      schema: CONTROL_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.verification === null
          ? `${value.action}: ${renderTask(value.task)}`
          : `${value.action}: ${renderTask(value.task)}\n${renderVerification(value.verification)}`,
      }],
    },
    async execute(args) {
      const current = deps.store.getTask(args.taskId)
      if (current === null) throw new TaskError('invalid-task', `task ${args.taskId} not found`)

      switch (args.action) {
        case 'resume': {
          // L0: this tool never starts execution. A queued task is already
          // waiting for the worker; a paused one goes back to the queue.
          if (current.status === 'queued') {
            return { action: args.action, task: current, verification: null }
          }
          if (current.status === 'paused') {
            return { action: args.action, task: deps.store.resumeTask(args.taskId), verification: null }
          }
          const hint = current.status === 'waiting_approval'
            ? 'approval is decided by the owner through the approval card'
            : 'execution starts only when the worker claims the task'
          throw new TaskError(
            'invalid-transition',
            `resume requires paused (or queued); ${args.taskId} is ${current.status}; ${hint}`,
          )
        }
        case 'pause': {
          const task = deps.store.transition(args.taskId, {
            to: 'paused',
            ...args.reason === undefined ? {} : { reason: args.reason },
          })
          return { action: args.action, task, verification: null }
        }
        case 'cancel': {
          const task = deps.store.transition(args.taskId, {
            to: 'cancelled',
            summary: args.summary ?? args.reason ?? 'cancelled by owner',
            evidenceLocator: args.evidenceLocator ?? null,
            ...args.reason === undefined ? {} : { reason: args.reason },
          })
          return { action: args.action, task, verification: null }
        }
        case 'fail': {
          const task = deps.store.transition(args.taskId, {
            to: 'failed',
            summary: args.summary ?? args.reason ?? 'task failed',
            evidenceLocator: args.evidenceLocator ?? null,
            ...args.reason === undefined ? {} : { reason: args.reason },
          })
          return { action: args.action, task, verification: null }
        }
        case 'verify': {
          const verification = await verifyTask(deps.store, args.taskId, verifyContext(args.execExitCode))
          return { action: args.action, task: deps.store.getTask(args.taskId) as Task, verification }
        }
        case 'complete': {
          const { task, verification } = await completeTask(deps.store, args.taskId, {
            ...verifyContext(args.execExitCode),
            ...args.summary === undefined ? {} : { summary: args.summary },
            evidenceLocator: args.evidenceLocator ?? null,
          })
          return { action: args.action, task, verification }
        }
        default:
          // Enum validation normally catches this; keep the runtime fail-closed
          // too (a direct caller must not get `undefined` back).
          throw new TaskError(
            'invalid-input',
            `unknown action ${JSON.stringify(args.action)}; execution starts only when the worker claims the task`,
          )
      }
    },
  }))

  registry.register(defineTool({
    name: 'task_rollback',
    description: 'Undo a task\'s writes (module ⑤). With checkpointId: restore that one step; without: restore every pre-image the task captured. Explicit trigger only, never automatic. Touches only files the task wrote (R1, 11 §九·补 A); files the task created are reported but not deleted.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Target task id.' },
      checkpointId: { type: 'string', description: 'Step to undo (⑤ task_checkpoints id). Omit for the whole task.' },
      reason: { type: 'string', description: 'Why (written to the event trail).' },
    },
    output: {
      schema: ROLLBACK_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `rolled back ${value.checkpointId ?? 'whole task'}: ${value.restored.length} file(s) restored`
          + (value.closedCheckpoints.length > 0 ? `, ${value.closedCheckpoints.length} open step(s) aborted` : ''),
      }],
    },
    async execute(args) {
      const port = deps.rollbackPort
      if (port === undefined) {
        throw new TaskError(
          'rollback-failed',
          'no rollback port mounted; ⑦ pre-image adapter (createPreimageRollbackPort) was not injected',
        )
      }
      return rollbackTask({
        store: deps.store,
        port,
        taskId: args.taskId,
        ...args.checkpointId === undefined ? {} : { checkpointId: args.checkpointId },
        ...args.reason === undefined ? {} : { reason: args.reason },
      })
    },
  }))
}

/** Bundle entry point: open the task store, then register the tools. */
export function apply(ctx: ContextLike): void {
  const store = createTaskStore(taskDbPath())
  ctx.logger?.info?.(`[tasks] task store ready at ${taskDbPath()}`)
  // cordis has no `dispose` event; fiber-bound effects run on plugin unload.
  ctx.effect?.(() => () => store.close())
  ctx.logger?.info?.(
    '[tasks] verifier adapters: file_exists / port_listening / http_status / git_diff_matches built in; service_active / unit_restarted / page_contains stay skipped until mounted',
  )
  registerTaskTools(ctx, { store })
}
