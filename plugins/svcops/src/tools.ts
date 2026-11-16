import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createNtfyFromEnv, withQuietWindow, type NotifyPort } from '@dsh-wfxm/notify'
import { hostname } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONTAINER_PREFIX,
  createDockerAdapter,
  isManagedContainer,
} from './docker.js'
import {
  DEFAULT_CHECKLIST_ID,
  DEFAULT_THRESHOLDS,
  evaluate,
  type InspectionReport,
  type InspectionThresholds,
} from './inspection/checklist.js'
import { gradeInspection } from './inspection/alerting.js'
import { readInspectionConfig } from './inspection/config.js'
import { collectHostMetrics } from './inspection/probes.js'
import { summarize, type InspectionDigest } from './inspection/report.js'
import { createInspectionStore, type InspectionStore } from './inspection/store.js'
import {
  DEFAULT_UNIT_PREFIX,
  SvcOpsError,
  createSystemdAdapter,
  isManagedUnit,
  spawnRunner,
} from './systemd.js'
import type {
  CommandRunner,
  ServiceActionResult,
  ServiceInfo,
  ServiceLogs,
  ServiceStatus,
  SvcAction,
  SvcOpsPort,
  SvcRisk,
} from './systemd.js'

/** Plugin name registered with the dsh Loader. */
export const name = 'dsh-wfxm-svcops'

/** Host services this plugin consumes. */
export const inject = ['tools']

/** Risk baseline and owning port per tool, consumed by the startup self-check. */
export const SVC_TOOL_RISK = {
  svc_list: 'R0',
  svc_status: 'R0',
  svc_logs: 'R0',
  svc_inspect: 'R0',
  svc_report: 'R0',
  svc_start: 'R3',
  svc_stop: 'R3',
  svc_restart: 'R3',
} as const satisfies Record<string, SvcRisk>

export const SVC_TOOL_PORT = 'SvcOps'

interface ApprovalServiceLike {
  request(req: {
    agent: unknown
    toolName: string
    callId: string
    reason: string
    signal?: AbortSignal
  }): Promise<string>
}

interface Logger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

interface ContextLike {
  tools?: { register(tool: ToolDefinition): void }
  get?(name: string): unknown
  logger?: Logger
  effect?(run: () => () => void): unknown
  on?(event: string, handler: () => void): void
}

export interface SvcToolsDeps {
  /** Explicit single adapter; used by tests and by deployments that pin one runtime. */
  adapter?: SvcOpsPort
  /** Runtime auto-selection: every adapter is probed lazily; absent runtimes are dropped. */
  adapters?: SvcOpsPort[]
  /** Injected by `apply()`; tests pass a temp-db store. */
  inspections?: InspectionStore
  /** Outbound P0 delivery (NotifyPort, docs/11). Absent = delivery disabled. */
  notifier?: NotifyPort
  runner?: CommandRunner
  thresholds?: InspectionThresholds
  expectedPorts?: number[]
}

/** Same ops database as governance (single `ops.sqlite`, docs/15 §二). */
export function inspectionDbPath(): string {
  if (process.env.DSH_WFXM_AUDIT_DB) return process.env.DSH_WFXM_AUDIT_DB
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'ops.sqlite')
}

/**
 * Quiet window for repeat P0 pushes: 30 minutes by default, 0 disables, invalid
 * values fall back to the default rather than silently silencing alerts.
 */
export function quietWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DSH_WFXM_NOTIFY_QUIET_MINUTES
  if (raw === undefined || raw.trim() === '') return 30 * 60_000
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes < 0) return 30 * 60_000
  return minutes * 60_000
}

const SERVICE_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unit: { type: 'string', required: true },
    loadState: { type: 'string', required: true },
    activeState: { type: 'string', required: true },
    subState: { type: 'string', required: true },
    description: { type: 'string', required: true },
  },
} as const

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SERVICE_INFO_SCHEMA.properties,
    unitFileState: { type: 'string', required: true },
    mainPid: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    activeEnterTimestamp: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    restarts: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
  },
} as const

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runtime: { type: 'string', required: true },
    services: { type: 'array', required: true, items: SERVICE_INFO_SCHEMA },
  },
} as const

const LOGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unit: { type: 'string', required: true },
    lines: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unit: { type: 'string', required: true },
    action: { type: 'string', required: true },
    changed: { type: 'boolean', required: true },
  },
} as const

const INSPECTION_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true },
    status: { type: 'string', required: true },
    value: { type: 'string', required: true },
    threshold: { type: 'string', required: true },
    detail: { type: 'string' },
  },
} as const

const INSPECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    checklistId: { type: 'string', required: true },
    target: { type: 'string', required: true },
    status: { type: 'string', required: true },
    ranAt: { type: 'string', required: true },
    items: { type: 'array', required: true, items: INSPECTION_ITEM_SCHEMA },
    alert: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        level: { type: 'string', required: true },
        reasons: { type: 'array', required: true, items: { type: 'string' } },
      },
    },
    delivery: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            transport: { type: 'string', required: true },
            level: { type: 'string', required: true },
            id: { type: 'string', required: true },
          },
        },
        { type: 'null' },
      ],
      required: true,
    },
  },
} as const

const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hours: { type: 'integer', required: true },
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    runs: { type: 'integer', required: true },
    byStatus: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        ok: { type: 'integer', required: true },
        warn: { type: 'integer', required: true },
        fail: { type: 'integer', required: true },
        skipped: { type: 'integer', required: true },
      },
    },
    byAlert: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        silent: { type: 'integer', required: true },
        digest: { type: 'integer', required: true },
        immediate: { type: 'integer', required: true },
      },
    },
    latest: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            target: { type: 'string', required: true },
            status: { type: 'string', required: true },
            ranAt: { type: 'string', required: true },
            level: { type: 'string', required: true },
          },
        },
        { type: 'null' },
      ],
      required: true,
    },
    findings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const UNIT_PARAMETER = {
  type: 'string',
  required: true,
  description: `Managed service id: a systemd unit (${DEFAULT_UNIT_PREFIX}<name>.service) or a docker container (${DEFAULT_CONTAINER_PREFIX}<name>).`,
} as const

const ACTION_RISK_DESCRIPTION = 'This action changes host state and requires user approval.'

function getApprover(ctx: ContextLike): ApprovalServiceLike | undefined {
  const approver = ctx.get?.('approval')
  return approver === undefined ? undefined : approver as ApprovalServiceLike
}

/** Route one service id to the adapter that owns its runtime; unknown ids are rejected. */
function resolveAdapter(adapters: SvcOpsPort[], unit: string): SvcOpsPort {
  const adapter = adapters.find((candidate) =>
    candidate.runtime === 'docker' ? isManagedContainer(unit) : isManagedUnit(unit))
  if (adapter === undefined) {
    throw new SvcOpsError(
      'not-allowed',
      `service ${JSON.stringify(unit)} is outside the managed scope of the ${adapters.map((item) => item.runtime).join('/')} adapter`,
    )
  }
  return adapter
}

/** Detect each runtime once per plugin instance; an absent runtime stays dropped. */
function makeDetection(adapter: SvcOpsPort): () => Promise<boolean> {
  let detection: Promise<boolean> | undefined
  return async () => {
    detection ??= adapter.detect()
    return detection
  }
}

function makeAvailabilityCheck(detect: () => Promise<boolean>, runtime: string): () => Promise<void> {
  return async () => {
    if (!(await detect())) {
      throw new SvcOpsError('unavailable', `service runtime ${runtime} is not available on this host`)
    }
  }
}

async function requireWriteApproval(
  ctx: ContextLike,
  toolName: string,
  unit: string,
  exec: { agent?: unknown; callId: string; signal?: AbortSignal },
): Promise<void> {
  const approver = getApprover(ctx)
  if (approver === undefined) {
    throw new Error(`${toolName} requires user approval, but no approval service is mounted`)
  }
  if (exec.agent === undefined) {
    throw new Error(`${toolName} requires an agent session to route the approval request`)
  }
  const outcome = await approver.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason: `${toolName}: ${unit}`,
    ...exec.signal === undefined ? {} : { signal: exec.signal },
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`${toolName} was not approved (${outcome}); no action was taken on ${unit}`)
  }
}

function renderService(info: ServiceInfo): string {
  return `${info.unit} [${info.activeState}/${info.subState}] ${info.description}`.trim()
}

function renderInspection(report: {
  checklistId: string
  status: string
  target: string
  ranAt: string
  items: Array<{ label: string; status: string; value: string; threshold: string; detail?: string }>
  alert: { level: string; reasons: string[] }
  delivery: { transport: string; level: string; id: string } | null
}): string {
  const head = `inspection ${report.checklistId} @ ${report.target}: ${report.status} (${report.ranAt})`
  const alert = report.alert.level === 'silent'
    ? []
    : [`alert ${report.alert.level}: ${report.alert.reasons.join('; ')}`]
  const delivered = report.delivery === null
    ? []
    : [`delivered ${report.delivery.transport} ${report.delivery.level}${report.delivery.id === '' ? '' : ` (${report.delivery.id})`}`]
  const lines = report.items.map((item) => {
    const detail = item.detail === undefined ? '' : ` — ${item.detail}`
    return `${item.status.padEnd(7)} ${item.label}: ${item.value} [${item.threshold}]${detail}`
  })
  return [head, ...alert, ...delivered, ...lines].join('\n')
}

function renderDigest(digest: InspectionDigest): string {
  const head = `inspection digest last ${digest.hours}h @ ${digest.from} → ${digest.to}: ${digest.runs} run(s)`
  if (digest.runs === 0 || digest.latest === null) return `${head}; no inspections in this window`
  return [
    head,
    `status: ok ${digest.byStatus.ok} / warn ${digest.byStatus.warn} / fail ${digest.byStatus.fail} / skipped ${digest.byStatus.skipped}`,
    `alerts: silent ${digest.byAlert.silent} / digest ${digest.byAlert.digest} / immediate ${digest.byAlert.immediate}`,
    `latest: ${digest.latest.ranAt} ${digest.latest.target} ${digest.latest.status} (alert ${digest.latest.level})`,
    ...digest.findings.map((finding) => `finding: ${finding}`),
  ].join('\n')
}

/**
 * Register the SvcOps tools in the mounting scope. Read tools run without
 * approval; every state-changing tool asks `ctx.approval` first and executes
 * only on `allowed-once`.
 */
export function registerSvcTools(ctx: ContextLike, deps: SvcToolsDeps = {}): void {
  const registry = ctx.tools
  if (registry === undefined) {
    throw new Error('svcops: ctx.tools is missing; mount the plugin in a scope that owns the tools registry')
  }
  const adapters = deps.adapters ?? (deps.adapter === undefined ? [createSystemdAdapter()] : [deps.adapter])
  const detections = new Map(adapters.map((adapter) => [adapter, makeDetection(adapter)]))
  const detectOf = (adapter: SvcOpsPort): (() => Promise<boolean>) =>
    detections.get(adapter) ?? makeDetection(adapter)
  const ensureAvailable = (adapter: SvcOpsPort): Promise<void> =>
    makeAvailabilityCheck(detectOf(adapter), adapter.runtime)()

  registry.register(defineTool({
    name: 'svc_list',
    description: `List the services managed by dsh-wfxm: systemd units (${DEFAULT_UNIT_PREFIX}*) or docker containers (${DEFAULT_CONTAINER_PREFIX}*, both label-gated). Read-only.`,
    parameters: {},
    output: {
      schema: LIST_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.services.length === 0
          ? `runtime: ${value.runtime}; no managed services`
          : `runtime: ${value.runtime}; ${value.services.length} managed services\n${value.services.map(renderService).join('\n')}`,
      }],
    },
    async execute() {
      const runtimes: string[] = []
      const services: ServiceInfo[] = []
      for (const adapter of adapters) {
        if (!(await detectOf(adapter)())) continue
        runtimes.push(adapter.runtime)
        services.push(...await adapter.list())
      }
      if (runtimes.length === 0) {
        throw new SvcOpsError(
          'unavailable',
          `no supported service runtime is available on this host (tried: ${adapters.map((adapter) => adapter.runtime).join('/')})`,
        )
      }
      return { runtime: runtimes.join('+'), services }
    },
  }))

  registry.register(defineTool({
    name: 'svc_status',
    description: 'Show the current state of one managed service (systemd unit or docker container). Read-only.',
    parameters: { unit: UNIT_PARAMETER },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: [
          `unit: ${value.unit}`,
          `load: ${value.loadState}`,
          `active: ${value.activeState} (${value.subState})`,
          `unit-file: ${value.unitFileState}`,
          `main-pid: ${value.mainPid ?? '-'}`,
          `active-since: ${value.activeEnterTimestamp ?? '-'}`,
          `restarts: ${value.restarts ?? '-'}`,
          `description: ${value.description}`,
        ].join('\n'),
      }],
    },
    async execute(args) {
      const adapter = resolveAdapter(adapters, args.unit)
      await ensureAvailable(adapter)
      const status: ServiceStatus = await adapter.status(args.unit)
      return status
    },
  }))

  registry.register(defineTool({
    name: 'svc_logs',
    description: 'Read the latest journal/docker log lines of one managed service (1-500 lines). Read-only.',
    parameters: {
      unit: UNIT_PARAMETER,
      lines: {
        type: 'integer',
        description: 'Number of latest journal lines to return, 1-500. Defaults to 100.',
      },
    },
    output: {
      schema: LOGS_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.lines.length === 0 ? `${value.unit}: no journal lines` : value.lines.join('\n'),
      }],
    },
    async execute(args) {
      const adapter = resolveAdapter(adapters, args.unit)
      await ensureAvailable(adapter)
      const logs: ServiceLogs = await adapter.logs(args.unit, args.lines)
      return logs
    },
  }))

  const inspections = deps.inspections
  const notifier = deps.notifier
  const runner = deps.runner ?? spawnRunner
  const thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS
  const expectedPorts = deps.expectedPorts ?? []

  registry.register(defineTool({
    name: 'svc_inspect',
    description: `Run the minimal safe host inspection (${DEFAULT_CHECKLIST_ID}): disk, memory, load per core, failed units, listening ports, log error rate. Read-only; the report is appended to the inspections table, graded into silent/digest/immediate (G6), and immediate findings are pushed through the notify port when one is configured (repeat pushes for the same host are suppressed inside the quiet window).`,
    parameters: {},
    output: {
      schema: INSPECTION_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderInspection(value) }],
    },
    async execute() {
      if (inspections === undefined) {
        throw new Error('svc_inspect requires the inspections store; mount the plugin through apply()')
      }
      const metrics = await collectHostMetrics({
        runner,
        expectedPorts,
        logWindowMinutes: thresholds.logWindowMinutes,
      })
      const report: InspectionReport = evaluate(metrics, thresholds, expectedPorts)
      const record = inspections.save({
        checklistId: report.checklistId,
        target: hostname(),
        status: report.status,
        items: report.items,
      })
      const alert = gradeInspection(report)
      let delivery: { transport: string; level: string; id: string } | null = null
      if (alert.level === 'immediate' && notifier !== undefined) {
        try {
          const receipt = await notifier.notify('p0', {
            title: `[P0] 巡检告警 @ ${record.target}`,
            body: [
              `inspection ${record.checklistId}: ${record.status} (${record.ranAt})`,
              ...alert.reasons,
            ].join('\n'),
            tags: ['rotating_light'],
            key: `${record.checklistId}:${record.target}`,
          })
          if (receipt.suppressed === true) {
            ctx.logger?.info?.(`[svcops] P0 push suppressed by the quiet window for ${record.checklistId}:${record.target}`)
          } else {
            delivery = { transport: receipt.transport, level: 'p0', id: receipt.id }
          }
        } catch (error) {
          // Delivery must never fail the inspection itself; surface it in the log.
          ctx.logger?.warn?.(`[svcops] P0 delivery failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return {
        checklistId: record.checklistId,
        target: record.target,
        status: record.status,
        ranAt: record.ranAt,
        items: record.items,
        alert,
        delivery,
      }
    },
  }))

  registry.register(defineTool({
    name: 'svc_report',
    description: 'Summarize host inspections over a window (1-168h, default 24): run count, status/alert distribution and de-duplicated findings, newest first. Read-only (G3).',
    parameters: {
      hours: {
        type: 'integer',
        description: 'Window in hours, clamped to 1-168. Defaults to 24.',
      },
    },
    output: {
      schema: DIGEST_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderDigest(value) }],
    },
    async execute(args) {
      if (inspections === undefined) {
        throw new Error('svc_report requires the inspections store; mount the plugin through apply()')
      }
      const hours = Math.min(168, Math.max(1, args.hours ?? 24))
      const now = new Date()
      const from = new Date(now.getTime() - hours * 3_600_000)
      const records = inspections.listSince(from.toISOString(), now.toISOString())
      return summarize(records, { hours, now })
    },
  }))

  const registerAction = (action: SvcAction, description: string): void => {
    const toolName = `svc_${action}`
    registry.register(defineTool({
      name: toolName,
      description: `${description} ${ACTION_RISK_DESCRIPTION}`,
      parameters: { unit: UNIT_PARAMETER },
      output: {
        schema: ACTION_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: `${value.action}: ${value.unit} ${value.changed ? 'done' : 'no change'}`,
        }],
      },
      async execute(args, exec) {
        const adapter = resolveAdapter(adapters, args.unit)
        await ensureAvailable(adapter)
        await requireWriteApproval(ctx, toolName, args.unit, exec)
        const result: ServiceActionResult = await adapter[action](args.unit)
        return result
      },
    }))
  }

  registerAction('start', 'Start one managed service (systemd unit or docker container).')
  registerAction('stop', 'Stop one managed service (systemd unit or docker container).')
  registerAction('restart', 'Restart one managed service (systemd unit or docker container).')
}

/** Bundle entry point: open the inspections store, then register the tools. */
export function apply(ctx: ContextLike): void {
  const inspections = createInspectionStore(inspectionDbPath())
  ctx.logger?.info?.(`[svcops] inspection store ready at ${inspectionDbPath()}`)
  // cordis has no `dispose` event; fiber-bound effects run on plugin unload.
  ctx.effect?.(() => () => inspections.close())
  const inspection = readInspectionConfig()
  for (const warning of inspection.warnings) ctx.logger?.warn?.(`[svcops] ${warning}`)
  if (inspection.expectedPorts.length > 0) {
    ctx.logger?.info?.(`[svcops] expected ports: ${inspection.expectedPorts.join(', ')}`)
  }
  const notifier = createNtfyFromEnv()
  const window = quietWindowMs()
  const deliveryPort = notifier === undefined || window === 0
    ? notifier
    : withQuietWindow(notifier, { windowMs: window })
  ctx.logger?.info?.(deliveryPort === undefined
    ? '[svcops] DSH_WFXM_NTFY_TOPIC is unset; P0 delivery disabled'
    : `[svcops] P0 delivery via ${deliveryPort.transport} (quiet window ${window / 60_000} min)`)
  const unitControl = process.env.DSH_WFXM_UNIT_CONTROL?.trim()
  const controlCommand = unitControl === undefined || unitControl === '' ? undefined : unitControl.split(/\s+/)
  ctx.logger?.info?.(controlCommand === undefined
    ? '[svcops] unit writes call systemctl directly (works only when running as root)'
    : `[svcops] unit writes via ${controlCommand.join(' ')}`)
  registerSvcTools(ctx, {
    adapters: [
      controlCommand === undefined ? createSystemdAdapter() : createSystemdAdapter({ controlCommand }),
      createDockerAdapter(),
    ],
    inspections,
    thresholds: inspection.thresholds,
    expectedPorts: inspection.expectedPorts,
    ...deliveryPort === undefined ? {} : { notifier: deliveryPort },
  })
}
