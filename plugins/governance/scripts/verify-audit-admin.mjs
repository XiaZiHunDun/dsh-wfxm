/**
 * H3 审计查询面验收：真实 HTTP + 真实 audit 存储（哈希链）。
 *
 * 覆盖：HTML 外壳不含数据、无令牌 401、默认分页、actor/action/target 过滤、
 * 时间窗、游标翻页、哈希链校验、非法参数 400、只读（POST 405）。
 * 运行：node plugins/governance/scripts/verify-audit-admin.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditStore } from '../lib/audit/store.js'
import { AUDIT_ADMIN_PATH, createAuditAdminRoutes } from '../lib/web/audit-admin.js'
import { createBearerAuthorizer } from '../lib/web/grants-admin.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-wfxm-audit-admin-'))
const audit = createAuditStore(join(dir, 'ops.sqlite'))
const token = 'test-audit-token'
const baseTime = Date.parse('2026-11-19T00:00:00.000Z')

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

function dispatch(routes, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = routes.find((item) => item.kind === 'exact' && item.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not-found' }))
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'handler-crash', message: String(error) }))
    } else {
      res.end()
    }
  })
}

const server = createServer((req, res) =>
  dispatch(createAuditAdminRoutes({ audit, authorize: createBearerAuthorizer({ token }) }), req, res),
)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}`
const auth = { authorization: `Bearer ${token}` }

async function get(path, headers = {}) {
  const response = await fetch(base + path, { headers: { accept: 'application/json', ...headers } })
  const body = await response.json().catch(() => ({}))
  return { response, body }
}

const seeded = [
  { actorId: 'alice', action: 'tool.call', target: 'fs.read', correlationId: 'c1' },
  { actorId: 'bob', action: 'tool.call', target: 'fs.write', correlationId: 'c2' },
  { actorId: 'alice', action: 'approval.asked', target: 'shell.run', correlationId: 'c3' },
  { actorId: 'carol', action: 'approval.granted', target: 'shell.run', correlationId: 'c4' },
  { actorId: 'alice', action: 'tool.call', target: 'fs.read', correlationId: 'c5' },
]
for (let index = 0; index < seeded.length; index += 1) {
  const row = seeded[index]
  audit.append({
    sessionId: 'session-a',
    sessionSeq: index + 1,
    time: baseTime + index * 60_000,
    actorId: row.actorId,
    action: row.action,
    target: row.target,
    correlationId: row.correlationId,
    payloadDigest: `digest-${index + 1}`,
  })
}

await check('the HTML shell opens without a token and carries no audit rows', async () => {
  const response = await fetch(base + AUDIT_ADMIN_PATH, { headers: { accept: 'text/html' } })
  const html = await response.text()
  return response.status === 200
    && html.includes('审计查询')
    && html.includes('校验哈希链')
    && !html.includes('alice')
    && !html.includes('digest-1')
})

await check('JSON without a token is rejected', async () => {
  const { response, body } = await get(AUDIT_ADMIN_PATH)
  return response.status === 401 && body.error === 'unauthenticated'
})

await check('the default page is newest-first and reports the total', async () => {
  const { response, body } = await get(AUDIT_ADMIN_PATH, auth)
  return response.status === 200
    && body.count === 5
    && body.rows.length === 5
    && body.rows[0].seq === 5
    && body.rows[4].seq === 1
    && body.nextBeforeSeq === null
})

await check('actorId narrows the page', async () => {
  const { body } = await get(`${AUDIT_ADMIN_PATH}?actorId=alice`, auth)
  return body.count === 3 && body.rows.every((row) => row.actorId === 'alice')
})

await check('action + target combine', async () => {
  const { body } = await get(`${AUDIT_ADMIN_PATH}?action=tool.call&target=fs.read`, auth)
  return body.count === 2 && body.rows.every((row) => row.action === 'tool.call' && row.target === 'fs.read')
})

await check('the time window is inclusive-from, exclusive-to', async () => {
  const from = new Date(baseTime + 2 * 60_000).toISOString()
  const to = new Date(baseTime + 4 * 60_000).toISOString()
  const { body } = await get(`${AUDIT_ADMIN_PATH}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, auth)
  return body.count === 2
    && body.rows.length === 2
    && body.rows[0].seq === 4
    && body.rows[1].seq === 3
})

await check('limit + beforeSeq walks older pages without overlaps', async () => {
  const first = await get(`${AUDIT_ADMIN_PATH}?limit=2`, auth)
  const second = await get(`${AUDIT_ADMIN_PATH}?limit=2&beforeSeq=${first.body.nextBeforeSeq}`, auth)
  const third = await get(`${AUDIT_ADMIN_PATH}?limit=2&beforeSeq=${second.body.nextBeforeSeq}`, auth)
  return first.body.rows.map((row) => row.seq).join() === '5,4'
    && first.body.nextBeforeSeq === 4
    && second.body.rows.map((row) => row.seq).join() === '3,2'
    && second.body.nextBeforeSeq === 2
    && third.body.rows.map((row) => row.seq).join() === '1'
    && third.body.nextBeforeSeq === null
})

await check('verify=1 recomputes the hash chain', async () => {
  const { response, body } = await get(`${AUDIT_ADMIN_PATH}?verify=1`, auth)
  return response.status === 200 && body.chain.ok === true && body.chain.checked === 5
})

await check('invalid limit / timestamps are rejected', async () => {
  const badLimit = await get(`${AUDIT_ADMIN_PATH}?limit=0`, auth)
  const badFrom = await get(`${AUDIT_ADMIN_PATH}?from=not-a-date`, auth)
  return badLimit.response.status === 400
    && badLimit.body.error === 'invalid-input'
    && badFrom.response.status === 400
    && badFrom.body.error === 'invalid-input'
})

await check('the query surface is read-only', async () => {
  const response = await fetch(base + AUDIT_ADMIN_PATH, { method: 'POST', headers: { ...auth, accept: 'application/json' } })
  return response.status === 405
})

await new Promise((resolve) => server.close(resolve))
audit.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
