import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '@dsh-wfxm/sql-migrate'
import { uuidv7 } from '../audit/store.js'

const MIGRATION_MODULE = 'grant'
/** docs/15 §七: SQL files sit next to the package, outside the compiled `lib/`. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'grant')

export type GrantKind = 'once' | 'session' | 'forever'

/**
 * 授权范围。`actions` 必填；`domains` / `paths` 省略 = 不限定。
 * `actions` 中的 `*` 表示该 grant 覆盖任意动作（仅用于"本会话 / 永久"）。
 */
export interface GrantScope {
  actions: string[]
  domains?: string[]
  paths?: string[]
}

export interface Grant {
  id: string
  actorId: string
  kind: GrantKind
  scope: GrantScope
  sourceApprovalId: string | null
  grantedAt: string
  expiresAt: string | null
  revokedAt: string | null
  consumedAt: string | null
  policyVersion: string | null
}

export interface CreateGrantInput {
  actorId: string
  scope: GrantScope
  kind?: GrantKind
  sourceApprovalId?: string
  expiresAt?: string | null
  policyVersion?: string | number | null
}

export interface GrantRequirement {
  actions?: string[]
  domain?: string
  path?: string
}

export type GrantCheckReason =
  | 'ok'
  | 'not-found'
  | 'revoked'
  | 'consumed'
  | 'expired'
  | 'actor-mismatch'
  | 'policy-version-mismatch'
  | 'scope-mismatch'

export interface VerifyGrantInput {
  actorId: string
  required?: GrantRequirement
  /** 指定则只验这一张（能回报 revoked / consumed / expired 等具体原因） */
  grantId?: string
  /** AR37 复验项：与发放时记录的策略版本不一致即拒绝 */
  policyVersion?: string | number | null
  /** "本次"授权在通过时兑付；session / forever 不受影响 */
  consume?: boolean
  now?: Date
}

export interface GrantCheckResult {
  ok: boolean
  reason: GrantCheckReason
  grantId?: string
  grant?: Grant
}

export type GrantErrorCode = 'invalid-input' | 'not-found' | 'duplicate-source'

export class GrantError extends Error {
  constructor(
    readonly code: GrantErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GrantError'
  }
}

export interface ListGrantsInput {
  actorId?: string
  includeRevoked?: boolean
  includeConsumed?: boolean
}

export interface RevokeResult {
  ok: boolean
  code: 'ok' | 'not-found'
  grant?: Grant
}

export interface GrantStoreOptions {
  now?: () => Date
}

export interface GrantStore {
  create(input: CreateGrantInput): Grant
  get(grantId: string): Grant | null
  find(actorId: string, options?: { kind?: GrantKind }): Grant | null
  list(input?: ListGrantsInput): Grant[]
  revoke(grantId: string): RevokeResult
  /** 击杀开关 / 紧急吊销：撤销该 actor 的全部 Grant（AR20） */
  revokeAll(actorId?: string): { revoked: number }
  verify(input: VerifyGrantInput): GrantCheckResult
  close(): void
}

interface GrantRow {
  id: string
  actor_id: string
  kind: GrantKind
  scope_json: string
  source_approval_id: string | null
  granted_at: string
  expires_at: string | null
  revoked_at: string | null
  consumed_at: string | null
  policy_version: string | null
}

function migrate(db: Database): void {
  runMigrations(db, { module: MIGRATION_MODULE, dir: MIGRATIONS_DIR })
}

function parseScope(raw: string): GrantScope {
  const fallback: GrantScope = { actions: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
  const source = parsed as Record<string, unknown>
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
  const actions = strings(source.actions)
  if (actions === undefined) return fallback
  const scope: GrantScope = { actions }
  const domains = strings(source.domains)
  if (domains !== undefined) scope.domains = domains
  const paths = strings(source.paths)
  if (paths !== undefined) scope.paths = paths
  return scope
}

function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    actorId: row.actor_id,
    kind: row.kind,
    scope: parseScope(row.scope_json),
    sourceApprovalId: row.source_approval_id,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    consumedAt: row.consumed_at,
    policyVersion: row.policy_version,
  }
}

function assertCreateInput(input: CreateGrantInput): void {
  if (typeof input.actorId !== 'string' || input.actorId.trim().length === 0) {
    throw new GrantError('invalid-input', 'grant requires a non-empty actorId')
  }
  const actions = input.scope?.actions
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new GrantError('invalid-input', 'grant scope requires at least one action')
  }
  if (actions.some((action) => typeof action !== 'string' || action.trim().length === 0)) {
    throw new GrantError('invalid-input', 'grant actions must be non-empty strings')
  }
  const kind = input.kind ?? 'once'
  if (kind !== 'once' && kind !== 'session' && kind !== 'forever') {
    throw new GrantError('invalid-input', `unknown grant kind: ${String(kind)}`)
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (Number.isNaN(Date.parse(input.expiresAt))) {
      throw new GrantError('invalid-input', `invalid expiresAt: ${input.expiresAt}`)
    }
  }
}

/** `/ws/a` 覆盖 `/ws/a/b`，但不覆盖 `/ws/ab`（路径边界） */
function pathCovers(root: string, target: string): boolean {
  if (root === target) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return target.startsWith(prefix)
}

function coversRequirements(grant: Grant, required: GrantRequirement): boolean {
  const actions = required.actions ?? []
  for (const action of actions) {
    if (!grant.scope.actions.includes('*') && !grant.scope.actions.includes(action)) return false
  }
  if (required.domain !== undefined && grant.scope.domains !== undefined) {
    if (!grant.scope.domains.includes(required.domain)) return false
  }
  if (required.path !== undefined && grant.scope.paths !== undefined) {
    if (!grant.scope.paths.some((root) => pathCovers(root, required.path as string))) return false
  }
  return true
}

export function createGrantStore(dbPath: string, options: GrantStoreOptions = {}): GrantStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const now = options.now ?? (() => new Date())

  const insert = db.prepare(`
    INSERT INTO grants
      (id, actor_id, kind, scope_json, source_approval_id, granted_at, expires_at, policy_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const select = db.prepare('SELECT * FROM grants WHERE id = ?')
  const selectBySource = db.prepare('SELECT * FROM grants WHERE source_approval_id = ?')
  const selectLive = db.prepare(`
    SELECT * FROM grants
     WHERE actor_id = ? AND revoked_at IS NULL AND consumed_at IS NULL
     ORDER BY granted_at DESC, rowid DESC
  `)
  // AR37 diagnostics: scan every grant so a revoked/consumed-only actor reports
  // the precise reason instead of a blanket `not-found`.
  const selectByActor = db.prepare(`
    SELECT * FROM grants
     WHERE actor_id = ?
     ORDER BY granted_at DESC, rowid DESC
  `)
  const revokeStmt = db.prepare(
    'UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  )
  const revokeAllStmt = db.prepare(
    'UPDATE grants SET revoked_at = ? WHERE actor_id = ? AND revoked_at IS NULL',
  )
  const revokeEverything = db.prepare(
    'UPDATE grants SET revoked_at = ? WHERE revoked_at IS NULL',
  )
  const consumeStmt = db.prepare(
    'UPDATE grants SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL',
  )

  function checkOne(
    at: Date,
    grant: Grant,
    input: VerifyGrantInput,
  ): GrantCheckResult {
    if (grant.actorId !== input.actorId) {
      return { ok: false, reason: 'actor-mismatch', grantId: grant.id, grant }
    }
    if (grant.revokedAt !== null) {
      return { ok: false, reason: 'revoked', grantId: grant.id, grant }
    }
    if (grant.consumedAt !== null) {
      return { ok: false, reason: 'consumed', grantId: grant.id, grant }
    }
    if (grant.expiresAt !== null && at.toISOString() >= grant.expiresAt) {
      return { ok: false, reason: 'expired', grantId: grant.id, grant }
    }
    if (input.policyVersion !== undefined && input.policyVersion !== null) {
      if (String(grant.policyVersion) !== String(input.policyVersion)) {
        return { ok: false, reason: 'policy-version-mismatch', grantId: grant.id, grant }
      }
    }
    if (!coversRequirements(grant, input.required ?? {})) {
      return { ok: false, reason: 'scope-mismatch', grantId: grant.id, grant }
    }
    return { ok: true, reason: 'ok', grantId: grant.id, grant }
  }

  // When scanning, report the most specific reason rather than a blanket not-found.
  const REASON_PRIORITY: GrantCheckReason[] = [
    'expired',
    'policy-version-mismatch',
    'scope-mismatch',
    'consumed',
    'revoked',
    'actor-mismatch',
    'not-found',
  ]

  const verifyTransaction = db.transaction((input: VerifyGrantInput): GrantCheckResult => {
    const at = input.now ?? now()
    let candidates: Grant[]
    if (input.grantId !== undefined) {
      const row = select.get(input.grantId) as GrantRow | undefined
      if (row === undefined) return { ok: false, reason: 'not-found' }
      candidates = [toGrant(row)]
    } else {
      const rows = selectByActor.all(input.actorId) as GrantRow[]
      candidates = rows.map(toGrant)
      if (candidates.length === 0) return { ok: false, reason: 'not-found' }
    }

    let best: GrantCheckResult | null = null
    for (const grant of candidates) {
      const result = checkOne(at, grant, input)
      if (result.ok) {
        if (input.consume === true && grant.kind === 'once') {
          const changed = consumeStmt.run(at.toISOString(), grant.id)
          if (changed.changes !== 1) {
            return { ok: false, reason: 'consumed', grantId: grant.id, grant }
          }
          const fresh = select.get(grant.id) as GrantRow
          const consumed = toGrant(fresh)
          return { ok: true, reason: 'ok', grantId: consumed.id, grant: consumed }
        }
        return result
      }
      if (
        best === null ||
        REASON_PRIORITY.indexOf(result.reason) < REASON_PRIORITY.indexOf(best.reason)
      ) {
        best = result
      }
    }
    return best ?? { ok: false, reason: 'not-found' }
  })

  return {
    create: (input) => {
      assertCreateInput(input)
      const at = now()
      const id = uuidv7()
      const kind = input.kind ?? 'once'
      const scope: GrantScope = { actions: [...input.scope.actions] }
      if (input.scope.domains !== undefined) scope.domains = [...input.scope.domains]
      if (input.scope.paths !== undefined) scope.paths = [...input.scope.paths]
      if (input.sourceApprovalId !== undefined) {
        const existing = selectBySource.get(input.sourceApprovalId) as GrantRow | undefined
        if (existing !== undefined) {
          throw new GrantError(
            'duplicate-source',
            `approval ${input.sourceApprovalId} already produced grant ${existing.id}`,
          )
        }
      }
      insert.run(
        id,
        input.actorId,
        kind,
        JSON.stringify(scope),
        input.sourceApprovalId ?? null,
        at.toISOString(),
        input.expiresAt ?? null,
        input.policyVersion === undefined || input.policyVersion === null
          ? null
          : String(input.policyVersion),
      )
      const row = select.get(id) as GrantRow
      return toGrant(row)
    },
    get: (grantId) => {
      const row = select.get(grantId) as GrantRow | undefined
      return row === undefined ? null : toGrant(row)
    },
    find: (actorId, findOptions = {}) => {
      const rows = selectLive.all(actorId) as GrantRow[]
      const match = rows
        .map(toGrant)
        .find((grant) => findOptions.kind === undefined || grant.kind === findOptions.kind)
      return match ?? null
    },
    list: (input = {}) => {
      const clauses: string[] = []
      const params: string[] = []
      if (input.actorId !== undefined) {
        clauses.push('actor_id = ?')
        params.push(input.actorId)
      }
      if (input.includeRevoked !== true) clauses.push('revoked_at IS NULL')
      if (input.includeConsumed !== true) clauses.push('consumed_at IS NULL')
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
      const rows = db
        .prepare(`SELECT * FROM grants${where} ORDER BY granted_at DESC, rowid DESC`)
        .all(...params) as GrantRow[]
      return rows.map(toGrant)
    },
    revoke: (grantId) => {
      const row = select.get(grantId) as GrantRow | undefined
      if (row === undefined) return { ok: false, code: 'not-found' }
      revokeStmt.run(now().toISOString(), grantId)
      const fresh = select.get(grantId) as GrantRow
      return { ok: true, code: 'ok', grant: toGrant(fresh) }
    },
    revokeAll: (actorId) => {
      const at = now().toISOString()
      const changed =
        actorId === undefined ? revokeEverything.run(at) : revokeAllStmt.run(at, actorId)
      return { revoked: changed.changes }
    },
    verify: (input) => verifyTransaction(input),
    close: () => db.close(),
  }
}
