import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseConstructor from 'better-sqlite3'
import { GrantError, createGrantStore } from '../lib/index.js'
import { createTaskStore } from '@dsh-wfxm/tasks'
import { createGatewayStore, ingestInbound, WAKE_ACTION } from '@dsh-wfxm/gateway'

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    const ok = await fn()
    if (ok) {
      pass++
      console.log(`PASS  ${name}`)
    } else {
      fail++
      console.log(`FAIL  ${name}`)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'grants-'))
const dbPath = join(dir, 'ops.sqlite')

let clock = new Date('2026-11-10T00:00:00.000Z')
const now = () => new Date(clock)
const advance = (ms) => {
  clock = new Date(clock.getTime() + ms)
}

const store = createGrantStore(dbPath, { now })
const at = (ms) => new Date(clock.getTime() + ms).toISOString()

// ---- schema -----------------------------------------------------------------

await check('migration creates grants at v1 with the AR20 indexes', () => {
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'grants'")
    .get()
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name)
  const version = db
    .prepare('SELECT version FROM schema_migrations WHERE module = ?')
    .get('grant')
  const columns = db
    .prepare('PRAGMA table_info(grants)')
    .all()
    .map((row) => row.name)
  db.close()
  return table !== undefined
    && version.version === 1
    && indexes.includes('ix_grants_actor')
    && indexes.includes('ux_grants_source')
    && ['id', 'actor_id', 'kind', 'scope_json', 'source_approval_id', 'granted_at', 'expires_at',
      'revoked_at', 'consumed_at', 'policy_version'].every((column) => columns.includes(column))
})

await check('migration is idempotent on reopen', () => {
  const second = createGrantStore(dbPath)
  const ok = second.list({ includeRevoked: true }).length === store.list({ includeRevoked: true }).length
  second.close()
  return ok
})

// ---- create / read ----------------------------------------------------------

const session = store.create({
  actorId: 'owner',
  kind: 'session',
  scope: { actions: ['task.submit', 'tool.write'], domains: ['A'], paths: ['/ws/a'] },
  policyVersion: 3,
})

await check('create defaults nothing away: uuid v7, grantedAt from the clock, scope roundtrip', () => {
  const once = store.create({
    actorId: 'owner',
    scope: { actions: ['tool.write'] },
  })
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(once.id)
    && once.kind === 'once'
    && once.grantedAt === now().toISOString()
    && once.expiresAt === null
    && once.policyVersion === null
    && stored(once.id).scope.actions.join() === 'tool.write'
})

function stored(grantId) {
  return store.get(grantId)
}

await check('scope, domains and paths survive the JSON roundtrip', () => {
  const value = store.get(session.id)
  return value !== null
    && value.kind === 'session'
    && value.scope.actions.length === 2
    && value.scope.domains.join() === 'A'
    && value.scope.paths.join() === '/ws/a'
    && value.policyVersion === '3'
})

await check('get returns null for an unknown id', () => store.get('nope') === null)

await check('an empty action list is rejected', () => {
  assert.throws(
    () => store.create({ actorId: 'owner', scope: { actions: [] } }),
    (error) => error instanceof GrantError && error.code === 'invalid-input',
  )
  return true
})

await check('an empty actor is rejected', () => {
  assert.throws(
    () => store.create({ actorId: '  ', scope: { actions: ['tool.read'] } }),
    (error) => error instanceof GrantError && error.code === 'invalid-input',
  )
  return true
})

await check('an unparsable expiry is rejected', () => {
  assert.throws(
    () => store.create({ actorId: 'owner', scope: { actions: ['tool.read'] }, expiresAt: 'soon' }),
    (error) => error instanceof GrantError && error.code === 'invalid-input',
  )
  return true
})

// ---- verify (AR37 复验五项 + 范围) ------------------------------------------

await check('a granted action verifies ok', () => {
  const result = store.verify({ actorId: 'owner', required: { actions: ['task.submit'] } })
  return result.ok === true && result.reason === 'ok' && result.grantId === session.id
})

await check('an action outside the scope is a scope-mismatch', () => {
  const result = store.verify({ actorId: 'owner', required: { actions: ['tool.delete'] } })
  return result.ok === false && result.reason === 'scope-mismatch'
})

await check('a wildcard action covers anything', () => {
  const wildcard = store.create({
    actorId: 'owner',
    kind: 'forever',
    scope: { actions: ['*'] },
  })
  const result = store.verify({ actorId: 'owner', grantId: wildcard.id, required: { actions: ['deploy.prod'] } })
  return result.ok === true && result.grantId === wildcard.id
})

await check('a domain outside the grant is a scope-mismatch', () => {
  const result = store.verify({ actorId: 'owner', grantId: session.id, required: { domain: 'B' } })
  return result.ok === false && result.reason === 'scope-mismatch'
})

await check('a path prefix covers children but not siblings', () => {
  const inside = store.verify({ actorId: 'owner', grantId: session.id, required: { path: '/ws/a/b.conf' } })
  const sibling = store.verify({ actorId: 'owner', grantId: session.id, required: { path: '/ws/ab/c.conf' } })
  return inside.ok === true && sibling.ok === false && sibling.reason === 'scope-mismatch'
})

await check('a project domain is part of the grant scope (AR37)', () => {
  const scoped = store.create({
    actorId: 'owner',
    kind: 'forever',
    scope: { actions: ['task.wake'], domains: ['proj_a'] },
  })
  const hit = store.verify({
    actorId: 'owner',
    grantId: scoped.id,
    required: { actions: ['task.wake'], domain: 'proj_a' },
  })
  const miss = store.verify({
    actorId: 'owner',
    grantId: scoped.id,
    required: { actions: ['task.wake'], domain: 'proj_b' },
  })
  return hit.ok === true && miss.ok === false && miss.reason === 'scope-mismatch'
})

await check('another actor cannot use the grant', () => {
  const result = store.verify({ actorId: 'intruder', grantId: session.id })
  return result.ok === false && result.reason === 'actor-mismatch'
})

await check('an unknown grant id is not-found', () => {
  const result = store.verify({ actorId: 'owner', grantId: 'nope' })
  return result.ok === false && result.reason === 'not-found'
})

await check('policy version drift is rejected (AR37)', () => {
  const drift = store.verify({ actorId: 'owner', grantId: session.id, policyVersion: 4 })
  const same = store.verify({ actorId: 'owner', grantId: session.id, policyVersion: 3 })
  return drift.ok === false
    && drift.reason === 'policy-version-mismatch'
    && same.ok === true
})

await check('a grant without a recorded policy version fails a versioned re-check (AR37)', () => {
  const unversioned = store.create({
    actorId: 'owner',
    kind: 'forever',
    scope: { actions: ['task.wake'] },
  })
  const result = store.verify({ actorId: 'owner', grantId: unversioned.id, policyVersion: 3 })
  return result.ok === false && result.reason === 'policy-version-mismatch'
})

await check('an expired grant is rejected, expiry is authoritative', () => {
  const expiring = store.create({
    actorId: 'owner',
    kind: 'session',
    scope: { actions: ['tool.read'] },
    expiresAt: at(60_000),
  })
  const before = store.verify({ actorId: 'owner', grantId: expiring.id })
  advance(60_000)
  const after = store.verify({ actorId: 'owner', grantId: expiring.id })
  advance(-60_000)
  return before.ok === true && after.ok === false && after.reason === 'expired'
})

// ---- revoke (AR20) ----------------------------------------------------------

await check('revoke is idempotent and blocks verification', () => {
  const target = store.create({ actorId: 'owner', kind: 'forever', scope: { actions: ['tool.read'] } })
  const first = store.revoke(target.id)
  const second = store.revoke(target.id)
  const result = store.verify({ actorId: 'owner', grantId: target.id })
  return first.ok === true
    && first.grant.revokedAt !== null
    && second.ok === true
    && second.grant.revokedAt === first.grant.revokedAt
    && result.ok === false
    && result.reason === 'revoked'
})

await check('revoking an unknown grant is not-found', () => {
  const result = store.revoke('nope')
  return result.ok === false && result.code === 'not-found'
})

await check('revokeAll only touches the named actor', () => {
  const alice = store.create({ actorId: 'alice', kind: 'forever', scope: { actions: ['tool.read'] } })
  const bob = store.create({ actorId: 'bob', kind: 'forever', scope: { actions: ['tool.read'] } })
  const revoked = store.revokeAll('alice')
  const aliceResult = store.verify({ actorId: 'alice', grantId: alice.id })
  const bobResult = store.verify({ actorId: 'bob', grantId: bob.id })
  return revoked.revoked === 1 && aliceResult.reason === 'revoked' && bobResult.ok === true
})

// ---- "本次"授权的一次性兑付 -------------------------------------------------

await check('a once grant is consumed by the first successful verification', () => {
  const once = store.create({ actorId: 'carol', scope: { actions: ['tool.write'] } })
  const first = store.verify({ actorId: 'carol', grantId: once.id, consume: true })
  const second = store.verify({ actorId: 'carol', grantId: once.id, consume: true })
  return first.ok === true
    && first.grant.consumedAt !== null
    && second.ok === false
    && second.reason === 'consumed'
})

await check('a session grant is not consumed by consume=true', () => {
  const value = store.create({ actorId: 'dave', kind: 'session', scope: { actions: ['tool.write'] } })
  const first = store.verify({ actorId: 'dave', grantId: value.id, consume: true })
  const second = store.verify({ actorId: 'dave', grantId: value.id, consume: true })
  return first.ok === true && first.grant.consumedAt === null && second.ok === true
})

await check('scan mode skips the revoked grant and finds another that covers the action', () => {
  const dead = store.create({ actorId: 'erin', kind: 'forever', scope: { actions: ['tool.write'] } })
  const live = store.create({ actorId: 'erin', kind: 'forever', scope: { actions: ['tool.write'] } })
  store.revoke(dead.id)
  const result = store.verify({ actorId: 'erin', required: { actions: ['tool.write'] } })
  return result.ok === true && result.grantId === live.id
})

await check('a revoked-only actor reports revoked instead of not-found (AR37)', () => {
  const dead = store.create({ actorId: 'frank', kind: 'forever', scope: { actions: ['tool.write'] } })
  store.revoke(dead.id)
  const result = store.verify({ actorId: 'frank', required: { actions: ['tool.write'] } })
  return result.ok === false && result.reason === 'revoked'
})

// ---- source linkage ---------------------------------------------------------

await check('one approval can only produce one grant', () => {
  const source = store.create({
    actorId: 'owner',
    kind: 'session',
    scope: { actions: ['deploy.prod'] },
    sourceApprovalId: 'appr-1',
  })
  assert.throws(
    () => store.create({
      actorId: 'owner',
      kind: 'session',
      scope: { actions: ['deploy.prod'] },
      sourceApprovalId: 'appr-1',
    }),
    (error) => error instanceof GrantError && error.code === 'duplicate-source',
  )
  return source.sourceApprovalId === 'appr-1'
})

// ---- enumeration ------------------------------------------------------------

await check('list hides revoked and consumed rows unless asked', () => {
  const hidden = store.list({ actorId: 'carol' })
  const withConsumed = store.list({ actorId: 'carol', includeConsumed: true })
  const withRevoked = store.list({ actorId: 'owner', includeRevoked: true })
  return hidden.length === 0
    && withConsumed.length === 1
    && withConsumed[0].consumedAt !== null
    && withRevoked.some((grant) => grant.revokedAt !== null)
})

// ---- AR37 end to end: ① ingest → ③ re-verify → ⑤ wake ------------------------

const e2ePath = join(dir, 'e2e.sqlite')
// Order matters: ⑤ / ① create `schema_migrations` with PK(module); ③ inserts a
// row without upsert, so open the two before it on a shared database.
const e2eTasks = createTaskStore(e2ePath)
const e2eGateway = createGatewayStore(e2ePath)
const e2eGrants = createGrantStore(e2ePath, { now })

const e2eOwner = e2eGateway.createActor({ kind: 'owner' })
e2eGateway.bindChannel({
  actorId: e2eOwner.id,
  channelId: 'feishu',
  externalUserId: 'open_e2e',
})
const e2eThread = e2eGateway.resolveThread({ channelId: 'feishu', chatId: 'chat_e2e' })

const e2eTask = e2eTasks.createTask({
  intent: 'write the report',
  riskLevel: 'R1',
  projectId: 'proj_e2e',
  originMsgId: 'root_e2e',
})
e2eTasks.bindThread({ taskId: e2eTask.id, threadId: e2eThread.id, relation: 'default_owner' })
e2eTasks.transition(e2eTask.id, { to: 'running' })
e2eTasks.transition(e2eTask.id, { to: 'succeeded', summary: 'v1 delivered' })

const e2eGrant = e2eGrants.create({
  actorId: e2eOwner.id,
  kind: 'session',
  scope: { actions: [WAKE_ACTION] },
})

const relayCalls = []
const e2ePorts = {
  store: e2eGateway,
  // AR37 replays the same reply text on purpose; dedupe is covered by
  // verify-gateway, so keep this scenario independent of the window.
  duplicateWindowMs: 0,
  relay: {
    attach(input) {
      relayCalls.push({ op: 'attach', ...input })
      const subscription = e2eTasks.bindThread({
        taskId: input.taskId,
        threadId: input.threadId,
        relation: 'anchor',
        anchorMsgId: input.anchorMsgId ?? null,
      })
      return { id: subscription.id }
    },
    enqueue(input) {
      relayCalls.push({ op: 'enqueue', ...input })
      const queued = e2eTasks.enqueueInput({ taskId: input.taskId, inboxId: input.inboxId })
      return { id: queued.id }
    },
  },
  grantCheck: {
    verify(input) {
      return e2eGrants.verify({ actorId: input.actorId, required: input.required })
    },
  },
  wake: {
    wake(input) {
      const task = e2eTasks.wakeTask({ taskId: input.taskId, reason: input.reason })
      return { status: task.status, round: task.round }
    },
  },
}

let e2eMsg = 0
async function replyAgain() {
  e2eMsg += 1
  return ingestInbound(e2ePorts, {
    channelId: 'feishu',
    msgId: `e2e_msg_${e2eMsg}`,
    externalUserId: 'open_e2e',
    content: { text: '接着上一轮的成果继续' },
    chatId: 'chat_e2e',
    replyToMsgId: 'root_e2e',
  })
}

await check('AR37 E2E: a re-verified reply wakes the task, bumps the round and queues the input', async () => {
  const result = await replyAgain()
  const task = e2eTasks.getTask(e2eTask.id)
  const events = e2eTasks.listEvents(e2eTask.id)
  const pending = e2eTasks.pendingInputs(e2eTask.id)
  return result.wake.woken === true
    && result.disposition.action === 'wake'
    && result.disposition.targetTaskId === e2eTask.id
    && task.status === 'queued'
    && task.round === 2
    && events.some((event) => event.type === 'task.woken' && event.payload.round === 2)
    && pending.length === 1
    && pending[0].round === 2
    && relayCalls.some((call) => call.op === 'enqueue' && call.taskId === e2eTask.id)
})

e2eTasks.transition(e2eTask.id, { to: 'running' })
e2eTasks.transition(e2eTask.id, { to: 'succeeded', summary: 'v2 delivered' })

await check('AR37 E2E: after revoke the reply is unowned — no wake, no attach, back to the foreground', async () => {
  e2eGrants.revoke(e2eGrant.id)
  relayCalls.length = 0
  const result = await replyAgain()
  const task = e2eTasks.getTask(e2eTask.id)
  // AR37 diagnostics: scanning now reads revoked rows too, so the precise
  // `revoked` reason is reported instead of a blanket `not-found`.
  return result.wake.granted === false
    && result.wake.reason === 'revoked'
    && result.target.kind === 'orchestrator'
    && result.disposition === null
    && task.status === 'succeeded'
    && task.round === 2
    && relayCalls.length === 0
})

e2eTasks.close()
e2eGateway.close()
e2eGrants.close()

store.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\ngrants: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
