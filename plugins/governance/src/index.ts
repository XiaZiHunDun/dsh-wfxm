import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createApprovalStore, type ApprovalStore } from './approval/store.js'
import { createAuditStore, type AuditStore } from './audit/store.js'
import { toAuditFields, type SessionEventLike, type SessionLike } from './audit/events.js'
import { installConcurrency } from './concurrency/guard.js'
import { guardPreimages } from './preimage/hook.js'
import { createEnvTaskContextResolver, setTaskContextResolver } from './preimage/task-context.js'
import { loadPolicy, policyPath } from './policy/config.js'
import { evaluate } from './policy/rules.js'
import { createDecisionStore } from './policy/store.js'
import { createGrantStore } from './grants/store.js'
import {
  createBearerAuthorizer,
  createGrantsAdminRoutes,
  GRANTS_ADMIN_PATH,
  type AdminRoute,
} from './web/grants-admin.js'
import { createAuditAdminRoutes, AUDIT_ADMIN_PATH } from './web/audit-admin.js'
import { createSnapshotStore } from '@dsh-wfxm/snapshot'

export const name = 'dsh-wfxm-governance'

/**
 * ③ 审批正本（切片 G）：`approvals` 表 + `setExternalMsgId` 卡口。
 * 卡片只是视图（AR10）；决策与 nonce 一次性消费都在这里。
 */
export { createApprovalStore } from './approval/store.js'
export { loadPolicy, policyPath } from './policy/config.js'
export type { Policy, ProjectToolPolicy } from './policy/config.js'
export { evaluate } from './policy/rules.js'
export type { PolicyVerdict } from './policy/rules.js'
export type {
  AnswerApprovalInput,
  AnswerCode,
  AnswerResult,
  ApprovalDecision,
  ApprovalLevel,
  ApprovalRecord,
  ApprovalStatus,
  ApprovalStore,
  ApprovalStoreOptions,
  ApprovalTicket,
  CreateApprovalInput,
  ExpiredApproval,
} from './approval/store.js'

/** ③ 审批与授权：`grants` 正本与 AR20 / AR37 复验（模块 API，非工具） */
export { createGrantStore, GrantError } from './grants/store.js'
export type {
  CreateGrantInput,
  Grant,
  GrantCheckReason,
  GrantCheckResult,
  GrantErrorCode,
  GrantKind,
  GrantRequirement,
  GrantScope,
  GrantStore,
  GrantStoreOptions,
  ListGrantsInput,
  RevokeResult,
  VerifyGrantInput,
} from './grants/store.js'

/** Host wiring point: feed ⑤'s ambient task id into the pre-image rows. */
export type { TaskContextResolver } from './preimage/task-context.js'
export { createEnvTaskContextResolver, setTaskContextResolver } from './preimage/task-context.js'

/** ③ 管理面（Web 渠道，AR26）：授予/撤销路由，不注册模型工具 */
export {
  ADMIN_HEADER,
  GRANTS_ADMIN_PATH,
  createBearerAuthorizer,
  createGrantsAdminRoutes,
  renderGrantsAdminPage,
} from './web/grants-admin.js'
export type {
  AdminAuthResult,
  AdminAuthorizer,
  AdminRoute,
  AuditSink,
  GrantsAdminDeps,
} from './web/grants-admin.js'
export { AUDIT_ADMIN_PATH, createAuditAdminRoutes } from './web/audit-admin.js'
export type { AuditAdminDeps } from './web/audit-admin.js'

interface Logger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

interface WebServerLike {
  register(route: AdminRoute): () => void
}

/** The child context cordis hands to `ctx.inject(['webServer'], …)`. */
interface InjectedWebContext extends ContextLike {
  webServer: WebServerLike
  /** Fiber-bound disposer registration (`vendor/cordis/src/fiber.ts#effect`). */
  effect(run: () => () => void): unknown
}

interface ContextLike {
  on(event: string, listener: (...args: any[]) => void, options?: { global?: boolean }): () => void
  inject?(deps: string[], callback: (ctx: InjectedWebContext) => void): void
  /** Fiber-bound disposer registration (cordis `vendor/cordis/src/fiber.ts#effect`). */
  effect?(run: () => () => void): unknown
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
  // 切片 B attribution bridge: when this mount lives inside a worker-spawned
  // child (e.g. `dsh headless`), ALS cannot reach it, so pre-images take their
  // task/checkpoint ids from DSH_WFXM_* env. Without the env the resolver is
  // "no task" — same as before. An in-process host that mounts both ④ and ⑤
  // still wins by calling `setTaskContextResolver(currentTaskContext)` later.
  setTaskContextResolver(createEnvTaskContextResolver())
  const store: AuditStore = createAuditStore(dbPath)
  const approvals: ApprovalStore = createApprovalStore(dbPath)
  const grants = createGrantStore(dbPath)
  ctx.logger?.info?.(`[governance] audit sink ready at ${dbPath}`)
  ctx.logger?.info?.('[governance] approval store ready')

  // AR37: load before the admin routes so a grant minted without an explicit
  // version stamps the policy version currently in force.
  const policy = loadPolicy()

  // 任务级审批下沉到工具级闸门（2026-11-11）：
  // ⑤ 只在 claim 到 R2/R3 任务（即 ③ 已批准的）时给子进程注入
  // DSH_WFXM_APPROVED_LEVEL。子进程里的 `svc_*` 写操作可以对这次审批
  // 直接返回 allowed-once；其余工具仍 fail-closed（delegate 到 unavailable）。
  const approvedLevel = process.env.DSH_WFXM_APPROVED_LEVEL
  if (process.env.DSH_WFXM_TASK_ID !== undefined && (approvedLevel === 'R2' || approvedLevel === 'R3')) {
    // 已批准任务下沉到工具级闸门：服务写操作、邮件写入与日程写入都只放行这一次。
    const approvedWriteTools = new Set([
      'mail_archive',
      'mail_draft',
      'mail_send',
      'calendar_create',
      'calendar_update',
    ])
    ctx.on(
      'approval/request',
      (request: { toolName?: unknown }, next: () => Promise<unknown>) => {
        const toolName = typeof request?.toolName === 'string' ? request.toolName : ''
        if (!toolName.startsWith('svc_') && !approvedWriteTools.has(toolName)) return next()
        ctx.logger?.info?.(`[governance] tool approval granted by approved ${approvedLevel} task: ${toolName}`)
        return 'allowed-once'
      },
      { global: true },
    )
    ctx.logger?.info?.(`[governance] approved ${approvedLevel} task answers svc_*/mail_*/calendar_* tool gates`)
  }

  // ③ 管理面（AR26）：只在 Web 渠道挂路由；模型工具面拿不到授予/撤销。
  const authorize = createBearerAuthorizer({
    token: process.env.DSH_WFXM_ADMIN_TOKEN ?? null,
  })
  const adminRoutes = createGrantsAdminRoutes({
    grants,
    audit: store,
    policyVersion: () => policy?.version ?? null,
    authorize,
  })
  // H3: read-only audit query over the same admin identity (no model tools).
  const auditRoutes = createAuditAdminRoutes({ audit: store, authorize })
  const routes = [...adminRoutes, ...auditRoutes]
  if (typeof ctx.inject !== 'function') {
    ctx.logger?.warn?.('[governance] no ctx.inject; Grant/audit admin UI not mounted')
  } else {
    ctx.inject(['webServer'], (webCtx) => {
      // `effect` is cordis' fiber-bound disposal: routes unregister with the
      // injected child fiber instead of a `dispose` event (cordis has none).
      webCtx.effect(() => {
        const disposers = routes.map((route) => webCtx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      })
      ctx.logger?.info?.(`[governance] Grant admin UI at ${GRANTS_ADMIN_PATH}; audit query at ${AUDIT_ADMIN_PATH}`)
    })
  }

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

  // cordis has no `dispose` event; fiber-bound effects run on plugin unload.
  ctx.effect?.(() => () => store.close())
  ctx.effect?.(() => () => approvals.close())
  ctx.effect?.(() => () => grants.close())

  if (policy === null) {
    ctx.logger?.warn?.(`[governance] no policy at ${policyPath()}; tool gating disabled`)
    return
  }

  const decisions = createDecisionStore(dbPath)
  ctx.logger?.info?.(`[governance] policy v${policy.version} active (kill switch: ${policy.killSwitchPath})`)

  const snapshots = policy.preimages.enabled ? createSnapshotStore(dbPath) : null
  if (snapshots === null) {
    ctx.logger?.warn?.('[governance] pre-images disabled by policy')
  } else {
    ctx.logger?.info?.(
      `[governance] pre-images on for ${policy.preimages.roots.join(', ')}`,
    )
    ctx.effect?.(() => () => snapshots.close())
  }

  ctx.on('tools/pre-execute', async (exec: ToolCallLike, next: () => Promise<unknown>) => {
    // E3: the executor stamps the task's project; sessions without one are
    // unaffected (chat / web keep the pre-E3 behaviour).
    const projectId = process.env.DSH_WFXM_PROJECT_ID?.trim() || undefined
    const result = evaluate(policy, exec.name, exec.arguments, projectId)
    decisions.record({
      correlationId: exec.callId,
      ruleId: result.rule,
      rulesetVersion: String(policy.version),
      inputDigest: createHash('sha256').update(JSON.stringify(exec.arguments ?? null)).digest('hex'),
      verdict: result.verdict,
      reason: result.reason,
    })
    if (result.verdict !== 'allow') {
      return { kind: 'deny', reason: result.reason ?? result.rule }
    }
    if (snapshots !== null) {
      // 13 §3.4 粒度一: previous bytes before the write; failure denies the call.
      const guard = guardPreimages({
        policy,
        store: snapshots,
        toolCallId: exec.callId,
        toolName: exec.name,
        args: exec.arguments,
      })
      if (!guard.ok) {
        ctx.logger?.error?.(`[governance] ${guard.reason}`)
        return { kind: 'deny', reason: guard.reason ?? 'preimage-failed' }
      }
      if (guard.captured.length > 0) {
        ctx.logger?.info?.(`[governance] pre-image ${guard.captured.join(', ')}`)
      }
    }
    return next()
  })

  ctx.effect?.(() => () => decisions.close())

  installConcurrency(
    ctx,
    {
      enabled: policy.concurrency.writeSerialization,
      conflictLimit: policy.concurrency.conflictLimit,
    },
    decisions,
  )
}
