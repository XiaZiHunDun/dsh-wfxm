/**
 * ③ Grant 管理面验收：真实 HTTP 服务 + 真实 grants / audit 存储。
 *
 * 覆盖：无令牌拒绝、CSRF 头、授予/撤销/批量撤销、审计落行、HTML 外壳不含数据、
 * 审计失败大声失败。运行：node scripts/verify-grants-admin.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseConstructor from 'better-sqlite3'
import {
  ADMIN_HEADER,
  GRANTS_ADMIN_PATH,
  apply,
  createBearerAuthorizer,
  createGrantStore,
  createGrantsAdminRoutes,
} from '../lib/index.js'
import { createAuditStore } from '../lib/audit/store.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-wfxm-grants-admin-'))
const dbPath = join(dir, 'ops.sqlite')
const grants = createGrantStore(dbPath)
const audit = createAuditStore(dbPath)
const token = 'test-admin-token'

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    const result = await fn()
    if (result === false) throw new Error('assertion returned false')
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

/** dsh WebServer match order: exact, then longest prefix. */
function dispatch(routes, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const exact = routes.find((route) => route.kind === 'exact' && route.path === url.pathname)
  const prefix = exact ?? routes
    .filter((route) => route.kind === 'prefix'
      && (url.pathname === route.path || url.pathname.startsWith(`${route.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (prefix === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not-found' }))
    return
  }
  Promise.resolve(prefix.handler(req, res)).catch((error) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'handler-crash', message: String(error) }))
    } else {
      res.end()
    }
  })
}

async function startServer(routes) {
  const server = createServer((req, res) => dispatch(routes, req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const primary = await startServer(createGrantsAdminRoutes({
  grants,
  audit,
  policyVersion: () => 'policy-9',
  authorize: createBearerAuthorizer({ token }),
}))
const base = primary.base
const auth = { authorization: `Bearer ${token}` }

async function getJson(path, headers = {}) {
  const response = await fetch(base + path, { headers: { accept: 'application/json', ...headers } })
  const body = await response.json().catch(() => ({}))
  return { response, body }
}

async function postJson(path, payload, headers = {}) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...auth, ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  return { response, body }
}

await check('the HTML shell opens without a token and carries no grant data', async () => {
  const response = await fetch(base + GRANTS_ADMIN_PATH, { headers: { accept: 'text/html' } })
  const html = await response.text()
  return response.status === 200
    && (response.headers.get('content-type') ?? '').includes('text/html')
    && (response.headers.get('content-security-policy') ?? '').includes("default-src 'none'")
    && html.includes('Grant 管理')
    && html.includes('管理令牌')
    && html.includes('revoke-all')
})

await check('listing without a token is rejected', async () => {
  const { response, body } = await getJson(GRANTS_ADMIN_PATH)
  return response.status === 401 && body.error === 'unauthenticated'
})

await check('a wrong token is rejected', async () => {
  const { response, body } = await getJson(GRANTS_ADMIN_PATH, { authorization: 'Bearer nope' })
  return response.status === 401 && body.error === 'unauthenticated'
})

await check('a list read with the token starts empty', async () => {
  const { response, body } = await getJson(GRANTS_ADMIN_PATH, auth)
  return response.status === 200 && Array.isArray(body.grants) && body.grants.length === 0
})

const grantPayload = {
  actorId: 'actor-1',
  kind: 'session',
  scope: { actions: ['task.wake'], domains: ['A'], paths: ['/tmp'] },
  sourceApprovalId: 'appr-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  policyVersion: 'v1',
}

await check('a mutation without the CSRF header is refused and creates nothing', async () => {
  const { response, body } = await postJson(GRANTS_ADMIN_PATH, grantPayload, {
    [ADMIN_HEADER]: undefined,
  })
  // fetch drops undefined headers, so this is exactly "no CSRF header".
  return response.status === 403 && body.error === 'csrf' && grants.list({ includeRevoked: true }).length === 0
})

await check('a non-JSON content type is refused', async () => {
  const response = await fetch(base + GRANTS_ADMIN_PATH, {
    method: 'POST',
    headers: { accept: 'application/json', ...auth, [ADMIN_HEADER]: '1', 'content-type': 'text/plain' },
    body: 'actorId=1',
  })
  return response.status === 415
})

await check('granting returns 201, persists every field and writes an audit row', async () => {
  const { response, body } = await postJson(GRANTS_ADMIN_PATH, grantPayload, { [ADMIN_HEADER]: '1' })
  const rows = grants.list({ includeRevoked: true })
  const grant = rows[0]
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const logged = db
    .prepare('SELECT actor_id, action, target, payload_digest FROM audit_log ORDER BY seq DESC LIMIT 1')
    .get()
  db.close()
  return response.status === 201
    && body.grant.actorId === 'actor-1'
    && body.grant.kind === 'session'
    && body.grant.scope.actions.join() === 'task.wake'
    && body.grant.scope.domains.join() === 'A'
    && body.grant.scope.paths.join() === '/tmp'
    && body.grant.sourceApprovalId === 'appr-1'
    && body.grant.policyVersion === 'v1'
    && body.grant.expiresAt === '2030-01-01T00:00:00.000Z'
    && rows.length === 1
    && grant.id === body.grant.id
    && logged.actor_id === 'web-admin'
    && logged.action === 'grant.create'
    && logged.target === grant.id
    && typeof logged.payload_digest === 'string'
    && logged.payload_digest.length === 64
})

await check('the same source approval cannot mint a second grant', async () => {
  const { response, body } = await postJson(GRANTS_ADMIN_PATH, grantPayload, { [ADMIN_HEADER]: '1' })
  return response.status === 409 && body.error === 'duplicate-source'
})

await check('an empty action list is invalid input', async () => {
  const { response, body } = await postJson(GRANTS_ADMIN_PATH, {
    actorId: 'actor-1',
    scope: { actions: [] },
  }, { [ADMIN_HEADER]: '1' })
  return response.status === 400 && body.error === 'invalid-input'
})

await check('an unknown kind is invalid input', async () => {
  const { response, body } = await postJson(GRANTS_ADMIN_PATH, {
    actorId: 'actor-1',
    kind: 'forever-and-ever',
    scope: { actions: ['task.wake'] },
  }, { [ADMIN_HEADER]: '1' })
  return response.status === 400 && body.error === 'invalid-input'
})

await check('an oversized body is refused with 413', async () => {
  const padding = 'x'.repeat(70 * 1024)
  const { response, body } = await postJson(GRANTS_ADMIN_PATH, { actorId: 'actor-1', scope: { actions: ['a'] }, padding }, {
    [ADMIN_HEADER]: '1',
  })
  return response.status === 413 && body.error === 'payload-too-large'
})

await check('the HTML shell still does not echo the stored grant id', async () => {
  const response = await fetch(base + GRANTS_ADMIN_PATH, { headers: { accept: 'text/html' } })
  const html = await response.text()
  return response.status === 200 && !html.includes(grants.list({ includeRevoked: true })[0].id)
})

await check('the list filters by actor and can include revoked rows', async () => {
  const other = await postJson(GRANTS_ADMIN_PATH, {
    actorId: 'actor-2',
    scope: { actions: ['ssh.exec'] },
  }, { [ADMIN_HEADER]: '1' })
  const scoped = await getJson(`${GRANTS_ADMIN_PATH}?actorId=actor-2`, auth)
  const all = await getJson(GRANTS_ADMIN_PATH, auth)
  return other.response.status === 201
    && scoped.response.status === 200
    && scoped.body.grants.length === 1
    && scoped.body.grants[0].actorId === 'actor-2'
    && all.body.grants.length === 2
})

await check('a grant without an explicit policy version stamps the current one (AR37)', async () => {
  const { response, body } = await postJson(GRANTS_ADMIN_PATH, {
    actorId: 'actor-stamp',
    kind: 'session',
    scope: { actions: ['task.wake'] },
  }, { [ADMIN_HEADER]: '1' })
  return response.status === 201 && body.grant.policyVersion === 'policy-9'
})

await check('revoking one grant stamps revokedAt and audits it', async () => {
  const target = grants.list({ includeRevoked: true }).find((grant) => grant.actorId === 'actor-1')
  const { response, body } = await postJson(
    `${GRANTS_ADMIN_PATH}/${encodeURIComponent(target.id)}/revoke`,
    {},
    { [ADMIN_HEADER]: '1' },
  )
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const logged = db
    .prepare('SELECT action, target FROM audit_log ORDER BY seq DESC LIMIT 1')
    .get()
  db.close()
  return response.status === 200
    && typeof body.grant.revokedAt === 'string'
    && logged.action === 'grant.revoke'
    && logged.target === target.id
})

await check('revoking an unknown grant returns 404', async () => {
  const { response, body } = await postJson(`${GRANTS_ADMIN_PATH}/missing/revoke`, {}, {
    [ADMIN_HEADER]: '1',
  })
  return response.status === 404 && body.error === 'not-found'
})

await check('revoke-all for one actor leaves other actors alone', async () => {
  const { response, body } = await postJson(`${GRANTS_ADMIN_PATH}/revoke-all`, { actorId: 'actor-2' }, {
    [ADMIN_HEADER]: '1',
  })
  const actor2 = grants.list({ includeRevoked: true }).filter((grant) => grant.actorId === 'actor-2')
  const actor1 = grants.list({ includeRevoked: true }).filter((grant) => grant.actorId === 'actor-1')
  return response.status === 200
    && body.revoked === 1
    && actor2.every((grant) => grant.revokedAt !== null)
    && actor1.every((grant) => grant.revokedAt !== null)
})

await check('an unsupported method is 405 with an Allow header', async () => {
  const response = await fetch(base + GRANTS_ADMIN_PATH, { method: 'DELETE', headers: auth })
  return response.status === 405 && (response.headers.get('allow') ?? '').includes('POST')
})

await check('an unknown admin sub-path is 404', async () => {
  const { response, body } = await postJson(`${GRANTS_ADMIN_PATH}/nope`, {}, { [ADMIN_HEADER]: '1' })
  return response.status === 404 && body.error === 'not-found'
})

// ---- plugin mounting through ctx.inject + effect ---------------------------

await check('apply() mounts both admin routes through ctx.inject and disposes them with effect', async () => {
  const mountDir = mkdtempSync(join(tmpdir(), 'dsh-wfxm-governance-mount-'))
  const saved = {
    db: process.env.DSH_WFXM_AUDIT_DB,
    token: process.env.DSH_WFXM_ADMIN_TOKEN,
    policy: process.env.DSH_WFXM_POLICY,
  }
  process.env.DSH_WFXM_AUDIT_DB = join(mountDir, 'ops.sqlite')
  process.env.DSH_WFXM_ADMIN_TOKEN = 'mount-token'
  process.env.DSH_WFXM_POLICY = join(mountDir, 'no-policy.yaml') // keep the check on the admin mount

  const registered = []
  const effects = []
  const ctx = {
    on() { return () => {} },
    logger: { info() {}, warn() {}, error() {} },
    inject(deps, callback) {
      if (deps.length !== 1 || deps[0] !== 'webServer') throw new Error(`unexpected inject: ${deps}`)
      callback({
        webServer: {
          register(route) {
            registered.push(route)
            return () => {}
          },
        },
        effect(run) { effects.push(run) },
      })
    },
  }

  let mounted
  try {
    apply(ctx)
    mounted = await startServer(registered)
    // The disposer only runs once cordis loads the child fiber; mimic that.
    for (const run of effects) run()
    const { response, body } = await fetch(mounted.base + GRANTS_ADMIN_PATH, {
      headers: { accept: 'application/json', authorization: 'Bearer mount-token' },
    }).then(async (res) => ({ response: res, body: await res.json().catch(() => ({})) }))
    return registered.length === 2
      && registered.some((route) => route.kind === 'exact' && route.path === GRANTS_ADMIN_PATH)
      && registered.some((route) => route.kind === 'prefix' && route.path === GRANTS_ADMIN_PATH)
      && response.status === 200
      && Array.isArray(body.grants)
  } finally {
    await mounted?.close()
    for (const [key, value] of Object.entries({
      DSH_WFXM_AUDIT_DB: saved.db,
      DSH_WFXM_ADMIN_TOKEN: saved.token,
      DSH_WFXM_POLICY: saved.policy,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(mountDir, { recursive: true, force: true })
  }
})

// ---- audit failure is loud, not silent -------------------------------------

const broken = await startServer(createGrantsAdminRoutes({
  grants,
  audit: { append() { throw new Error('audit chain down') } },
  authorize: createBearerAuthorizer({ token }),
}))

await check('an audit failure answers 500 audit-unavailable instead of pretending success', async () => {
  const response = await fetch(broken.base + GRANTS_ADMIN_PATH, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...auth,
      [ADMIN_HEADER]: '1',
    },
    body: JSON.stringify({ actorId: 'actor-3', scope: { actions: ['fs.write'] } }),
  })
  const body = await response.json()
  return response.status === 500 && body.error === 'audit-unavailable'
})

await broken.close()
await primary.close()
grants.close()
audit.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
