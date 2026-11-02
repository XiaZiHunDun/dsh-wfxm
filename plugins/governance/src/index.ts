import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAuditStore, type AuditStore } from './audit/store.js'
import { toAuditFields, type SessionEventLike, type SessionLike } from './audit/events.js'
import { installConcurrency } from './concurrency/guard.js'
import { loadPolicy, policyPath } from './policy/config.js'
import { evaluate } from './policy/rules.js'
import { createDecisionStore } from './policy/store.js'

export const name = 'dsh-wfxm-governance'

interface Logger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

interface ContextLike {
  on(event: string, listener: (...args: any[]) => void, options?: { global?: boolean }): () => void
  logger?: Logger
}

interface ToolCallLike {
  callId: string
  name: string
  arguments: unknown
}

export function auditDbPath(): string {
  if (process.env.DSH_WFXM_AUDIT_DB) return process.env.DSH_WFXM_AUDIT_DB
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'ops.sqlite')
}

/**
 * Step 2a: subscribe the dsh session event feed and append audited events to
 * `audit_log` with the frozen hash chain. Opening the store is fail-closed: a
 * store that cannot be initialized prevents the plugin from mounting.
 */
export function apply(ctx: ContextLike): void {
  const dbPath = auditDbPath()
  const store: AuditStore = createAuditStore(dbPath)
  ctx.logger?.info?.(`[governance] audit sink ready at ${dbPath}`)

  ctx.on(
    'session/event',
    (session: SessionLike, event: SessionEventLike) => {
      const fields = toAuditFields(session, event)
      if (!fields) return
      const result = store.append(fields)
      if (result) {
        ctx.logger?.info?.(`[governance] audit seq=${result.seq} action=${fields.action}`)
      }
    },
    { global: true },
  )

  ctx.on('dispose', () => store.close())

  const policy = loadPolicy()
  if (policy === null) {
    ctx.logger?.warn?.(`[governance] no policy at ${policyPath()}; tool gating disabled`)
    return
  }

  const decisions = createDecisionStore(dbPath)
  ctx.logger?.info?.(`[governance] policy v${policy.version} active (kill switch: ${policy.killSwitchPath})`)

  ctx.on('tools/pre-execute', async (exec: ToolCallLike, next: () => Promise<unknown>) => {
    const result = evaluate(policy, exec.name, exec.arguments)
    decisions.record({
      correlationId: exec.callId,
      ruleId: result.rule,
      rulesetVersion: String(policy.version),
      inputDigest: createHash('sha256').update(JSON.stringify(exec.arguments ?? null)).digest('hex'),
      verdict: result.verdict,
      reason: result.reason,
    })
    if (result.verdict === 'allow') return next()
    return { kind: 'deny', reason: result.reason ?? result.rule }
  })

  ctx.on('dispose', () => decisions.close())

  installConcurrency(
    ctx,
    {
      enabled: policy.concurrency.writeSerialization,
      conflictLimit: policy.concurrency.conflictLimit,
    },
    decisions,
  )
}
