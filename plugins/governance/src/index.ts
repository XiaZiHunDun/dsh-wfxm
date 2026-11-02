import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAuditStore, type AuditStore } from './audit/store.js'
import { toAuditFields, type SessionEventLike, type SessionLike } from './audit/events.js'

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
}
