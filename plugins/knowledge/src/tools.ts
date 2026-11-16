import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MemoryError, prepareFact, type FactKind, type FactScope, type FactSource } from './facts.js'
import { checkFacts } from './health.js'
import { createPathProbe } from './probes.js'
import { createMemoryStore, type MemoryStore } from './store.js'
import { DEFAULT_ENVIRONMENT_PREDICATES, gateFact, type FactProbe } from './verify.js'

/** Plugin name registered with the dsh Loader. */
export const name = 'dsh-wfxm-knowledge'

/** Host services this plugin consumes. */
export const inject = ['tools']

/**
 * Risk baseline per tool (11 §九·补 A):
 * R0 reads are autonomous; writing a fact is local and reversible (supersede),
 * hence R1 — autonomous with a summary, no approval round-trip.
 */
export const MEMORY_TOOL_RISK = {
  mem_facts: 'R0',
  mem_remember: 'R1',
  mem_health: 'R0',
} as const satisfies Record<string, 'R0' | 'R1'>

export const MEMORY_TOOL_PORT = 'Memory'

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

export interface MemoryToolsDeps {
  store: MemoryStore
  /** Read-only probe used by the write gate and the health check. */
  probe?: FactProbe
  predicates?: readonly string[]
  now?: () => Date
}

/** Same ops database as governance/svcops (single `ops.sqlite`, docs/15 §二). */
export function memoryDbPath(): string {
  if (process.env.DSH_WFXM_AUDIT_DB) return process.env.DSH_WFXM_AUDIT_DB
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'ops.sqlite')
}

const FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    scope: { type: 'string', required: true },
    projectId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    subject: { type: 'string', required: true },
    predicate: { type: 'string', required: true },
    value: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    source: { type: 'string', required: true },
    confidence: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
    verification: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    lastInjectedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    validFrom: { type: 'string', required: true },
  },
} as const

const FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer', required: true },
    facts: { type: 'array', required: true, items: FACT_SCHEMA },
  },
} as const

const REMEMBER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    written: { type: 'boolean', required: true },
    decision: { type: 'string', required: true },
    reason: { type: 'string', required: true },
    factId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    superseded: { type: 'boolean', required: true },
    redactions: { type: 'integer', required: true },
  },
} as const

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    check: { type: 'string', required: true },
    factId: { type: 'string', required: true },
    subject: { type: 'string', required: true },
    predicate: { type: 'string', required: true },
    detail: { type: 'string', required: true },
  },
} as const

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    factId: { type: 'string', required: true },
    subject: { type: 'string', required: true },
    predicate: { type: 'string', required: true },
    lastInjectedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    createdAt: { type: 'string', required: true },
    ageDays: { type: 'number', required: true },
  },
} as const

const HEALTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    checkedAt: { type: 'string', required: true },
    scanned: { type: 'integer', required: true },
    status: { type: 'string', required: true },
    counts: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        conflict: { type: 'integer', required: true },
        expired: { type: 'integer', required: true },
        'no-source': { type: 'integer', required: true },
        orphan: { type: 'integer', required: true },
        stale: { type: 'integer', required: true },
      },
    },
    findings: { type: 'array', required: true, items: FINDING_SCHEMA },
    reviewCandidates: { type: 'array', required: true, items: CANDIDATE_SCHEMA },
    probeUnavailable: { type: 'integer', required: true },
  },
} as const

function renderFacts(facts: Array<{
  subject: string
  predicate: string
  value: string
  kind: string
  source: string
  verification: string | null
  lastInjectedAt: string | null
}>): string {
  if (facts.length === 0) return 'no live facts'
  return facts.map((fact) => {
    const proof = fact.verification === null ? '' : ` [${fact.verification}]`
    const injected = fact.lastInjectedAt === null ? '' : ` injected ${fact.lastInjectedAt}`
    return `- ${fact.subject} / ${fact.predicate} = ${fact.value} (${fact.kind}/${fact.source}${proof}${injected})`
  }).join('\n')
}

function renderHealth(report: {
  checkedAt: string
  scanned: number
  status: string
  counts: { conflict: number; expired: number; 'no-source': number; orphan: number; stale: number }
  findings: Array<{ check: string; subject: string; predicate: string; detail: string }>
  reviewCandidates: Array<{ subject: string; predicate: string; ageDays: number }>
  probeUnavailable: number
}): string {
  const head = `fact health: ${report.status} — ${report.scanned} live fact(s) @ ${report.checkedAt}`
  const counts = `conflict ${report.counts.conflict} / expired ${report.counts.expired} / no-source ${report.counts['no-source']} / orphan ${report.counts.orphan} / stale ${report.counts.stale}`
  const lines = [
    head,
    counts,
    ...report.findings.map((f) => `finding ${f.check}: ${f.subject} / ${f.predicate} — ${f.detail}`),
    ...report.reviewCandidates.map((c) => `review candidate: ${c.subject} / ${c.predicate} — ${c.ageDays}d without injection`),
  ]
  if (report.probeUnavailable > 0) {
    lines.push(`probe unavailable for ${report.probeUnavailable} environment fact(s); not treated as stale`)
  }
  return lines.join('\n')
}

/**
 * Register the memory tools. `mem_facts` / `mem_health` are read-only; writing a
 * fact is local and reversible, so `mem_remember` is R1 and does not ask approval.
 */
export function registerMemoryTools(ctx: ContextLike, deps: MemoryToolsDeps): void {
  const registry = ctx.tools
  if (registry === undefined) {
    throw new Error('knowledge: ctx.tools is missing; mount the plugin in a scope that owns the tools registry')
  }
  const now = deps.now ?? (() => new Date())

  registry.register(defineTool({
    name: 'mem_facts',
    description: 'Query live fact cards (module ⑥): superseded rows are excluded. Filter by scope, project, subject and predicate. Read-only.',
    parameters: {
      scope: { type: 'string', enum: ['project', 'global'], description: 'Fact scope filter.' },
      projectId: { type: 'string', description: 'Project id filter (scope=project facts).' },
      subject: { type: 'string', description: 'Exact subject filter.' },
      predicate: { type: 'string', description: 'Exact predicate filter.' },
      limit: { type: 'integer', description: 'Max rows, 1-50. Defaults to 20.' },
    },
    output: {
      schema: FACTS_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.total === 0 ? 'no live facts' : `${value.total} live fact(s)\n${renderFacts(value.facts)}`,
      }],
    },
    async execute(args) {
      const limit = Math.min(50, Math.max(1, args.limit ?? 20))
      // 跨项目边界（08 §七 #3）：给 projectId 就读「本项目 + 全局偏好」；
      // 不给 projectId 时只读全局，绝不默认跨项目。
      if (args.scope === 'project' && (args.projectId === undefined || args.projectId === null)) {
        throw new MemoryError('missing-project', 'scope=project requires projectId')
      }
      const facts = deps.store.liveFacts({
        limit,
        ...args.projectId === undefined || args.projectId === null
          ? { scope: (args.scope ?? 'global') as FactScope }
          : { forProject: args.projectId },
        ...args.subject === undefined ? {} : { subject: args.subject },
        ...args.predicate === undefined ? {} : { predicate: args.predicate },
      })
      return {
        total: facts.length,
        facts: facts.map((fact) => ({
          id: fact.id,
          scope: fact.scope,
          projectId: fact.projectId,
          subject: fact.subject,
          predicate: fact.predicate,
          value: fact.value,
          kind: fact.kind,
          source: fact.source,
          confidence: fact.confidence,
          verification: fact.evidence?.verification ?? null,
          lastInjectedAt: fact.lastInjectedAt,
          validFrom: fact.validFrom,
        })),
      }
    },
  }))

  registry.register(defineTool({
    name: 'mem_remember',
    description: 'Write one fact card (module ⑥). kind=environment needs evidence and is checked by a read-only probe first: agreement writes, contradiction is rejected (old value kept), an unavailable probe writes with verification=unverified. kind=preference is never probed. Pass `supersedes` to replace an existing fact; rows are never deleted.',
    parameters: {
      subject: { type: 'string', required: true, description: 'What the fact is about, e.g. "dsh-wfxm".' },
      predicate: { type: 'string', required: true, description: 'The attribute, e.g. "package-manager" / "path".' },
      value: { type: 'string', required: true, description: 'The asserted value.' },
      kind: { type: 'string', required: true, enum: ['environment', 'preference'], description: 'environment = probe-verifiable; preference = owner-confirmed only.' },
      source: { type: 'string', required: true, enum: ['user-confirmed', 'observed', 'inferred', 'summary'], description: 'Provenance. inferred requires confidence.' },
      scope: { type: 'string', enum: ['project', 'global'], description: 'Defaults to global.' },
      projectId: { type: 'string', description: 'Required when scope=project.' },
      confidence: { type: 'number', description: 'In (0, 1]; required for source=inferred.' },
      probe: { type: 'string', description: 'Probe name for environment facts; defaults to predicate.' },
      observedValue: { type: 'string', description: 'What the probe saw; defaults to value.' },
      observedAt: { type: 'string', description: 'ISO timestamp; defaults to now.' },
      fingerprint: { type: 'string', description: 'Environment fingerprint; derived from the observation when omitted.' },
      supersedes: { type: 'string', description: 'Id of the live fact this one replaces.' },
    },
    output: {
      schema: REMEMBER_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.written
          ? `written ${value.factId} (${value.decision})${value.superseded ? ', previous fact superseded' : ''}${value.redactions > 0 ? `, ${value.redactions} secret(s) masked` : ''}\n${value.reason}`
          : `not written (${value.decision}): ${value.reason}`,
      }],
    },
    async execute(args) {
      const prepared = prepareFact({
        subject: args.subject,
        predicate: args.predicate,
        value: args.value,
        kind: args.kind as FactKind,
        source: args.source as FactSource,
        ...args.scope === undefined ? {} : { scope: args.scope as FactScope },
        ...args.projectId === undefined ? {} : { projectId: args.projectId },
        ...args.confidence === undefined ? {} : { confidence: args.confidence },
        evidence: args.kind === 'environment'
          ? {
              ...args.probe === undefined ? {} : { probe: args.probe },
              ...args.observedValue === undefined ? {} : { value: args.observedValue },
              ...args.observedAt === undefined ? {} : { observedAt: args.observedAt },
              ...args.fingerprint === undefined ? {} : { fingerprint: args.fingerprint },
            }
          : null,
      }, now())

      const target = args.supersedes === undefined ? null : deps.store.getFact(args.supersedes)
      if (args.supersedes !== undefined && (target === null || target.supersededBy !== null)) {
        throw new MemoryError(
          'invalid-fact',
          `supersedes target ${JSON.stringify(args.supersedes)} does not exist or is already superseded`,
        )
      }

      const gate = await gateFact(prepared.fact, {
        ...deps.probe === undefined ? {} : { probe: deps.probe },
        ...deps.predicates === undefined ? {} : { predicates: deps.predicates },
      })
      if (gate.decision === 'reject') {
        return {
          written: false,
          decision: gate.decision,
          reason: gate.reason,
          factId: null,
          superseded: false,
          redactions: prepared.redactions.length,
        }
      }

      const stored = deps.store.insertFact({
        ...prepared.fact,
        evidence: prepared.fact.evidence === null
          ? null
          : { ...prepared.fact.evidence, verification: gate.verification },
      })
      const superseded = args.supersedes === undefined
        ? false
        : deps.store.supersedeFact(args.supersedes, stored.id)
      return {
        written: true,
        decision: gate.decision,
        reason: gate.reason,
        factId: stored.id,
        superseded,
        redactions: prepared.redactions.length,
      }
    },
  }))

  registry.register(defineTool({
    name: 'mem_health',
    description: 'Run the fact health check (A2): conflicts / expired / no-source / orphan / stale, plus the review candidates that have not been injected for 30 days (D19-4). Read-only; staleness is reported, never auto-superseded.',
    parameters: {},
    output: {
      schema: HEALTH_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderHealth(value) }],
    },
    async execute() {
      return checkFacts({
        store: deps.store,
        now: now(),
        ...deps.probe === undefined ? {} : { probe: deps.probe },
      })
    },
  }))
}

/** Bundle entry point: open the memory store, then register the tools. */
export function apply(ctx: ContextLike): void {
  const store = createMemoryStore(memoryDbPath())
  ctx.logger?.info?.(`[knowledge] memory store ready at ${memoryDbPath()}`)
  // cordis has no `dispose` event; fiber-bound effects run on plugin unload.
  ctx.effect?.(() => () => store.close())
  ctx.logger?.info?.(
    `[knowledge] write gate probes: path only; predicates beyond ${DEFAULT_ENVIRONMENT_PREDICATES.join('/')} stay unverified`,
  )
  registerMemoryTools(ctx, { store, probe: createPathProbe() })
}
