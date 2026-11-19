import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseConstructor from 'better-sqlite3'
import {
  GATEWAY_TOOL_PORT,
  GATEWAY_TOOL_RISK,
  GatewayError,
  OUTBOX_BACKOFF_MS,
  OUTBOX_MAX_ATTEMPTS,
  TransportError,
  apply,
  controlTask,
  createGatewayStore,
  createOutboxDispatcher,
  createReceiptRelay,
  createTaskProgressRelay,
  defaultTriage,
  inboundText,
  ingestInbound,
  inject,
  name,
  redactedText,
  registerGatewayTools,
  resolveFollowUp,
} from '../lib/index.js'
import {
  createMemoryStore,
  createProjectLookupPort,
  projectMemoryContext,
} from '@dsh-wfxm/knowledge'

let pass = 0
let fail = 0
async function check(label, fn) {
  try {
    const ok = await fn()
    if (ok) {
      pass++
      console.log(`PASS  ${label}`)
    } else {
      fail++
      console.log(`FAIL  ${label}`)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'gateway-'))
const dbPath = join(dir, 'ops.sqlite')
const store = createGatewayStore(dbPath)

// A mutable clock keeps the retry ladder deterministic.
let clock = new Date('2026-11-09T00:00:00.000Z')
const now = () => new Date(clock)
const advance = (ms) => {
  clock = new Date(clock.getTime() + ms)
}

// ---- schema -----------------------------------------------------------------

await check('migration creates the module-① tables plus the B1 threads anchor', () => {
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  const version = db
    .prepare('SELECT version FROM schema_migrations WHERE module = ?')
    .get('gateway')
  const objects = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger')")
    .all()
    .map((row) => row.name)
  const routeColumns = db
    .prepare('PRAGMA table_info(session_routes)')
    .all()
    .map((row) => row.name)
  db.close()
  return ['inbox', 'actors', 'channel_bindings', 'session_routes', 'route_decisions', 'outbox', 'threads', 'pairing_codes']
    .every((table) => names.includes(table))
    && version.version === 9
    && routeColumns.includes('chat_id')
    && !routeColumns.includes('thread_id')
    && objects.includes('ux_inbox_dedup')
    && objects.includes('ux_binding_live')
    && objects.includes('route_decisions_no_update')
    && objects.includes('route_decisions_no_delete')
    && objects.includes('ix_outbox_pending')
    && objects.includes('ux_thread_key')
    && objects.includes('ix_threads_chat')
    && objects.includes('ux_outbox_dedupe')
    && objects.includes('ix_pairing_codes_expiry')
})

await check('a v1 database upgrades to the current schema: threads, dedupe, chat_id rename', () => {
  const upgradePath = join(dir, 'upgrade.sqlite')
  const first = createGatewayStore(upgradePath)
  first.close()
  const raw = new DatabaseConstructor(upgradePath)
  raw.exec(`
    DROP TABLE threads;
    DROP INDEX ux_outbox_dedupe;
    ALTER TABLE outbox DROP COLUMN dedupe_key;
    DROP TABLE session_routes;
    CREATE TABLE session_routes (
      channel_id   TEXT NOT NULL,
      thread_id    TEXT NOT NULL,
      session_kind TEXT NOT NULL CHECK (session_kind IN ('orchestrator','chat')),
      session_id   TEXT NOT NULL,
      project_id   TEXT,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (channel_id, thread_id, session_kind)
    );
    INSERT INTO session_routes(channel_id, thread_id, session_kind, session_id, project_id, updated_at)
      VALUES ('cli_app', 'chat_legacy', 'orchestrator', 'sess_legacy', NULL, '2026-11-01T00:00:00.000Z');
    ALTER TABLE route_decisions DROP COLUMN project_id;
    ALTER TABLE route_decisions DROP COLUMN project_matched_by;
  `)
  raw.prepare("UPDATE schema_migrations SET version = 1 WHERE module = 'gateway'").run()
  raw.close()
  const reopened = createGatewayStore(upgradePath)
  const db = new DatabaseConstructor(upgradePath, { readonly: true })
  const hasThreads = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
    .get() !== undefined
  const hasDedupe = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_outbox_dedupe'")
    .get() !== undefined
  const routeColumns = db
    .prepare('PRAGMA table_info(session_routes)')
    .all()
    .map((row) => row.name)
  const version = db.prepare("SELECT version FROM schema_migrations WHERE module = 'gateway'").get()
  db.close()
  const migrated = reopened.getSessionRoute('cli_app', 'chat_legacy', 'orchestrator')
  const inboxStillWorks = reopened.listInbox().length === 0
  reopened.close()
  return hasThreads
    && hasDedupe
    && version.version === 9
    && routeColumns.includes('chat_id')
    && !routeColumns.includes('thread_id')
    && migrated !== null
    && migrated.chatId === 'chat_legacy'
    && migrated.sessionId === 'sess_legacy'
    && inboxStillWorks
})

await check('migration is idempotent on reopen', () => {
  const second = createGatewayStore(dbPath)
  const ok = second.listInbox().length === store.listInbox().length
  second.close()
  return ok
})

// ---- inbox dedup (AR28) ------------------------------------------------------

const accepted = store.acceptInbound({
  channelId: 'cli_app',
  msgId: 'evt_1',
  content: { text: '帮我看下磁盘' },
  chatId: 'chat_a',
  threadId: 'thr_a',
  replyToMsgId: 'm_0',
})

await check('first inbound lands as accepted with its routing anchors', () => {
  const item = accepted.inbox
  return accepted.duplicate === false
    && item.status === 'accepted'
    && item.kind === 'message'
    && item.content.text === '帮我看下磁盘'
    && item.chatId === 'chat_a'
    && item.threadId === 'thr_a'
    && item.replyToMsgId === 'm_0'
    && item.receivedAt !== null
    && item.processedAt === null
    && store.listInbox().length === 1
})

await check('replaying the same (channel, msg) returns the stored row, not a new one', () => {
  store.updateInboxStatus(accepted.inbox.id, 'done')
  const replay = store.acceptInbound({
    channelId: 'cli_app',
    msgId: 'evt_1',
    content: { text: 'ignored on replay' },
  })
  return replay.duplicate === true
    && replay.inbox.id === accepted.inbox.id
    && replay.inbox.status === 'done'
    && store.listInbox().length === 1
})

await check('the same msg id on another channel is a different message', () => {
  const other = store.acceptInbound({
    channelId: 'cli_other',
    msgId: 'evt_1',
    content: { text: 'other channel' },
  })
  return other.duplicate === false
    && other.inbox.id !== accepted.inbox.id
    && store.listInbox().length === 2
})

await check('listInbox applies an inclusive received_at window and still composes filters', () => {
  const at = accepted.inbox.receivedAt
  const before = new Date(Date.parse(at) - 1).toISOString()
  assert.equal(store.listInbox({ since: at, until: at, channelId: 'cli_app' }).length, 1)
  assert.equal(store.listInbox({ until: before }).length, 0)
  assert.equal(store.listInbox({ since: at, status: 'done', channelId: 'cli_app' }).length, 1)
  return true
})

await check('inboundText extracts redacted text; non-text content is null', () => {
  const secret = `sk-${'a'.repeat(24)}`
  const text = inboundText({ text: `调用 ${secret} 完成` })
  assert.match(text, /\[redacted:api-key:/)
  assert.ok(!text.includes(secret))
  assert.equal(inboundText({ file: 'x' }), null)
  assert.equal(inboundText({ text: '   ' }), null)
  assert.equal(inboundText(null), null)
  assert.equal(redactedText(`Bearer ${'b'.repeat(20)}`), 'Bearer bbbb…[redacted:bearer:20]')
  return true
})

await check('empty channel / msg id and unknown kind are rejected', () => {
  assert.throws(
    () => store.acceptInbound({ channelId: '', msgId: 'x', content: {} }),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  assert.throws(
    () => store.acceptInbound({ channelId: 'cli_app', msgId: '', content: {} }),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  assert.throws(
    () => store.acceptInbound({ channelId: 'cli_app', msgId: 'x', kind: 'gift', content: {} }),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  return true
})

await check('status updates validate the whitelist and stamp processed_at', () => {
  const item = store.listInbox({ channelId: 'cli_other' })[0]
  const triaged = store.updateInboxStatus(item.id, 'triaged')
  const rejected = store.updateInboxStatus(item.id, 'rejected', 'unpaired')
  assert.throws(
    () => store.updateInboxStatus(item.id, 'archived'),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  assert.throws(
    () => store.updateInboxStatus('missing', 'done'),
    (error) => error instanceof GatewayError && error.code === 'not-found',
  )
  return triaged.processedAt === null
    && rejected.status === 'rejected'
    && rejected.errorCode === 'unpaired'
    && rejected.processedAt !== null
})

// ---- identity pairing --------------------------------------------------------

const owner = store.createActor({ kind: 'owner', displayName: 'Owner' })

await check('an unpaired open_id resolves to nobody', () => {
  return store.resolveActor('cli_app', 'open_1') === null
    && store.listBindings().length === 0
})

const binding = store.bindChannel({
  actorId: owner.id,
  channelId: 'cli_app',
  externalUserId: 'open_1',
})

await check('binding a live open_id resolves to the owner actor', () => {
  const resolved = store.resolveActor('cli_app', 'open_1')
  return resolved !== null
    && resolved.actor.id === owner.id
    && resolved.binding.id === binding.id
    && binding.revokedAt === null
})

await check('duplicate bind of a live open_id is a conflict', () => {
  assert.throws(
    () => store.bindChannel({ actorId: owner.id, channelId: 'cli_app', externalUserId: 'open_1' }),
    (error) => error instanceof GatewayError && error.code === 'conflict',
  )
  return store.listBindings().length === 1
})

await check('one actor can bind several open_ids and several channels', () => {
  store.bindChannel({ actorId: owner.id, channelId: 'cli_app', externalUserId: 'open_2' })
  store.bindChannel({ actorId: owner.id, channelId: 'cli_other', externalUserId: 'open_1' })
  return store.listBindings().length === 3
    && store.resolveActor('cli_app', 'open_2')?.actor.id === owner.id
    && store.resolveActor('cli_other', 'open_1')?.actor.id === owner.id
})

await check('unbind revokes access and a re-bind creates a new live row', () => {
  const revoked = store.unbindChannel({ channelId: 'cli_app', externalUserId: 'open_1' })
  const gone = store.resolveActor('cli_app', 'open_1') === null
  const rebound = store.bindChannel({
    actorId: owner.id,
    channelId: 'cli_app',
    externalUserId: 'open_1',
  })
  const live = store.listBindings()
  return revoked.revokedAt !== null
    && gone
    && rebound.id !== binding.id
    && live.length === 3
    && store.listBindings({ includeRevoked: true }).length === 4
})

await check('binding to a missing actor is refused', () => {
  assert.throws(
    () => store.bindChannel({ actorId: 'nope', channelId: 'cli_app', externalUserId: 'open_9' }),
    (error) => error instanceof GatewayError && error.code === 'not-found',
  )
  return true
})

// ---- pairing codes (docs/14 §四) ----------------------------------------------

await check('mint returns a code once and persists only its hash', () => {
  const minted = store.mintPairingCode({ actorId: owner.id, channelId: 'cli_app' })
  assert.match(minted.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  const raw = new DatabaseConstructor(dbPath, { readonly: true })
  const row = raw.prepare('SELECT * FROM pairing_codes').all()
  raw.close()
  return row.length === 1
    && row[0].code_hash !== minted.code
    && !row[0].code_hash.includes('-')
    && row[0].actor_id === owner.id
    && row[0].channel_id === 'cli_app'
    && row[0].consumed_at === null
    && minted.expiresAt > new Date().toISOString()
})

await check('minting for a missing actor or with a bad ttl is refused', () => {
  assert.throws(
    () => store.mintPairingCode({ actorId: 'nope' }),
    (error) => error instanceof GatewayError && error.code === 'not-found',
  )
  assert.throws(
    () => store.mintPairingCode({ actorId: owner.id, ttlMs: 1000 }),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  return true
})

await check('consume binds atomically and the code is spent', () => {
  const minted = store.mintPairingCode({ actorId: owner.id })
  const consumed = store.consumePairingCode({
    code: minted.code.toLowerCase().replace('-', ' '), // normalization: case + separators
    channelId: 'cli_app',
    externalUserId: 'open_pair_1',
  })
  assert.equal(consumed.actor.id, owner.id)
  assert.throws(
    () => store.consumePairingCode({
      code: minted.code,
      channelId: 'cli_app',
      externalUserId: 'open_pair_2',
    }),
    (error) => error instanceof GatewayError && error.code === 'conflict',
  )
  return store.resolveActor('cli_app', 'open_pair_1')?.actor.id === owner.id
    && store.resolveActor('cli_app', 'open_pair_2') === null
})

await check('unknown, expired and wrong-channel codes fail without binding', () => {
  assert.throws(
    () => store.consumePairingCode({ code: 'ZZZZ-ZZZZ', channelId: 'cli_app', externalUserId: 'open_x' }),
    (error) => error instanceof GatewayError && error.code === 'not-found',
  )
  const expired = store.mintPairingCode({ actorId: owner.id, now: new Date(Date.now() - 10 * 60_000) })
  assert.throws(
    () => store.consumePairingCode({ code: expired.code, channelId: 'cli_app', externalUserId: 'open_x' }),
    (error) => error instanceof GatewayError && error.code === 'invalid-state',
  )
  const scoped = store.mintPairingCode({ actorId: owner.id, channelId: 'other_app' })
  assert.throws(
    () => store.consumePairingCode({ code: scoped.code, channelId: 'cli_app', externalUserId: 'open_x' }),
    (error) => error instanceof GatewayError && error.code === 'conflict',
  )
  return store.resolveActor('cli_app', 'open_x') === null
})

await check('an identity with a live binding cannot consume a code', () => {
  const minted = store.mintPairingCode({ actorId: owner.id })
  assert.throws(
    () => store.consumePairingCode({ code: minted.code, channelId: 'cli_app', externalUserId: 'open_2' }),
    (error) => error instanceof GatewayError && error.code === 'conflict',
  )
  // The failed consume did not spend the code: a different identity can still claim it.
  const consumed = store.consumePairingCode({
    code: minted.code,
    channelId: 'cli_app',
    externalUserId: 'open_pair_3',
  })
  return consumed.actor.id === owner.id
})

// ---- session routes ----------------------------------------------------------

await check('two chats of the same channel share the single foreground session', () => {
  store.setSessionRoute({
    channelId: 'cli_app',
    chatId: 'chat_a',
    sessionKind: 'orchestrator',
    sessionId: 'sess_foreground',
  })
  store.setSessionRoute({
    channelId: 'cli_app',
    chatId: 'chat_b',
    sessionKind: 'orchestrator',
    sessionId: 'sess_foreground',
  })
  const routes = store.listSessionRoutes({ channelId: 'cli_app', sessionKind: 'orchestrator' })
  return routes.length === 2
    && routes.every((route) => route.sessionId === 'sess_foreground')
})

await check('re-routing a chat updates in place instead of appending', () => {
  const updated = store.setSessionRoute({
    channelId: 'cli_app',
    chatId: 'chat_a',
    sessionKind: 'orchestrator',
    sessionId: 'sess_foreground_v2',
    projectId: 'proj_1',
  })
  const route = store.getSessionRoute('cli_app', 'chat_a', 'orchestrator')
  return updated.sessionId === 'sess_foreground_v2'
    && route.sessionId === 'sess_foreground_v2'
    && route.projectId === 'proj_1'
    && store.listSessionRoutes({ channelId: 'cli_app' }).length === 2
})

await check('chat and orchestrator routes are separate rows for the same thread', () => {
  store.setSessionRoute({
    channelId: 'cli_app',
    chatId: 'chat_a',
    sessionKind: 'chat',
    sessionId: 'sess_web_deep',
  })
  return store.listSessionRoutes({ channelId: 'cli_app' }).length === 3
    && store.getSessionRoute('cli_app', 'chat_a', 'chat')?.sessionId === 'sess_web_deep'
    && store.getSessionRoute('cli_app', 'chat_a', 'orchestrator')?.sessionId === 'sess_foreground_v2'
})

await check('unknown session kind is rejected', () => {
  assert.throws(
    () => store.setSessionRoute({
      channelId: 'cli_app',
      chatId: 'chat_a',
      sessionKind: 'foreground',
      sessionId: 'x',
    }),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  return true
})

await check('the session_routes contract step refuses a half-migrated row', () => {
  const path = join(dir, 'contract-refused.sqlite')
  const first = createGatewayStore(path)
  first.close()
  const raw = new DatabaseConstructor(path)
  raw.exec(`
    DROP TABLE session_routes;
    CREATE TABLE session_routes (
      channel_id   TEXT NOT NULL,
      thread_id    TEXT NOT NULL,
      chat_id      TEXT,
      session_kind TEXT NOT NULL CHECK (session_kind IN ('orchestrator','chat')),
      session_id   TEXT NOT NULL,
      project_id   TEXT,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (channel_id, thread_id, session_kind)
    );
    INSERT INTO session_routes(channel_id, thread_id, chat_id, session_kind, session_id, updated_at)
      VALUES ('cli_app', 'chat_legacy', NULL, 'orchestrator', 'sess_legacy', '2026-11-01T00:00:00.000Z');
  `)
  raw.prepare("UPDATE schema_migrations SET version = 5 WHERE module = 'gateway'").run()
  raw.close()
  assert.throws(
    () => createGatewayStore(path),
    (error) => error instanceof GatewayError && /contract refused/.test(error.message),
  )
  return true
})

// ---- route decisions ---------------------------------------------------------

const decision = store.appendRouteDecision({
  triggerId: accepted.inbox.id,
  action: 'answer',
  reason: 'small talk, answered in the foreground session',
  threadId: 'thr_a',
  confidence: 0.9,
  promptVersion: 'router-v1',
})

await check('route decisions are stored with their reason and confidence', () => {
  const decisions = store.listRouteDecisions({ triggerId: accepted.inbox.id })
  return decisions.length === 1
    && decisions[0].id === decision.id
    && decisions[0].action === 'answer'
    && decisions[0].confidence === 0.9
    && decisions[0].promptVersion === 'router-v1'
})

await check('decisions require a reason and a known action', () => {
  assert.throws(
    () => store.appendRouteDecision({ triggerId: 't', action: 'answer', reason: '  ' }),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  assert.throws(
    () => store.appendRouteDecision({ triggerId: 't', action: 'delegate', reason: 'x' }),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  return true
})

await check('route_decisions is append-only at the database level', () => {
  const db = new DatabaseConstructor(dbPath)
  let updateBlocked = false
  let deleteBlocked = false
  try {
    db.prepare("UPDATE route_decisions SET reason = 'rewritten' WHERE id = ?").run(decision.id)
  } catch (error) {
    updateBlocked = /append-only/.test(String(error.message))
  }
  try {
    db.prepare('DELETE FROM route_decisions WHERE id = ?').run(decision.id)
  } catch (error) {
    deleteBlocked = /append-only/.test(String(error.message))
  }
  db.close()
  return updateBlocked && deleteBlocked
})

// ---- threads (B1 anchor, 15 §9.1) --------------------------------------------

await check('threads are unique per (channel, chat, kind, topic|root) and touch last_msg_at', () => {
  const first = store.resolveThread({
    channelId: 'cli_app',
    chatId: 'chat_a',
    topicId: 'topic_1',
    now: new Date('2026-11-09T03:00:00.000Z'),
  })
  const again = store.resolveThread({
    channelId: 'cli_app',
    chatId: 'chat_a',
    topicId: 'topic_1',
    now: new Date('2026-11-09T03:05:00.000Z'),
  })
  const otherTopic = store.resolveThread({
    channelId: 'cli_app',
    chatId: 'chat_a',
    topicId: 'topic_2',
    now: new Date('2026-11-09T03:10:00.000Z'),
  })
  const root = store.resolveThread({
    channelId: 'cli_app',
    chatId: 'chat_a',
    now: new Date('2026-11-09T03:15:00.000Z'),
  })
  const threads = store.listThreads({ channelId: 'cli_app', chatId: 'chat_a' })
  return first.kind === 'topic'
    && first.topicId === 'topic_1'
    && again.id === first.id
    && again.lastMsgAt === '2026-11-09T03:05:00.000Z'
    && otherTopic.id !== first.id
    && root.kind === 'root'
    && root.topicId === null
    && root.rootMsgId === null
    && threads.length === 3
    && store.getThread(first.id).id === first.id
    && store.getThread('missing') === null
})

await check('a thread requires chatId and a topic thread without topic is just a root', () => {
  assert.throws(
    () => store.resolveThread({ channelId: 'cli_app', chatId: '' }),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  const root = store.resolveThread({ channelId: 'cli_app', chatId: 'chat_b', topicId: null })
  return root.kind === 'root' && root.chatId === 'chat_b'
})

// ---- ingest: triage and bypass (AR25 v2, 11 §5.3 / §13.3) --------------------

await check('default triage is deterministic and protocol-agnostic', () => {
  const base = { channelId: 'c', msgId: 'm', content: {} }
  return defaultTriage({ ...base, kind: 'card_action' }) === 'approval_answer'
    && defaultTriage({ ...base, kind: 'control' }) === 'control'
    && defaultTriage({ ...base, content: { event: 'alert' } }) === 'event'
    && defaultTriage({ ...base, content: { control: 'stop' } }) === 'control'
    && defaultTriage({ ...base, content: { text: '停止 29b3ywszfu' } }) === 'control'
    && defaultTriage({ ...base, content: { text: 'stop abcd1234' } }) === 'control'
    && defaultTriage({ ...base, content: { text: '请停止这个任务' } }) === 'chat'
    && defaultTriage({ ...base, content: { text: '继续' } }) === 'chat'
    && defaultTriage({ ...base, content: { text: '/status' } }) === 'command'
    && defaultTriage({ ...base, content: { text: '磁盘怎么样' } }) === 'chat'
})

const ingestStore = createGatewayStore(join(dir, 'ingest.sqlite'))
const ingestOwner = ingestStore.createActor({ kind: 'owner', displayName: 'Owner' })
ingestStore.bindChannel({
  actorId: ingestOwner.id,
  channelId: 'cli_ing',
  externalUserId: 'open_ing',
})
const bot = ingestStore.createActor({ kind: 'system', displayName: 'CI' })
ingestStore.bindChannel({ actorId: bot.id, channelId: 'cli_ing', externalUserId: 'open_bot' })

await check('an unpaired identity is stored, silently rejected and audited', async () => {
  const result = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_unpaired',
    externalUserId: 'open_unknown',
    content: { text: 'let me in' },
    chatId: 'chat_ing',
  })
  const stored = ingestStore.getInbox(result.inbox.id)
  return result.bypassReason === 'unpaired'
    && result.target.kind === 'none'
    && result.actor === null
    && result.thread === null
    && result.disposition.action === 'ignore'
    && stored.status === 'rejected'
    && stored.errorCode === 'unpaired'
    && stored.chatId === 'chat_ing'
    && stored.threadId === null
})

await check('an unpaired /bind claims the code and binds; a wrong code stays a silent reject', async () => {
  const minted = ingestStore.mintPairingCode({ actorId: ingestOwner.id })
  const bound = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_bind',
    externalUserId: 'open_newbie',
    content: { text: `/bind ${minted.code}` },
    chatId: 'chat_ing',
  })
  const stored = ingestStore.getInbox(bound.inbox.id)
  const wrong = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_bind_wrong',
    externalUserId: 'open_stranger',
    content: { text: '/bind ZZZZ-ZZZZ' },
    chatId: 'chat_ing',
  })
  const followUp = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_after_bind',
    externalUserId: 'open_newbie',
    content: { text: '你好' },
    chatId: 'chat_ing',
  })
  return bound.bypassReason === 'pairing'
    && bound.actor.id === ingestOwner.id
    && bound.disposition.action === 'accept'
    && !bound.disposition.reason.includes(minted.code)
    && stored.status === 'done'
    && wrong.bypassReason === 'unpaired'
    && wrong.actor === null
    && ingestStore.getInbox(wrong.inbox.id).status === 'rejected'
    && followUp.actor.id === ingestOwner.id
    && followUp.target.kind === 'orchestrator'
})

await check('a paired chat message creates the thread and routes to the single orchestrator', async () => {
  const result = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_chat',
    externalUserId: 'open_ing',
    content: { text: '磁盘怎么样' },
    chatId: 'chat_ing',
  })
  return result.duplicate === false
    && result.actor.id === ingestOwner.id
    && result.intent === 'chat'
    && result.thread !== null
    && result.thread.chatId === 'chat_ing'
    && result.inbox.threadId === result.thread.id
    && result.inbox.status === 'routed'
    && result.target.kind === 'orchestrator'
    && result.bypassReason === null
    && result.disposition === null
})

await check('an approval answer bypasses the model and a replay reuses it', async () => {
  const first = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_card',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { approval_id: 'a1', nonce: 'n1', decision: 'approve' },
    chatId: 'chat_ing',
  })
  const replay = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_card',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { approval_id: 'a1', nonce: 'n1', decision: 'approve' },
    chatId: 'chat_ing',
  })
  // AR13: without a host-composed approval store the click is loud, not a no-op.
  return first.bypassReason === 'approval'
    && first.intent === 'approval_answer'
    && first.target.kind === 'approval'
    && first.inbox.status === 'failed'
    && first.inbox.errorCode === 'approval-unavailable'
    && first.error === 'approval-unavailable'
    && first.approval !== null
    && first.approval.ok === false
    && first.approval.code === 'approval-unavailable'
    && first.disposition.action === 'answer'
    && replay.duplicate === true
    && replay.inbox.id === first.inbox.id
    && replay.disposition.id === first.disposition.id
    // unpaired + /bind×2 + post-bind + chat + card×1 = 6 stored rows
    && ingestStore.listInbox({ channelId: 'cli_ing' }).length === 6
})

await check('a wired approval store accepts the decision and records the actor', async () => {
  const calls = []
  const ports = {
    approval: {
      answer: (input) => {
        calls.push(input)
        return { ok: true, code: 'ok', status: 'approved' }
      },
    },
  }
  const result = await ingestInbound({ store: ingestStore, ...ports }, {
    channelId: 'cli_ing',
    msgId: 'evt_card_ok',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { approval_id: 'a2', decision: 'approve', nonce: 'nonce-2' },
    chatId: 'chat_ing',
  })
  return calls.length === 1
    && calls[0].approvalId === 'a2'
    && calls[0].decision === 'approved'
    && calls[0].actorId === ingestOwner.id
    && calls[0].nonce === 'nonce-2'
    && result.inbox.status === 'done'
    && result.error === null
    && result.approval.ok === true
    && result.approval.status === 'approved'
    && result.disposition.action === 'answer'
    && result.disposition.reason.includes('accepted')
})

await check('a refused decision keeps ③ code on the inbox row (repeat click)', async () => {
  const result = await ingestInbound({
    store: ingestStore,
    approval: { answer: () => ({ ok: false, code: 'not-pending', status: 'approved' }) },
  }, {
    channelId: 'cli_ing',
    msgId: 'evt_card_again',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { approval_id: 'a2', decision: 'approve', nonce: 'nonce-2' },
    chatId: 'chat_ing',
  })
  return result.inbox.status === 'failed'
    && result.inbox.errorCode === 'not-pending'
    && result.error === null
    && result.approval.ok === false
    && result.approval.code === 'not-pending'
    && result.disposition.reason.includes('not-pending')
})

await check('a throwing approval store is fail-closed', async () => {
  const result = await ingestInbound({
    store: ingestStore,
    approval: {
      answer: () => {
        throw new Error('db closed')
      },
    },
  }, {
    channelId: 'cli_ing',
    msgId: 'evt_card_boom',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { approval_id: 'a3', decision: 'reject', nonce: 'n3' },
    chatId: 'chat_ing',
  })
  return result.inbox.status === 'failed'
    && result.inbox.errorCode === 'approval-unavailable'
    && result.error === 'approval-unavailable'
    && result.approval.ok === false
})

await check('a non-decision card action is audited but never consumes a nonce', async () => {
  let calls = 0
  const ports = {
    approval: {
      answer: () => {
        calls++
        return { ok: true, code: 'ok', status: 'approved' }
      },
    },
  }
  const details = await ingestInbound({ store: ingestStore, ...ports }, {
    channelId: 'cli_ing',
    msgId: 'evt_card_details',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { approval_id: 'a4', decision: 'details', nonce: 'n4' },
    chatId: 'chat_ing',
  })
  const malformed = await ingestInbound({ store: ingestStore, ...ports }, {
    channelId: 'cli_ing',
    msgId: 'evt_card_malformed',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { decision: 'approve' },
    chatId: 'chat_ing',
  })
  return calls === 0
    && details.inbox.status === 'done'
    && details.approval === null
    && details.disposition.action === 'answer'
    && details.details.ok === false
    && details.details.code === 'approval-unavailable'
    && malformed.inbox.status === 'done'
    && malformed.disposition.action === 'ignore'
    && malformed.disposition.reason.includes('missing-approval-id')
})

await check('the details button reads a port and never decides anything', async () => {
  let answers = 0
  const reads = []
  const ports = {
    approval: {
      answer: () => {
        answers++
        return { ok: true, code: 'ok', status: 'approved' }
      },
    },
    approvalDetails: {
      details: (input) => {
        reads.push(input)
        return {
          ok: true,
          code: 'ok',
          detail: {
            approvalId: input.approvalId,
            level: 'R3',
            summary: '重启 demo 服务',
            status: 'pending',
            stage: 0,
            task: { taskId: 't1', riskLevel: 'R3', assertions: [{ kind: 'service_active' }] },
          },
        }
      },
    },
  }
  const result = await ingestInbound({ store: ingestStore, ...ports }, {
    channelId: 'cli_ing',
    msgId: 'evt_card_details_ok',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { approval_id: 'a5', decision: 'details' },
    chatId: 'chat_ing',
  })
  return answers === 0
    && reads.length === 1
    && reads[0].approvalId === 'a5'
    && typeof reads[0].actorId === 'string' && reads[0].actorId.length > 0
    && result.inbox.status === 'done'
    && result.disposition.action === 'answer'
    && result.disposition.reason.includes('read-only')
    && result.approval === null
    && result.details.ok === true
    && result.details.detail.task.assertions[0].kind === 'service_active'
})

await check('R3 confirm-required is an intermediate state, not a failed click', async () => {
  const ports = {
    approval: {
      answer: (input) => input.decision === 'confirmed'
        ? { ok: true, code: 'ok', status: 'approved' }
        : { ok: false, code: 'confirm-required', status: 'pending', stage: 1, nonce: 'n6' },
    },
  }
  const result = await ingestInbound({ store: ingestStore, ...ports }, {
    channelId: 'cli_ing',
    msgId: 'evt_card_confirm_required',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { approval_id: 'a6', decision: 'approve', nonce: 'n6' },
    chatId: 'chat_ing',
  })
  const confirmed = await ingestInbound({ store: ingestStore, ...ports }, {
    channelId: 'cli_ing',
    msgId: 'evt_card_confirm',
    externalUserId: 'open_ing',
    kind: 'card_action',
    content: { approval_id: 'a6', decision: 'confirm', nonce: 'n6' },
    chatId: 'chat_ing',
  })
  return result.inbox.status === 'done'
    && result.approval.ok === false
    && result.approval.code === 'confirm-required'
    && result.approval.stage === 1
    && result.approval.nonce === 'n6'
    && result.disposition.reason.includes('second confirmation')
    && confirmed.approval.code === 'ok'
    && confirmed.approval.decision === 'confirmed'
})

await check('a structured stop command bypasses the model', async () => {
  const result = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_stop',
    externalUserId: 'open_ing',
    kind: 'control',
    content: { control: 'stop' },
    chatId: 'chat_ing',
  })
  return result.bypassReason === 'control'
    && result.target.kind === 'control'
    && result.target.command === 'stop'
    && result.disposition.action === 'stop'
    && result.inbox.status === 'triaged'
})

await check('a structured rollback command bypasses the model and carries the step id', async () => {
  const calls = []
  const port = {
    control: (input) => {
      calls.push(input)
      return { status: 'succeeded' }
    },
  }
  const live = controlTask(port, { command: 'rollback', taskId: 't-1', live: true, status: 'running' })
  const finished = controlTask(port, {
    command: 'rollback',
    taskId: 't-2',
    live: false,
    status: 'succeeded',
    checkpointId: 'cp-9',
  })
  const bare = controlTask(port, { command: 'rollback', taskId: 't-3', live: false, status: 'succeeded' })
  return live.executed === true && live.action === 'rollback'
    && finished.executed === true && finished.action === 'rollback'
    && calls[0].checkpointId === undefined
    && calls[1].checkpointId === 'cp-9'
    && calls[2].checkpointId === undefined
    && bare.executed === true
})

await check('H4: a bare 全局停止 halts without a task anchor', async () => {
  const calls = []
  const port = {
    halt() {
      calls.push('halt')
      return { halted: true }
    },
    resume() {
      calls.push('resume')
      return { halted: false }
    },
    status() {
      return { halted: true }
    },
  }
  const stopped = await ingestInbound({ store: ingestStore, global: port }, {
    channelId: 'cli_ing',
    msgId: 'evt_halt_cn',
    externalUserId: 'open_ing',
    kind: 'control',
    content: { text: '全局停止' },
    chatId: 'chat_ing',
  })
  const resumed = await ingestInbound({ store: ingestStore, global: port }, {
    channelId: 'cli_ing',
    msgId: 'evt_resume_all_en',
    externalUserId: 'open_ing',
    kind: 'control',
    content: { text: 'resume all' },
    chatId: 'chat_ing',
  })
  return stopped.target.command === 'halt'
    && stopped.global?.executed === true
    && stopped.global?.halted === true
    && stopped.disposition.action === 'stop'
    && resumed.target.command === 'resume_all'
    && resumed.global?.halted === false
    && calls.join(',') === 'halt,resume'
})

await check('H4: halt without a host port is a loud failure, never a fake stop', async () => {
  const result = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_halt_noport',
    externalUserId: 'open_ing',
    kind: 'control',
    content: { text: 'halt' },
    chatId: 'chat_ing',
  })
  return result.error === 'control-unavailable'
    && result.global?.executed === false
    && result.inbox.status === 'failed'
})

await check('H4: 全局状态 reports the halt state without touching a task', async () => {
  const port = { halt: () => ({ halted: true }), resume: () => ({ halted: false }), status: () => ({ halted: true }) }
  const result = await ingestInbound({ store: ingestStore, global: port }, {
    channelId: 'cli_ing',
    msgId: 'evt_status_all',
    externalUserId: 'open_ing',
    kind: 'control',
    content: { text: '全局状态' },
    chatId: 'chat_ing',
  })
  return result.target.command === 'status_all'
    && result.global?.halted === true
    && result.error === null
})

await check('a classifier may override triage, and a throwing classifier fails closed', async () => {
  const overridden = await ingestInbound(
    { store: ingestStore, classify: () => 'event' },
    {
      channelId: 'cli_ing',
      msgId: 'evt_cls',
      externalUserId: 'open_ing',
      content: { text: 'hi' },
      chatId: 'chat_ing',
    },
  )
  const failed = await ingestInbound(
    {
      store: ingestStore,
      classify: () => {
        throw new Error('policy down')
      },
    },
    {
      channelId: 'cli_ing',
      msgId: 'evt_policy_down',
      externalUserId: 'open_ing',
      content: { text: 'hi (classifier down)' },
      chatId: 'chat_ing',
    },
  )
  return overridden.intent === 'event'
    && overridden.target.kind === 'orchestrator'
    && overridden.bypassReason === null
    && failed.error === 'triage-unavailable'
    && failed.target.kind === 'none'
    && failed.inbox.status === 'accepted'
})

await check('a bot / CI message is recorded but never enters the front stage', async () => {
  const result = await ingestInbound({ store: ingestStore }, {
    channelId: 'cli_ing',
    msgId: 'evt_bot',
    externalUserId: 'open_bot',
    content: { text: 'deploy finished' },
    chatId: 'chat_ing',
  })
  return result.bypassReason === 'system-message'
    && result.actor.kind === 'system'
    && result.target.kind === 'none'
    && result.disposition.action === 'ignore'
    && result.inbox.status === 'triaged'
})

// ---- task anchors via the read-only view (15 §9.5) ---------------------------

const anchorPath = join(dir, 'anchor.sqlite')
const anchorStore = createGatewayStore(anchorPath)
const anchorOwner = anchorStore.createActor({ kind: 'owner' })
anchorStore.bindChannel({
  actorId: anchorOwner.id,
  channelId: 'cli_anc',
  externalUserId: 'open_anc',
})
const threadOne = anchorStore.resolveThread({ channelId: 'cli_anc', chatId: 'chat_one' })
const threadTwo = anchorStore.resolveThread({ channelId: 'cli_anc', chatId: 'chat_two' })
const threadThree = anchorStore.resolveThread({ channelId: 'cli_anc', chatId: 'chat_three' })
const fixture = new DatabaseConstructor(anchorPath)
fixture.exec(`
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, round INTEGER, origin_msg_id TEXT, project_id TEXT
);
CREATE TABLE task_threads (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  relation TEXT NOT NULL, anchor_msg_id TEXT, created_at TEXT NOT NULL, released_at TEXT
);
CREATE VIEW v_task_anchors AS
SELECT tt.task_id, tt.thread_id,
       COALESCE(tt.anchor_msg_id, tk.origin_msg_id) AS anchor_msg_id,
       tk.round, tk.status, tk.project_id
FROM task_threads tt JOIN tasks tk ON tk.id = tt.task_id
WHERE tt.released_at IS NULL;
`)
const insertTask = fixture.prepare(
  'INSERT INTO tasks(id, status, round, origin_msg_id, project_id) VALUES (?, ?, ?, ?, ?)',
)
insertTask.run('task_one', 'running', 2, 'm_one', 'proj_alpha')
insertTask.run('task_two_a', 'running', 1, 'm_two_a', 'proj_alpha')
insertTask.run('task_two_b', 'waiting_input', 3, 'm_two_b', 'proj_beta')
insertTask.run('task_three', 'succeeded', 1, 'm_three', 'proj_alpha')
const insertAnchor = fixture.prepare(`
  INSERT INTO task_threads(id, task_id, thread_id, relation, anchor_msg_id, created_at, released_at)
  VALUES (?, ?, ?, 'anchor', ?, '2026-11-09T04:00:00.000Z', NULL)
`)
insertAnchor.run('tt_one', 'task_one', threadOne.id, null)
insertAnchor.run('tt_two_a', 'task_two_a', threadTwo.id, null)
insertAnchor.run('tt_two_b', 'task_two_b', threadTwo.id, null)
insertAnchor.run('tt_three', 'task_three', threadThree.id, null)
fixture.prepare(`
  INSERT INTO task_threads(id, task_id, thread_id, relation, anchor_msg_id, created_at, released_at)
  VALUES ('tt_released', 'task_one', ?, 'anchor', 'm_released', '2026-11-09T04:00:00.000Z', '2026-11-09T05:00:00.000Z')
`).run(threadThree.id)
fixture.close()

await check('the anchor view is detected and a single live task wins', () => {
  const resolution = resolveFollowUp(anchorStore, {
    channelId: 'cli_anc',
    chatId: 'chat_one',
    threadId: threadOne.id,
  })
  return anchorStore.hasTaskAnchorView() === true
    && resolution.available === true
    && resolution.taskId === 'task_one'
    && resolution.status === 'running'
    && resolution.round === 2
    && resolution.matchedBy === 'single-live'
    && resolution.ambiguous === false
})

await check('a reply-to anchor beats the single-live guess', () => {
  const resolution = resolveFollowUp(anchorStore, {
    channelId: 'cli_anc',
    chatId: 'chat_one',
    threadId: threadOne.id,
    replyToMsgId: 'm_one',
  })
  return resolution.taskId === 'task_one'
    && resolution.matchedBy === 'anchor'
    && resolution.requiresGrantCheck === false
})

await check('two live tasks in one chat are ambiguous instead of guessed', () => {
  const resolution = resolveFollowUp(anchorStore, {
    channelId: 'cli_anc',
    chatId: 'chat_two',
    threadId: threadTwo.id,
  })
  return resolution.ambiguous === true
    && resolution.taskId === null
    && resolution.candidates.length === 2
    && resolution.candidates.includes('task_two_a')
    && resolution.candidates.includes('task_two_b')
})

await check('a single finished task is wakeable only after a Grant re-check (AR37)', () => {
  const resolution = resolveFollowUp(anchorStore, {
    channelId: 'cli_anc',
    chatId: 'chat_three',
    threadId: threadThree.id,
  })
  return resolution.taskId === 'task_three'
    && resolution.status === 'succeeded'
    && resolution.matchedBy === 'single-wakeable'
    && resolution.requiresGrantCheck === true
    && resolution.candidates.length === 1
})

await check('ingest delivers an anchored follow-up to its task, not the orchestrator', async () => {
  const live = await ingestInbound({ store: anchorStore }, {
    channelId: 'cli_anc',
    msgId: 'evt_anchor',
    externalUserId: 'open_anc',
    content: { text: '改成 80%' },
    chatId: 'chat_one',
    replyToMsgId: 'm_one',
  })
  const ambiguous = await ingestInbound({ store: anchorStore }, {
    channelId: 'cli_anc',
    msgId: 'evt_ambig',
    externalUserId: 'open_anc',
    content: { text: '继续' },
    chatId: 'chat_two',
  })
  const wake = await ingestInbound({ store: anchorStore }, {
    channelId: 'cli_anc',
    msgId: 'evt_wake',
    externalUserId: 'open_anc',
    content: { text: '再跑一次' },
    chatId: 'chat_three',
  })
  return live.bypassReason === 'task-anchor'
    && live.target.kind === 'task'
    && live.target.taskId === 'task_one'
    && live.disposition.action === 'attach'
    && live.inbox.status === 'triaged'
    && ambiguous.bypassReason === 'ambiguous-task'
    && ambiguous.target.kind === 'ask'
    && ambiguous.target.candidates.length === 2
    && ambiguous.disposition.action === 'ask'
    && wake.target.kind === 'task'
    && wake.target.taskId === 'task_three'
    && wake.followUp.requiresGrantCheck === true
})

// ---- task relay: only the module API, never ⑤'s tables (AR33) ----------------

const relayCalls = []
const fakeRelay = {
  attach(input) {
    relayCalls.push({ op: 'attach', ...input })
    return { id: 'sub_fake' }
  },
  enqueue(input) {
    relayCalls.push({ op: 'enqueue', ...input })
    return { id: 'input_fake' }
  },
}

await check('a live anchored follow-up is relayed and the reply anchor is bound', async () => {
  relayCalls.length = 0
  const result = await ingestInbound({ store: anchorStore, relay: fakeRelay }, {
    channelId: 'cli_anc',
    msgId: 'evt_relay_live',
    externalUserId: 'open_anc',
    content: { text: '改成 90%' },
    chatId: 'chat_one',
    replyToMsgId: 'm_one',
  })
  return result.relay.enqueued === true
    && result.relay.attached === true
    && result.relay.subscriptionId === 'sub_fake'
    && result.relay.inputId === 'input_fake'
    && result.relay.skipped === null
    && relayCalls[0].op === 'attach'
    && relayCalls[0].taskId === 'task_one'
    && relayCalls[0].anchorMsgId === 'm_one'
    && relayCalls[1].op === 'enqueue'
    && relayCalls[1].taskId === 'task_one'
    && relayCalls[1].inboxId === result.inbox.id
    && result.inbox.status === 'triaged'
})

await check('a finished task is attached but never enqueued before a Grant re-check', async () => {
  relayCalls.length = 0
  const result = await ingestInbound({ store: anchorStore, relay: fakeRelay }, {
    channelId: 'cli_anc',
    msgId: 'evt_relay_wake',
    externalUserId: 'open_anc',
    content: { text: '再跑一次（第二次）' },
    chatId: 'chat_three',
  })
  return result.relay.skipped === 'finished-needs-grant'
    && result.relay.enqueued === false
    && result.relay.inputId === null
    && relayCalls.every((call) => call.op !== 'enqueue')
    && result.followUp.requiresGrantCheck === true
    && result.inbox.status === 'triaged'
})

await check('without a relay port the routing decision stands (no-port)', async () => {
  const result = await ingestInbound({ store: anchorStore }, {
    channelId: 'cli_anc',
    msgId: 'evt_relay_absent',
    externalUserId: 'open_anc',
    content: { text: '不接线也能审计' },
    chatId: 'chat_one',
    replyToMsgId: 'm_one',
  })
  return result.relay.skipped === 'no-port'
    && result.relay.enqueued === false
    && result.bypassReason === 'task-anchor'
    && result.inbox.status === 'triaged'
})

await check('a relay failure marks the inbox failed instead of dropping silently', async () => {
  const brokenRelay = {
    attach() {
      throw new Error('tasks store unavailable')
    },
    enqueue() {
      return { id: 'never' }
    },
  }
  const result = await ingestInbound({ store: anchorStore, relay: brokenRelay }, {
    channelId: 'cli_anc',
    msgId: 'evt_relay_broken',
    externalUserId: 'open_anc',
    content: { text: '这条会失败' },
    chatId: 'chat_one',
    replyToMsgId: 'm_one',
  })
  return result.error === 'relay-unavailable'
    && result.inbox.status === 'failed'
    && result.inbox.errorCode === 'relay-unavailable'
    && result.disposition.action === 'attach'
    && result.disposition.targetTaskId === 'task_one'
})


// ---- AR37 wake: Grant re-check, then re-queue (11 §13.3) --------------------

const wakeCalls = []
const passingGrant = {
  verify(input) {
    wakeCalls.push({ op: 'verify', ...input })
    return { ok: true, reason: 'ok' }
  },
}
const postingWake = {
  wake(input) {
    wakeCalls.push({ op: 'wake', ...input })
    return { status: 'queued', round: 3 }
  },
}

await check('a re-verified reply wakes the finished task and queues the message', async () => {
  wakeCalls.length = 0
  relayCalls.length = 0
  const result = await ingestInbound({
    store: anchorStore,
    relay: fakeRelay,
    grantCheck: passingGrant,
    wake: postingWake,
  }, {
    channelId: 'cli_anc',
    msgId: 'evt_wake_ok',
    externalUserId: 'open_anc',
    content: { text: '接着上一轮再做一次' },
    chatId: 'chat_three',
    replyToMsgId: 'm_three',
  })
  return result.wake.granted === true
    && result.wake.woken === true
    && result.wake.round === 3
    && result.wake.reason === null
    && result.disposition.action === 'wake'
    && result.disposition.targetTaskId === 'task_three'
    && result.relay.enqueued === true
    && result.inbox.status === 'triaged'
    && wakeCalls.length === 2
    && wakeCalls[0].op === 'verify'
    && wakeCalls[0].actorId === anchorOwner.id
    && wakeCalls[0].required.actions.join() === 'task.wake'
    && wakeCalls[0].required.domain === 'proj_alpha'
    && wakeCalls[1].op === 'wake'
    && wakeCalls[1].taskId === 'task_three'
    && relayCalls.some((call) => call.op === 'enqueue' && call.taskId === 'task_three')
})

await check('a revoked Grant is an unowned message: no wake, no attach, back to the foreground', async () => {
  wakeCalls.length = 0
  relayCalls.length = 0
  const denyingGrant = {
    verify(input) {
      wakeCalls.push({ op: 'verify', ...input })
      return { ok: false, reason: 'revoked' }
    },
  }
  const result = await ingestInbound({
    store: anchorStore,
    relay: fakeRelay,
    grantCheck: denyingGrant,
    wake: postingWake,
  }, {
    channelId: 'cli_anc',
    msgId: 'evt_wake_denied',
    externalUserId: 'open_anc',
    content: { text: '这条不该唤醒' },
    chatId: 'chat_three',
    replyToMsgId: 'm_three',
  })
  return result.wake.granted === false
    && result.wake.woken === false
    && result.wake.reason === 'revoked'
    && result.target.kind === 'orchestrator'
    && result.bypassReason === null
    && result.disposition === null
    && result.inbox.status === 'routed'
    && relayCalls.length === 0
    && wakeCalls.every((call) => call.op !== 'wake')
})

await check('a half-wired wake (missing grant or wake port) keeps the attach-only marker', async () => {
  const onlyGrant = await ingestInbound({
    store: anchorStore,
    relay: fakeRelay,
    grantCheck: passingGrant,
  }, {
    channelId: 'cli_anc',
    msgId: 'evt_wake_no_wake_port',
    externalUserId: 'open_anc',
    content: { text: '只接了一半' },
    chatId: 'chat_three',
    replyToMsgId: 'm_three',
  })
  const onlyWake = await ingestInbound({
    store: anchorStore,
    relay: fakeRelay,
    wake: postingWake,
  }, {
    channelId: 'cli_anc',
    msgId: 'evt_wake_no_grant_port',
    externalUserId: 'open_anc',
    content: { text: '也只接了一半' },
    chatId: 'chat_three',
    replyToMsgId: 'm_three',
  })
  return onlyGrant.relay.skipped === 'finished-needs-grant'
    && onlyGrant.followUp.requiresGrantCheck === true
    && onlyGrant.wake === undefined
    && onlyWake.relay.skipped === 'finished-needs-grant'
    && onlyWake.followUp.requiresGrantCheck === true
    && onlyWake.wake === undefined
})

await check('a wake that ⑤ refuses marks the inbox failed instead of pretending', async () => {
  const brokenWake = {
    wake() {
      throw new Error('tasks store unavailable')
    },
  }
  const result = await ingestInbound({
    store: anchorStore,
    relay: fakeRelay,
    grantCheck: passingGrant,
    wake: brokenWake,
  }, {
    channelId: 'cli_anc',
    msgId: 'evt_wake_broken',
    externalUserId: 'open_anc',
    content: { text: '唤醒会失败' },
    chatId: 'chat_three',
    replyToMsgId: 'm_three',
  })
  return result.error === 'wake-unavailable'
    && result.inbox.status === 'failed'
    && result.inbox.errorCode === 'wake-unavailable'
    && result.disposition.action === 'wake'
    && result.disposition.targetTaskId === 'task_three'
})


await check('enqueue writes a pending row with the routing anchors', () => {
  const item = store.enqueueOutbox({
    topic: 'say',
    payload: { text: 'hello' },
    threadId: 'thr_a',
    replyToMsgId: 'm_1',
    taskId: 'task_1',
    now: now(),
  })
  return item.status === 'pending'
    && item.attempts === 0
    && item.nextRetryAt === null
    && item.externalMsgId === null
    && item.threadId === 'thr_a'
    && item.replyToMsgId === 'm_1'
    && item.taskId === 'task_1'
    && store.getOutbox(item.id).payload.text === 'hello'
})

const claimed = store.claimOutbox({ owner: 'A', leaseMs: 1000, now: now() })

await check('claim takes a lease, counts one attempt and blocks other owners', () => {
  const blocked = store.claimOutbox({ owner: 'B', leaseMs: 1000, now: now() })
  return claimed.length === 1
    && claimed[0].attempts === 1
    && claimed[0].leaseOwner === 'A'
    && claimed[0].leaseExpiresAt !== null
    && blocked.length === 0
})

await check('an ack without external_msg_id is refused and the row stays pending', () => {
  assert.throws(
    () => store.markOutboxSent(claimed[0].id, '   '),
    (error) => error instanceof GatewayError && error.code === 'invalid-input',
  )
  return store.getOutbox(claimed[0].id).status === 'pending'
})

await check('a real ack stores external_msg_id and marks the row sent', () => {
  const sent = store.markOutboxSent(claimed[0].id, 'ext_1', now())
  return sent.status === 'sent'
    && sent.externalMsgId === 'ext_1'
    && sent.sentAt === now().toISOString()
    && sent.leaseOwner === null
    && sent.leaseExpiresAt === null
})

await check('failed delivery backs off 1s and is not claimable early', () => {
  const item = store.enqueueOutbox({ topic: 'say', payload: { text: 'retry me' }, now: now() })
  store.claimOutbox({ owner: 'A', leaseMs: 1000, now: now() })
  const failed = store.markOutboxFailed(item.id, { error: 'boom', retryable: true, now: now() })
  const expected = new Date(clock.getTime() + OUTBOX_BACKOFF_MS[0]).toISOString()
  const early = store.claimOutbox({ owner: 'A', leaseMs: 1000, now: new Date(clock.getTime() + 500) })
  advance(2000)
  const retried = store.claimOutbox({ owner: 'A', leaseMs: 1000, now: now() })
  return failed.status === 'pending'
    && failed.attempts === 1
    && failed.nextRetryAt === expected
    && failed.lastError === 'boom'
    && early.length === 0
    && retried.length === 1
    && retried[0].attempts === 2
})

await check('a non-retryable failure is final', () => {
  const item = store.enqueueOutbox({ topic: 'say', payload: { text: 'permanent' }, now: now() })
  store.claimOutbox({ owner: 'A', leaseMs: 1000, now: now() })
  const failed = store.markOutboxFailed(item.id, { error: 'rejected', retryable: false, now: now() })
  const again = store.claimOutbox({ owner: 'A', leaseMs: 1000, now: now() })
  return failed.status === 'failed'
    && failed.nextRetryAt === null
    && failed.lastError === 'rejected'
    && again.length === 0
})

await check('a failed row can be requeued manually from a fresh state', () => {
  const failed = store.listOutbox({ status: 'failed' })[0]
  const requeued = store.requeueOutbox(failed.id)
  const claimedAgain = store.claimOutbox({ owner: 'A', leaseMs: 1000, now: now() })
  return requeued.status === 'pending'
    && requeued.attempts === 0
    && requeued.lastError === null
    && claimedAgain.some((item) => item.id === failed.id && item.attempts === 1)
})

// Fresh store so earlier rows (leases, retries) cannot leak into the ladder.
const retryStore = createGatewayStore(join(dir, 'retry.sqlite'))

await check('the retry ladder is 1s/5s/30s/2m/10m and exhausts after 6 attempts', () => {
  const item = retryStore.enqueueOutbox({ topic: 'say', payload: { text: 'ladder' }, now: now() })
  const delays = []
  for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
    const [current] = retryStore.claimOutbox({ owner: 'A', leaseMs: 1000, now: now() })
    if (current === undefined || current.id !== item.id) return false
    if (current.attempts !== attempt) return false
    const after = retryStore.markOutboxFailed(item.id, { error: `boom-${attempt}`, retryable: true, now: now() })
    if (attempt < OUTBOX_MAX_ATTEMPTS) {
      const delay = new Date(after.nextRetryAt).getTime() - clock.getTime()
      delays.push(delay)
      if (after.status !== 'pending') return false
      advance(delay)
    } else if (after.status !== 'failed' || after.nextRetryAt !== null) {
      return false
    }
  }
  const exhausted = retryStore.getOutbox(item.id)
  const claimAfter = retryStore.claimOutbox({ owner: 'A', leaseMs: 1000, now: now() })
  return JSON.stringify(delays) === JSON.stringify([...OUTBOX_BACKOFF_MS])
    && OUTBOX_MAX_ATTEMPTS === 6
    && exhausted.status === 'failed'
    && exhausted.attempts === 6
    && exhausted.lastError === 'boom-6'
    && claimAfter.length === 0
})

await check('an expired lease is reclaimable by another owner', () => {
  clock = new Date('2026-11-09T01:00:00.000Z')
  const item = retryStore.enqueueOutbox({ topic: 'say', payload: { text: 'lost lease' }, now: now() })
  const first = retryStore.claimOutbox({ owner: 'crashed', leaseMs: 1000, now: now() })
  advance(2000)
  const second = retryStore.claimOutbox({ owner: 'recovered', leaseMs: 1000, now: now() })
  return first.length === 1
    && second.length === 1
    && second[0].id === item.id
    && second[0].attempts === 2
    && second[0].leaseOwner === 'recovered'
})

const healthStore = createGatewayStore(join(dir, 'health.sqlite'))

await check('outboxHealth: windowed failures, backlog and oldest pending age (Slice Q)', () => {
  const t0 = new Date('2026-11-10T00:00:00.000Z')
  const oldFailure = healthStore.enqueueOutbox({ topic: 'say', payload: { text: 'old' }, now: t0 })
  healthStore.claimOutbox({ owner: 'H', leaseMs: 1000, now: t0 })
  healthStore.markOutboxFailed(oldFailure.id, { error: 'rejected', retryable: false, now: t0 })

  const t1 = new Date(t0.getTime() + 60_000)
  const retrying = healthStore.enqueueOutbox({ topic: 'say', payload: { text: 'retry' }, now: t1 })
  healthStore.claimOutbox({ owner: 'H', leaseMs: 1000, now: t1 })
  healthStore.markOutboxFailed(retrying.id, { error: 'boom', retryable: true, now: t1 })

  const t2 = new Date(t1.getTime() + 60_000)
  healthStore.enqueueOutbox({ topic: 'say', payload: { text: 'fresh' }, now: t2 })

  const at = new Date(t2.getTime() + 120_000)
  const windowed = healthStore.outboxHealth({ since: t1, now: at })
  const ever = healthStore.outboxHealth({ now: at })
  return windowed.failed === 0
    && ever.failed === 1
    && windowed.pending === 2
    && windowed.retrying === 1
    && windowed.oldestPendingAgeMs === at.getTime() - t1.getTime()
})

await check('outboxHealth: an empty outbox reports zeroes and no age', () => {
  const empty = createGatewayStore(join(dir, 'health-empty.sqlite'))
  const health = empty.outboxHealth()
  return health.failed === 0
    && health.pending === 0
    && health.retrying === 0
    && health.oldestPendingAgeMs === null
})

await check('ack / fail on a missing or already-sent row is refused', () => {
  assert.throws(
    () => store.markOutboxSent('missing', 'ext'),
    (error) => error instanceof GatewayError && error.code === 'not-found',
  )
  const sent = store.listOutbox({ status: 'sent' })[0]
  assert.throws(
    () => store.markOutboxFailed(sent.id, { error: 'late', retryable: true, now: now() }),
    (error) => error instanceof GatewayError && error.code === 'invalid-state',
  )
  return true
})

// ---- control commands: stop / pause / resume / status (11 §5.3) --------------

const controlCalls = []
const fakeControl = {
  control(input) {
    controlCalls.push(input)
    return {
      status: input.action === 'cancel'
        ? 'cancelled'
        : input.action === 'pause'
          ? 'paused'
          : 'running',
    }
  },
}

await check('stop on an anchored live task cancels it and records why', async () => {
  controlCalls.length = 0
  const result = await ingestInbound({ store: anchorStore, control: fakeControl }, {
    channelId: 'cli_anc',
    msgId: 'evt_ctl_stop',
    externalUserId: 'open_anc',
    kind: 'control',
    content: { control: 'stop' },
    chatId: 'chat_one',
  })
  return result.bypassReason === 'control'
    && result.control.executed === true
    && result.control.action === 'cancel'
    && result.control.status === 'cancelled'
    && result.control.skipped === null
    && result.target.taskId === 'task_one'
    && result.disposition.action === 'stop'
    && result.disposition.targetTaskId === 'task_one'
    && /executed \(cancel\)/.test(result.disposition.reason)
    && controlCalls.length === 1
    && controlCalls[0].taskId === 'task_one'
})

await check('a bare chat 停止 <ref> is a control frame, not a new task', async () => {
  controlCalls.length = 0
  const result = await ingestInbound({ store: anchorStore, control: fakeControl }, {
    channelId: 'cli_anc',
    msgId: 'evt_ctl_stop_text',
    externalUserId: 'open_anc',
    kind: 'message',
    content: { text: '停止 task_one' },
    chatId: 'chat_one',
  })
  const sentence = defaultTriage({
    channelId: 'cli_anc',
    msgId: 'evt_ctl_sentence',
    content: { text: '请停止这个任务' },
  })
  return result.bypassReason === 'control'
    && result.control.executed === true
    && result.control.action === 'cancel'
    && result.disposition.action === 'stop'
    && controlCalls.length === 1
    && controlCalls[0].taskId === 'task_one'
    && sentence === 'chat'
})

await check('pause and resume map onto the task runtime actions', async () => {
  controlCalls.length = 0
  const paused = await ingestInbound({ store: anchorStore, control: fakeControl }, {
    channelId: 'cli_anc',
    msgId: 'evt_ctl_pause',
    externalUserId: 'open_anc',
    kind: 'control',
    content: { control: 'pause' },
    chatId: 'chat_one',
  })
  const resumed = await ingestInbound({ store: anchorStore, control: fakeControl }, {
    channelId: 'cli_anc',
    msgId: 'evt_ctl_resume',
    externalUserId: 'open_anc',
    kind: 'control',
    content: { control: 'resume' },
    chatId: 'chat_one',
  })
  return paused.control.action === 'pause'
    && paused.control.status === 'paused'
    && resumed.control.action === 'resume'
    && controlCalls.map((call) => call.action).join(',') === 'pause,resume'
})

await check('status only reports and never touches the task runtime', async () => {
  controlCalls.length = 0
  const result = await ingestInbound({ store: anchorStore, control: fakeControl }, {
    channelId: 'cli_anc',
    msgId: 'evt_ctl_status',
    externalUserId: 'open_anc',
    kind: 'control',
    content: { control: 'status' },
    chatId: 'chat_one',
  })
  return result.control.executed === false
    && result.control.skipped === 'status-only'
    && result.control.action === null
    && controlCalls.length === 0
    && result.target.command === 'status'
})

await check('a command aimed at a finished task is not executed', async () => {
  controlCalls.length = 0
  const result = await ingestInbound({ store: anchorStore, control: fakeControl }, {
    channelId: 'cli_anc',
    msgId: 'evt_ctl_dead',
    externalUserId: 'open_anc',
    kind: 'control',
    content: { control: 'pause' },
    chatId: 'chat_three',
  })
  return result.control.executed === false
    && result.control.skipped === 'not-live'
    && controlCalls.length === 0
    && result.target.taskId === 'task_three'
})

await check('without a control port nothing is executed but the reason is kept', async () => {
  const result = await ingestInbound({ store: anchorStore }, {
    channelId: 'cli_anc',
    msgId: 'evt_ctl_noport',
    externalUserId: 'open_anc',
    kind: 'control',
    content: { control: 'stop' },
    chatId: 'chat_one',
  })
  return result.control.executed === false
    && result.control.skipped === 'no-port'
    && /no-port/.test(result.disposition.reason)
    && result.inbox.status === 'triaged'
})

await check('a control command in a chat with no task is acknowledged with the reason', async () => {
  const result = await ingestInbound({ store: anchorStore, control: fakeControl }, {
    channelId: 'cli_anc',
    msgId: 'evt_ctl_notask',
    externalUserId: 'open_anc',
    kind: 'control',
    content: { control: 'stop' },
    chatId: 'chat_notask',
  })
  return result.control === null
    && result.target.taskId === undefined
    && /no anchored task/.test(result.disposition.reason)
    && result.inbox.status === 'triaged'
})

await check('a failing control port marks the inbox failed instead of faking success', async () => {
  const brokenControl = {
    control() {
      throw new Error('tasks store unavailable')
    },
  }
  const result = await ingestInbound({ store: anchorStore, control: brokenControl }, {
    channelId: 'cli_anc',
    msgId: 'evt_ctl_broken',
    externalUserId: 'open_anc',
    kind: 'control',
    content: { control: 'stop' },
    chatId: 'chat_one',
  })
  return result.error === 'control-unavailable'
    && result.control === null
    && result.inbox.status === 'failed'
    && result.inbox.errorCode === 'control-unavailable'
    && result.disposition.targetTaskId === 'task_one'
})

// ---- project resolution: one window, many projects (11 §5.3.1) ---------------
//
//片 3 宿主装配：真实 ⑥ store + 真实 createProjectLookupPort，端到端喂给 ① 的
// deps.project（AR33 结构契约，① 不 import ⑥；AR32 端口形状匹配即可）。
// anchorPath 上已有 gateway schema（PK(module)='gateway'），memory store 用同一
// schema_migrations 的不同 module 值（'memory'）——CREATE TABLE IF NOT EXISTS 复用
// 原表、不重建 PK，安全。

const memoryStore = createMemoryStore(anchorPath)
const memoryDb = new DatabaseConstructor(anchorPath)
// 与 fixtures 的 task.project_id 一致的项目，nameOf 能查到真实名字。
memoryDb.prepare(`
  INSERT OR REPLACE INTO projects(id, name, root_path, created_at, archived_at)
  VALUES (?, ?, ?, '2026-11-09T00:00:00.000Z', NULL)
`).run('proj_alpha', 'alpha', '/tmp/alpha')
memoryDb.prepare(`
  INSERT OR REPLACE INTO projects(id, name, root_path, created_at, archived_at)
  VALUES (?, ?, ?, '2026-11-09T00:00:00.000Z', NULL)
`).run('proj_beta', 'beta', '/tmp/beta')
memoryDb.prepare(`
  INSERT OR REPLACE INTO project_aliases(alias, project_id, created_at)
  VALUES ('a', 'proj_alpha', '2026-11-09T00:00:00.000Z')
`).run()
memoryDb.close()

const projectPort = createProjectLookupPort(memoryStore)

const projChat = 'chat_proj'
anchorStore.resolveThread({ channelId: 'cli_anc', chatId: projChat })
anchorStore.setSessionRoute({
  channelId: 'cli_anc',
  chatId: projChat,
  sessionKind: 'orchestrator',
  sessionId: 'sess_proj',
  projectId: null,
})

await check('/use <alias> resolves the project and moves the chat stickiness', async () => {
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_use',
    externalUserId: 'open_anc',
    content: { text: '/use alpha' },
    chatId: projChat,
  })
  const route = anchorStore.getSessionRoute('cli_anc', projChat, 'orchestrator')
  return result.bypassReason === 'project'
    && result.intent === 'command'
    && result.target.kind === 'project'
    && result.target.command === 'use'
    && result.project.projectId === 'proj_alpha'
    && result.project.matchedBy === 'explicit'
    && result.disposition.action === 'ack'
    && result.disposition.projectId === 'proj_alpha'
    && result.disposition.projectMatchedBy === 'explicit'
    && route.projectId === 'proj_alpha'
    && result.inbox.status === 'triaged'
})

await check('the next plain message sticks to the project chosen last', async () => {
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_sticky',
    externalUserId: 'open_anc',
    content: { text: '看下磁盘' },
    chatId: projChat,
  })
  // The orchestrator path leaves the disposition to the orchestrator itself.
  return result.bypassReason === null
    && result.target.kind === 'orchestrator'
    && result.project.projectId === 'proj_alpha'
    && result.project.matchedBy === 'sticky'
    && result.project.name === 'alpha'
    && result.inbox.status === 'routed'
})

await check('a reply anchor beats the chat stickiness', async () => {
  anchorStore.setSessionRoute({
    channelId: 'cli_anc',
    chatId: 'chat_two',
    sessionKind: 'orchestrator',
    sessionId: 'sess_two',
    projectId: 'proj_alpha',
  })
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_anchor',
    externalUserId: 'open_anc',
    content: { text: '这条给 beta' },
    chatId: 'chat_two',
    replyToMsgId: 'm_two_b',
  })
  return result.project.projectId === 'proj_beta'
    && result.project.matchedBy === 'anchor'
    && result.target.kind === 'task'
    && result.target.taskId === 'task_two_b'
    && result.disposition.projectId === 'proj_beta'
})

await check('two projects and no signal asks instead of guessing', async () => {
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_ask',
    externalUserId: 'open_anc',
    content: { text: '看下日志' },
    chatId: 'chat_fresh',
  })
  return result.bypassReason === 'ambiguous-project'
    && result.project.ambiguous === true
    && result.project.projectId === null
    && result.target.kind === 'project'
    && result.target.candidates.length === 2
    && result.disposition.action === 'ask'
    && result.inbox.status === 'triaged'
})

await check('an unknown /use alias asks with the choices and leaves stickiness alone', async () => {
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_unknown',
    externalUserId: 'open_anc',
    content: { text: '/use zzz' },
    chatId: 'chat_fresh',
  })
  return result.bypassReason === 'project'
    && result.project.projectId === null
    && result.project.matchedBy === 'asked'
    && result.project.candidates.length === 2
    && result.disposition.action === 'ask'
    && result.target.command === 'use'
    && anchorStore.getSessionRoute('cli_anc', 'chat_fresh', 'orchestrator') === null
})

await check('/projects lists the choices without switching', async () => {
  const before = anchorStore.getSessionRoute('cli_anc', projChat, 'orchestrator').projectId
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_list',
    externalUserId: 'open_anc',
    content: { text: '/projects' },
    chatId: projChat,
  })
  const after = anchorStore.getSessionRoute('cli_anc', projChat, 'orchestrator').projectId
  return result.bypassReason === 'project'
    && result.target.kind === 'project'
    && result.target.command === 'list'
    && result.project.candidates.length === 2
    && result.project.projectId === null
    && before === 'proj_alpha'
    && after === 'proj_alpha'
})

await check('without a project port a plain turn stays project-agnostic', async () => {
  const result = await ingestInbound({ store: anchorStore }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_noport',
    externalUserId: 'open_anc',
    content: { text: '看下内存' },
    chatId: 'chat_fresh2',
  })
  return result.bypassReason === null
    && result.target.kind === 'orchestrator'
    && result.project.available === false
    && result.project.projectId === null
    && result.project.ambiguous === false
})

// ---- project resolution E2E: real ⑥ paths fake port cannot cover ------------

await check('真实 alias 优先匹配（resolveAlias 先 alias 再 name）', async () => {
  // setSessionProject 只 UPDATE 不 INSERT；必须先有一条 session_routes 行（同 fixture 里 projChat 的做法）
  anchorStore.setSessionRoute({ channelId: 'cli_anc', chatId: 'chat_alias', sessionKind: 'orchestrator', sessionId: 'sess_alias', projectId: null })
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_alias',
    externalUserId: 'open_anc',
    content: { text: '/use a' },
    chatId: 'chat_alias',
  })
  const route = anchorStore.getSessionRoute('cli_anc', 'chat_alias', 'orchestrator')
  return result.project.projectId === 'proj_alpha'
    && result.project.matchedBy === 'explicit'
    && result.project.name === 'alpha'
    && route !== null
    && route.projectId === 'proj_alpha'
})

await check('锚点继承真实 project_id + nameOf 查真实 ⑥ 名字', async () => {
  // anchorStore fixture 里 task_two_b.project_id = 'proj_beta'
  // 真实 ⑥ store 里 proj_beta.name = 'beta'
  // → reply anchor 命中 task_two_b → project 继承 beta + nameOf 查到 'beta'
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_anchor_real',
    externalUserId: 'open_anc',
    content: { text: '这条还是给 beta 吧' },
    chatId: 'chat_two',
    replyToMsgId: 'm_two_b',
  })
  return result.project.projectId === 'proj_beta'
    && result.project.matchedBy === 'anchor'
    && result.project.name === 'beta'
    && result.target.kind === 'task'
    && result.target.taskId === 'task_two_b'
})

await check('只剩一个未归档项目时 matchedBy = single', async () => {
  const memDb = new DatabaseConstructor(anchorPath)
  memDb.prepare("UPDATE projects SET archived_at = '2026-11-10T00:00:00.000Z' WHERE id = 'proj_beta'").run()
  memDb.close()
  // chat_alone 上先清掉可能的 stickiness（设 null），这样 resolveProject 不会 sticky 命中
  anchorStore.setSessionRoute({ channelId: 'cli_anc', chatId: 'chat_alone', sessionKind: 'orchestrator', sessionId: 'sess_alone', projectId: null })
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_single',
    externalUserId: 'open_anc',
    content: { text: '看下日志' },
    chatId: 'chat_alone',
  })
  const restoreDb = new DatabaseConstructor(anchorPath)
  restoreDb.prepare("UPDATE projects SET archived_at = NULL WHERE id = 'proj_beta'").run()
  restoreDb.close()
  return result.project.projectId === 'proj_alpha'
    && result.project.matchedBy === 'single'
    && result.project.name === 'alpha'
})

await check('已归档项目的 alias / name 都不再命中', async () => {
  // archive alpha 后只 beta 有效。用自然语言消息（不是显式命令）→ 走 single 分支
  // （显式 `/use a` 在 find=null 时走 ask 是预期行为）
  const memDb = new DatabaseConstructor(anchorPath)
  memDb.prepare("UPDATE projects SET archived_at = '2026-11-10T00:00:00.000Z' WHERE id = 'proj_alpha'").run()
  memDb.close()
  anchorStore.setSessionRoute({ channelId: 'cli_anc', chatId: 'chat_archived', sessionKind: 'orchestrator', sessionId: 'sess_archived', projectId: null })
  const result = await ingestInbound({ store: anchorStore, project: projectPort }, {
    channelId: 'cli_anc',
    msgId: 'evt_proj_archived',
    externalUserId: 'open_anc',
    content: { text: '看下日志' },
    chatId: 'chat_archived',
  })
  const restoreDb = new DatabaseConstructor(anchorPath)
  restoreDb.prepare("UPDATE projects SET archived_at = NULL WHERE id = 'proj_alpha'").run()
  restoreDb.close()
  return result.project.projectId === 'proj_beta'
    && result.project.matchedBy === 'single'
})

await check('projectMemoryContext：按项目装配上下文返回 global + 本项目 facts + fingerprint', async () => {
  // ⑥ 的 upsertProject / insertFact 都是模块内部 API，用 raw SQL 往 tables 插 fixture：
  const fix = new DatabaseConstructor(anchorPath)
  const machineFact = fix.prepare(`
    INSERT INTO memory_facts(id, scope, subject, predicate, value_json, source, kind,
      evidence_json, confidence, valid_from, created_at)
    VALUES (?, 'global', ?, ?, ?, 'observed', 'environment',
      ?, NULL, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
  `)
  machineFact.run('f_global_machine', 'machine', 'has', JSON.stringify({ os: 'linux' }),
    JSON.stringify({ probe: 'path /proc' }))
  const prefFact = fix.prepare(`
    INSERT INTO memory_facts(id, scope, project_id, subject, predicate, value_json, source, kind,
      valid_from, created_at)
    VALUES (?, 'project', 'proj_alpha', ?, ?, ?, 'user-confirmed', 'preference',
      '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
  `)
  prefFact.run('f_alpha_preference', 'project:proj_alpha', 'root', JSON.stringify({ path: '/tmp/alpha' }))
  fix.close()

  const globalCtx = projectMemoryContext(memoryStore, {})
  const betaCtx = projectMemoryContext(memoryStore, { projectId: 'proj_beta' })
  const alphaCtx = projectMemoryContext(memoryStore, { projectId: 'proj_alpha' })

  let archivedRefused = false
  try {
    const tDb = new DatabaseConstructor(anchorPath)
    tDb.prepare("UPDATE projects SET archived_at = '2026-11-10T00:00:00.000Z' WHERE id = 'proj_alpha'").run()
    tDb.close()
    projectMemoryContext(memoryStore, { projectId: 'proj_alpha' })
  } catch (_error) {
    archivedRefused = true
  } finally {
    const rDb = new DatabaseConstructor(anchorPath)
    rDb.prepare("UPDATE projects SET archived_at = NULL WHERE id = 'proj_alpha'").run()
    rDb.close()
  }

  // 清理：DELETE 而不是 superseded（superseded 要更复杂的 id 链）
  const sweepDb = new DatabaseConstructor(anchorPath)
  sweepDb.prepare("DELETE FROM memory_facts WHERE id IN ('f_global_machine','f_alpha_preference')").run()
  sweepDb.close()

  const globalCount = globalCtx.facts.length
  return globalCtx.projectId === null
    && globalCtx.project === null
    && globalCount >= 1
    && typeof globalCtx.fingerprint === 'string'
    && globalCtx.fingerprint.length === 16
    && betaCtx.projectId === 'proj_beta'
    && betaCtx.project !== null
    && betaCtx.project.name === 'beta'
    && betaCtx.facts.length === globalCount
    && alphaCtx.projectId === 'proj_alpha'
    && alphaCtx.project !== null
    && alphaCtx.project.name === 'alpha'
    && alphaCtx.facts.length === globalCount + 1
    && archivedRefused === true
})

// ---- dispatcher --------------------------------------------------------------

const dispatcherPath = join(dir, 'dispatcher.sqlite')
const dispatcherStore = createGatewayStore(dispatcherPath)
let dclock = new Date('2026-11-10T00:00:00.000Z')
const dnow = () => new Date(dclock)

function fakeTransport(handler) {
  const transport = {
    transport: 'fake',
    calls: 0,
    deliveries: [],
    async send(delivery) {
      transport.calls += 1
      transport.deliveries.push(delivery)
      return handler(delivery, transport)
    },
  }
  return transport
}

await check('the dispatcher delivers a row and records the transport message id', async () => {
  const item = dispatcherStore.enqueueOutbox({
    topic: 'say',
    payload: { text: 'hi' },
    threadId: 'thr_x',
    replyToMsgId: 'm1',
    taskId: 'task_x',
    now: dnow(),
  })
  const transport = fakeTransport((delivery) => ({ externalMsgId: `ext-${delivery.id}` }))
  const dispatcher = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'D', now: dnow })
  const report = await dispatcher.runOnce()
  const sent = dispatcherStore.getOutbox(item.id)
  const delivery = transport.deliveries[0]
  return report.claimed === 1
    && report.sent === 1
    && report.retried === 0
    && sent.status === 'sent'
    && sent.externalMsgId === `ext-${item.id}`
    && delivery.payload.text === 'hi'
    && delivery.threadId === 'thr_x'
    && delivery.replyToMsgId === 'm1'
    && delivery.taskId === 'task_x'
    && delivery.attempts === 1
})

await check('outbound payloads are redacted at the outbox choke point (19 A5)', async () => {
  // 运行时拼接，避免源码里出现完整 AWS 示例 key 被 secret scanning 拦下。
  const secret = 'AKIA' + 'IOSFODNN7EXAMPLE'
  const item = dispatcherStore.enqueueOutbox({
    topic: 'say',
    payload: { text: `key=${secret}`, nested: { token: 'password = "hunter2hunter2"' } },
    now: dnow(),
  })
  const raw = new DatabaseConstructor(dispatcherPath, { readonly: true })
  const stored = raw
    .prepare('SELECT payload_json FROM outbox WHERE id = ?')
    .get(item.id)
  raw.close()
  const transport = fakeTransport(() => ({ externalMsgId: 'ext-redacted' }))
  const dispatcher = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'D', now: dnow })
  await dispatcher.runOnce()
  const delivered = transport.deliveries.find((entry) => entry.payload.text.includes('key='))
  return !JSON.stringify(item.payload).includes(secret)
    && item.payload.text.includes('[redacted:')
    && !stored.payload_json.includes(secret)
    && !stored.payload_json.includes('hunter2hunter2')
    && delivered !== undefined
    && !JSON.stringify(delivered.payload).includes(secret)
})

await check('a transport answer without external_msg_id is a retried failure', async () => {
  const item = dispatcherStore.enqueueOutbox({ topic: 'say', payload: { text: 'no ack' }, now: dnow() })
  const transport = fakeTransport(() => ({}))
  const dispatcher = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'D', now: dnow })
  const report = await dispatcher.runOnce()
  const row = dispatcherStore.getOutbox(item.id)
  return report.claimed === 1
    && report.retried === 1
    && report.sent === 0
    && row.status === 'pending'
    && /external_msg_id/.test(row.lastError)
})

await check('a rejected TransportError fails the row immediately', async () => {
  const item = dispatcherStore.enqueueOutbox({ topic: 'say', payload: { text: 'rejected' }, now: dnow() })
  const transport = fakeTransport(() => {
    throw new TransportError('rejected', 'bot not in chat')
  })
  const dispatcher = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'D', now: dnow })
  const report = await dispatcher.runOnce()
  const row = dispatcherStore.getOutbox(item.id)
  return report.failed === 1
    && row.status === 'failed'
    && row.lastError === 'bot not in chat'
})

await check('a structural TransportError from another module is honoured (AR32/AR33)', async () => {
  const item = dispatcherStore.enqueueOutbox({ topic: 'say', payload: { text: 'foreign' }, now: dnow() })
  const transport = fakeTransport(() => {
    // A channel plugin cannot import TransportError; it throws the same shape.
    const error = new Error('permanent rejection')
    error.name = 'TransportError'
    error.code = 'rejected'
    error.retryable = false
    throw error
  })
  const dispatcher = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'D', now: dnow })
  const report = await dispatcher.runOnce()
  const row = dispatcherStore.getOutbox(item.id)
  return report.failed === 1
    && row.status === 'failed'
    && row.attempts === 1
    && row.lastError === 'permanent rejection'
})


await check('an unknown transport error is treated as transient', async () => {
  const item = dispatcherStore.enqueueOutbox({ topic: 'say', payload: { text: 'unknown' }, now: dnow() })
  const transport = fakeTransport(() => {
    throw new Error('socket hang up')
  })
  const dispatcher = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'D', now: dnow })
  const report = await dispatcher.runOnce()
  const row = dispatcherStore.getOutbox(item.id)
  return report.retried === 1
    && row.status === 'pending'
    && row.lastError === 'socket hang up'
})

// Drain the rows left pending above so the next checks see only their own row.
for (const row of dispatcherStore.listOutbox({ status: 'pending' })) {
  dispatcherStore.markOutboxFailed(row.id, { error: 'test cleanup', retryable: false, now: dnow() })
}

await check('dispatcher logs retries as warn and give-ups as error (Slice Q)', async () => {
  dclock = new Date('2026-11-10T05:00:00.000Z')
  const logs = []
  const logger = {
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  }
  const retryItem = dispatcherStore.enqueueOutbox({
    topic: 'say',
    payload: { text: 'secret-body-xyz' },
    now: dnow(),
  })
  const retrying = createOutboxDispatcher({
    store: dispatcherStore,
    transport: fakeTransport(() => {
      throw new Error('socket hang up')
    }),
    owner: 'L',
    now: dnow,
    logger,
  })
  await retrying.runOnce()

  const failedItem = dispatcherStore.enqueueOutbox({
    topic: 'say',
    payload: { text: 'secret-body-xyz' },
    now: dnow(),
  })
  const givingUp = createOutboxDispatcher({
    store: dispatcherStore,
    transport: fakeTransport(() => {
      throw new TransportError('rejected', 'bot not in chat')
    }),
    owner: 'L',
    now: dnow,
    logger,
  })
  await givingUp.runOnce()

  return logs.length === 2
    && logs[0][0] === 'warn'
    && logs[0][1].includes(retryItem.id)
    && /outbox retry 1\/6/.test(logs[0][1])
    && logs[1][0] === 'error'
    && logs[1][1].includes(failedItem.id)
    && /outbox failed after 1 attempt/.test(logs[1][1])
    && !JSON.stringify(logs).includes('secret-body-xyz')
})

await check('two dispatchers never deliver the same row', async () => {
  dclock = new Date('2026-11-10T02:00:00.000Z')
  const item = dispatcherStore.enqueueOutbox({ topic: 'say', payload: { text: 'once' }, now: dnow() })
  const transport = fakeTransport(async (delivery) => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { externalMsgId: `ext-${delivery.id}` }
  })
  const first = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'D1', now: dnow })
  const second = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'D2', now: dnow })
  const [a, b] = await Promise.all([first.runOnce(), second.runOnce()])
  return transport.calls === 1
    && a.claimed + b.claimed === 1
    && a.sent + b.sent === 1
    && dispatcherStore.getOutbox(item.id).status === 'sent'
})

await check('a dispatcher recovers a row whose lease expired', async () => {
  dclock = new Date('2026-11-10T03:00:00.000Z')
  const item = dispatcherStore.enqueueOutbox({ topic: 'say', payload: { text: 'recover' }, now: dnow() })
  dispatcherStore.claimOutbox({ owner: 'crashed', leaseMs: 1000, now: dnow() })
  dclock = new Date(dclock.getTime() + 5000)
  const transport = fakeTransport((delivery) => ({ externalMsgId: `ext-${delivery.id}` }))
  const dispatcher = createOutboxDispatcher({ store: dispatcherStore, transport, owner: 'recovered', now: dnow })
  const report = await dispatcher.runOnce()
  const row = dispatcherStore.getOutbox(item.id)
  return report.sent === 1
    && row.status === 'sent'
    && row.attempts === 2
})

await check('the attempt ceiling also covers crashed attempts (no silent loop)', () => {
  dclock = new Date('2026-11-10T04:00:00.000Z')
  const item = dispatcherStore.enqueueOutbox({ topic: 'say', payload: { text: 'crash loop' }, now: dnow() })
  for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
    const claimedNow = dispatcherStore.claimOutbox({ owner: `crash-${attempt}`, leaseMs: 1000, now: dnow() })
    if (claimedNow.length !== 1 || claimedNow[0].id !== item.id) return false
    dclock = new Date(dclock.getTime() + 2000)
  }
  const seventh = dispatcherStore.claimOutbox({ owner: 'next', leaseMs: 1000, now: dnow() })
  const row = dispatcherStore.getOutbox(item.id)
  return seventh.length === 0
    && row.status === 'failed'
    && row.lastError === 'attempts exhausted'
})

// ---- receipt closure: ⑤ receipt → outbox → channel → ⑤ settled --------------

const receiptPath = join(dir, 'receipt.sqlite')
const receiptStore = createGatewayStore(receiptPath)
const receiptThread = receiptStore.resolveThread({
  channelId: 'feishu',
  chatId: 'chat_r',
  rootMsgId: 'root_r',
})
const pendingReceipts = [
  {
    id: 'rc1',
    taskId: 'task_rc',
    round: 2,
    summary: '部署完成，健康检查通过',
    evidenceLocator: 'run:42',
    threadId: receiptThread.id,
    createdAt: '2026-11-10T00:00:00.000Z',
  },
  {
    id: 'rc2',
    taskId: 'task_web',
    round: 1,
    summary: '只在 Web 里完成的任务',
    evidenceLocator: null,
    threadId: null,
    createdAt: '2026-11-10T00:01:00.000Z',
  },
]
const settled = []
const receiptPort = {
  pendingReceipts(limit) {
    return pendingReceipts.slice(0, limit ?? 50)
  },
  markReceiptDelivered(id, externalMsgId) {
    settled.push({ id, externalMsgId })
    return {}
  },
}
const receiptRelay = createReceiptRelay({ store: receiptStore, receipts: receiptPort })

await check('the receipt relay enqueues one row per deliverable receipt', () => {
  const report = receiptRelay.pump()
  const rows = receiptStore.listOutbox({ status: 'pending' })
  return report.scanned === 2
    && report.enqueued === 1
    && report.skippedNoThread === 1
    && rows.length === 1
    && rows[0].topic === 'task.receipt'
    && rows[0].taskId === 'task_rc'
    && rows[0].threadId === receiptThread.id
    && rows[0].payload.receiptId === 'rc1'
    && rows[0].payload.round === 2
    && rows[0].payload.summary === '部署完成，健康检查通过'
})

await check('a repeated pump is deduplicated by receipt id', () => {
  const report = receiptRelay.pump()
  const db = new DatabaseConstructor(receiptPath, { readonly: true })
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key = 'task-receipt:rc1'")
    .get()
  db.close()
  return report.enqueued === 1
    && count.count === 1
    && receiptStore.listOutbox().filter((row) => row.topic === 'task.receipt').length === 1
})

await check('receiptIdOf only claims its own topic', () => {
  return receiptRelay.receiptIdOf({ topic: 'task.receipt', payload: { receiptId: 'rc1' } }) === 'rc1'
    && receiptRelay.receiptIdOf({ topic: 'say', payload: { receiptId: 'rc1' } }) === null
    && receiptRelay.receiptIdOf({ topic: 'task.receipt', payload: { text: 'no id' } }) === null
})

// ---- Slice AS: over-long receipts spill to a file attachment (A4) -----------

const spillDir = mkdtempSync(join(tmpdir(), 'spill-'))
const spillPath = join(dir, 'spill.sqlite')
const spillStore = createGatewayStore(spillPath)
const spillThread = spillStore.resolveThread({
  channelId: 'feishu',
  chatId: 'chat_s',
  rootMsgId: 'root_s',
})
const longSummary = `${'日志行 '.repeat(220)}结束`
const shortSummary = '一句话回执'
const spillReceipts = [
  { id: 'rc_long', taskId: 't_long', round: 1, summary: longSummary, evidenceLocator: null, threadId: spillThread.id, createdAt: '2026-11-18T00:00:00.000Z' },
  { id: 'rc_short', taskId: 't_short', round: 1, summary: shortSummary, evidenceLocator: null, threadId: spillThread.id, createdAt: '2026-11-18T00:00:01.000Z' },
]
const spillCalls = []
const spillPort = {
  pendingReceipts(limit) {
    return spillReceipts.slice(0, limit ?? 50)
  },
  markReceiptDelivered() {
    return {}
  },
}
const spillRelay = createReceiptRelay({
  store: spillStore,
  receipts: spillPort,
  spill: {
    write({ name, content }) {
      spillCalls.push({ name, content })
      const path = join(spillDir, name)
      writeFileSync(path, content)
      return { path, name }
    },
  },
  spillThresholdChars: 600,
})

await check('AS 1: a receipt over the threshold becomes a file payload; short ones stay text', () => {
  spillRelay.pump()
  const rows = spillStore.listOutbox()
  const long = rows.find((row) => row.payload.receiptId === 'rc_long')
  const short = rows.find((row) => row.payload.receiptId === 'rc_short')
  return spillCalls.length === 1
    && spillCalls[0].name === 'receipt-rc_long.md'
    && spillCalls[0].content === longSummary
    && existsSync(join(spillDir, spillCalls[0].name))
    && long.payload.kind === 'file'
    && long.payload.filePath === join(spillDir, 'receipt-rc_long.md')
    && long.payload.summary === longSummary
    && long.payload.text.includes('完整回执')
    && long.payload.text.includes('见附件 receipt-rc_long.md')
    && spillStore.findOutboxByDedupe('task-receipt:rc_long')?.id === long.id
    && short.payload.kind === undefined
    && short.payload.text === undefined
    && spillRelay.receiptIdOf({ topic: 'task.receipt', payload: long.payload }) === 'rc_long'
})

await check('AS 2: a spill failure or a zero threshold degrades to inline text (no lost receipt)', () => {
  const pathA = join(dir, 'spill-fail.sqlite')
  const storeA = createGatewayStore(pathA)
  const threadA = storeA.resolveThread({ channelId: 'feishu', chatId: 'c', rootMsgId: 'r' })
  const one = {
    pendingReceipts: () => [{
      id: 'rc_x', taskId: 't', round: 1, summary: longSummary,
      evidenceLocator: null, threadId: threadA.id, createdAt: '2026-11-18T00:00:00.000Z',
    }],
    markReceiptDelivered: () => ({}),
  }
  const throwing = createReceiptRelay({
    store: storeA,
    receipts: one,
    spill: { write() { throw new Error('disk full') } },
    spillThresholdChars: 10,
  })
  throwing.pump()
  const fellBack = storeA.listOutbox()[0]

  const pathB = join(dir, 'spill-off.sqlite')
  const storeB = createGatewayStore(pathB)
  const threadB = storeB.resolveThread({ channelId: 'feishu', chatId: 'c', rootMsgId: 'r' })
  const off = createReceiptRelay({
    store: storeB,
    receipts: {
      pendingReceipts: () => [{
        id: 'rc_y', taskId: 't', round: 1, summary: longSummary,
        evidenceLocator: null, threadId: threadB.id, createdAt: '2026-11-18T00:00:00.000Z',
      }],
      markReceiptDelivered: () => ({}),
    },
    spill: { write: () => ({ path: '/never', name: 'never.md' }) },
    spillThresholdChars: 0,
  })
  off.pump()
  const disabled = storeB.listOutbox()[0]
  storeA.close()
  storeB.close()
  return fellBack.payload.kind === undefined
    && fellBack.payload.summary === longSummary
    && disabled.payload.kind === undefined
    && disabled.payload.summary === longSummary
})

await check('the dispatcher settles the receipt with the channel message id', async () => {
  const transport = fakeTransport((delivery) => ({ externalMsgId: `ext-${delivery.id}` }))
  const dispatcher = createOutboxDispatcher({
    store: receiptStore,
    transport,
    owner: 'R',
    now: dnow,
    onSent: (item, externalMsgId) => {
      const receiptId = receiptRelay.receiptIdOf(item)
      if (receiptId !== null) receiptRelay.settle(receiptId, externalMsgId)
    },
  })
  const report = await dispatcher.runOnce()
  const sent = receiptStore.listOutbox({ status: 'sent' })
  return report.sent === 1
    && report.settleFailed === 0
    && settled.length === 1
    && settled[0].id === 'rc1'
    && settled[0].externalMsgId === `ext-${sent[0].id}`
})

await check('a throwing settle hook never turns a delivered row into a retry', async () => {
  const item = receiptStore.enqueueOutbox({ topic: 'say', payload: { text: 'hook boom' }, now: dnow() })
  const transport = fakeTransport((delivery) => ({ externalMsgId: `ext-${delivery.id}` }))
  const dispatcher = createOutboxDispatcher({
    store: receiptStore,
    transport,
    owner: 'R',
    now: dnow,
    onSent: () => {
      throw new Error('tasks store unavailable')
    },
  })
  const report = await dispatcher.runOnce()
  return report.sent === 1
    && report.settleFailed === 1
    && receiptStore.getOutbox(item.id).status === 'sent'
})

// ---- task progress: time-based long-task notices (Slice R) ------------------

const progressPath = join(dir, 'progress.sqlite')
const progressStore = createGatewayStore(progressPath)
const progressThread = progressStore.resolveThread({
  channelId: 'feishu',
  chatId: 'chat_progress',
  rootMsgId: 'root_progress',
})
let progressClock = new Date('2026-11-12T00:00:00.000Z')
const progressNow = () => new Date(progressClock)
let runningTasks = []
const progressPort = {
  listRunningTasks(limit) {
    return runningTasks.slice(0, limit ?? 50)
  },
}
const progressRelay = createTaskProgressRelay({
  store: progressStore,
  tasks: progressPort,
  now: progressNow,
  milestonesMs: [120_000, 600_000],
  stallMs: 900_000,
})
const progressSnapshot = (overrides = {}) => ({
  taskId: 'task_progress',
  taskRef: 'ref-progress',
  intent: '部署演示服务并验证健康检查',
  startedAt: '2026-11-12T00:00:00.000Z',
  lastEventAt: '2026-11-12T00:00:00.000Z',
  lastEventSeq: 1,
  lastEventType: 'task.started',
  threadIds: [progressThread.id],
  ...overrides,
})

await check('each milestone enqueues exactly one task.progress row', () => {
  runningTasks = [progressSnapshot()]
  progressClock = new Date('2026-11-12T00:02:00.000Z')
  const first = progressRelay.pump()
  const second = progressRelay.pump()
  progressClock = new Date('2026-11-12T00:10:00.000Z')
  const third = progressRelay.pump()
  const rows = progressStore.listOutbox().filter((row) => row.topic === 'task.progress')
  return first.enqueued === 1
    && first.skippedDuplicate === 0
    && second.enqueued === 0
    && second.skippedDuplicate === 1
    && third.enqueued === 1
    && rows.length === 2
    && progressStore.findOutboxByDedupe('task-progress:task_progress:120000') !== null
    && progressStore.findOutboxByDedupe('task-progress:task_progress:600000') !== null
    && rows.every((row) => row.threadId === progressThread.id && row.payload.taskRef === 'ref-progress')
    && rows.some((row) => row.payload.milestoneMs === 120_000 && /2 分钟/.test(row.payload.text))
})

await check('a restart past both milestones sends only the highest one', () => {
  const path = join(dir, 'progress-restart.sqlite')
  const restartStore = createGatewayStore(path)
  const thread = restartStore.resolveThread({ channelId: 'feishu', chatId: 'c2', rootMsgId: 'r2' })
  progressClock = new Date('2026-11-12T00:20:00.000Z')
  const relay = createTaskProgressRelay({
    store: restartStore,
    tasks: { listRunningTasks: () => [progressSnapshot({ threadIds: [thread.id] })] },
    now: progressNow,
    milestonesMs: [120_000, 600_000],
    stallMs: 900_000,
  })
  relay.pump()
  const rows = restartStore.listOutbox().filter((row) => row.topic === 'task.progress')
  const result = rows.length === 2
    && restartStore.findOutboxByDedupe('task-progress:task_progress:120000') === null
    && restartStore.findOutboxByDedupe('task-progress:task_progress:600000') !== null
  restartStore.close()
  return result
})

await check('a silent task gets one stall notice per event sequence', () => {
  const path = join(dir, 'progress-stall.sqlite')
  const stallStore = createGatewayStore(path)
  const thread = stallStore.resolveThread({ channelId: 'feishu', chatId: 'c3', rootMsgId: 'r3' })
  const state = { seq: 5, lastEventAt: '2026-11-12T00:00:00.000Z' }
  const relay = createTaskProgressRelay({
    store: stallStore,
    tasks: {
      listRunningTasks: () => [progressSnapshot({
        threadIds: [thread.id],
        lastEventSeq: state.seq,
        lastEventAt: state.lastEventAt,
        lastEventType: 'task.checkpoint',
      })],
    },
    now: progressNow,
    milestonesMs: [120_000, 600_000],
    stallMs: 900_000,
  })
  progressClock = new Date('2026-11-12T00:16:00.000Z')
  const first = relay.pump()
  const again = relay.pump()
  state.seq = 6
  state.lastEventAt = '2026-11-12T00:20:00.000Z'
  progressClock = new Date('2026-11-12T00:36:00.000Z')
  const afterEvent = relay.pump()
  const rows = stallStore.listOutbox().filter((row) => row.topic === 'task.progress' && row.payload.stall === true)
  const stalled = rows[0]
  const result = first.enqueued === 2
    && first.stalled.length === 0
    && again.skippedDuplicate >= 1
    && afterEvent.enqueued === 1
    && rows.length === 2
    && stallStore.findOutboxByDedupe('task-progress:task_progress:stall:5') !== null
    && stallStore.findOutboxByDedupe('task-progress:task_progress:stall:6') !== null
    // B3 v1: the notice says where it stopped and the one action that works.
    && stalled.payload.stuckAt === 'task.checkpoint'
    && stalled.payload.stuckPhase === '执行中（checkpoint 已打开）'
    && Array.isArray(stalled.payload.options)
    && stalled.payload.options.join(',') === 'wait,stop'
    && /卡在「执行中/.test(stalled.payload.text)
    && /回复「停止 ref-progress」/.test(stalled.payload.text)
    && !/已暂停|paused/.test(stalled.payload.text)
  stallStore.close()
  return result
})

await check('pauseOnStall reports one stalled task and promises the auto-pause', () => {
  const path = join(dir, 'progress-pause.sqlite')
  const pauseStore = createGatewayStore(path)
  const thread = pauseStore.resolveThread({ channelId: 'feishu', chatId: 'c4', rootMsgId: 'r4' })
  const relay = createTaskProgressRelay({
    store: pauseStore,
    tasks: {
      listRunningTasks: () => [progressSnapshot({
        threadIds: [thread.id],
        lastEventSeq: 7,
        lastEventType: 'task.checkpoint',
      })],
    },
    now: progressNow,
    milestonesMs: [120_000, 600_000],
    stallMs: 900_000,
    pauseOnStall: true,
  })
  progressClock = new Date('2026-11-12T00:16:00.000Z')
  const first = relay.pump()
  const again = relay.pump()
  const rows = pauseStore
    .listOutbox()
    .filter((row) => row.topic === 'task.progress' && row.payload.stall === true)
  const stalled = rows[0]
  const result = first.enqueued === 2
    && first.stalled.length === 1
    && first.stalled[0].taskId === 'task_progress'
    && first.stalled[0].silentMs === 16 * 60_000
    // The dedupe key is unchanged, so the next tick must not queue/pause twice.
    && again.stalled.length === 0
    && again.skippedDuplicate >= 1
    && rows.length === 1
    && /已自动暂停/.test(stalled.payload.text)
    && /回复「继续 ref-progress」重新执行/.test(stalled.payload.text)
    && !/不会自动停止/.test(stalled.payload.text)
    // Paused, so the offered actions are resume/stop, not wait/stop.
    && stalled.payload.options.join(',') === 'resume,stop'
  pauseStore.close()
  return result
})

await check('a task without an addressable live thread is skipped, not sent', () => {
  const path = join(dir, 'progress-nothread.sqlite')
  const noThreadStore = createGatewayStore(path)
  progressClock = new Date('2026-11-12T00:20:00.000Z')
  const relay = createTaskProgressRelay({
    store: noThreadStore,
    tasks: { listRunningTasks: () => [progressSnapshot({ threadIds: [] })] },
    now: progressNow,
    milestonesMs: [120_000, 600_000],
    stallMs: 900_000,
  })
  const missing = createTaskProgressRelay({
    store: noThreadStore,
    tasks: { listRunningTasks: () => [progressSnapshot({ threadIds: ['thread_missing'] })] },
    now: progressNow,
    milestonesMs: [120_000, 600_000],
    stallMs: 900_000,
  })
  const first = relay.pump()
  const second = missing.pump()
  const rows = noThreadStore.listOutbox()
  noThreadStore.close()
  return first.scanned === 1
    && first.skippedNoThread === 1
    && second.skippedNoThread === 1
    && rows.length === 0
})

// ---- tools -------------------------------------------------------------------

const toolPath = join(dir, 'tools.sqlite')
const toolStore = createGatewayStore(toolPath)
const registered = []
registerGatewayTools({ tools: { register: (tool) => registered.push(tool) } }, { store: toolStore })
const tools = new Map(registered.map((tool) => [tool.name, tool]))

await check('registers say / thread_lookup / disposition_record / outbox_retry with R0/R1 and ports', () => {
  return registered.length === 4
    && tools.has('say')
    && tools.has('thread_lookup')
    && tools.has('disposition_record')
    && tools.has('outbox_retry')
    && GATEWAY_TOOL_RISK.say === 'R0'
    && GATEWAY_TOOL_RISK.thread_lookup === 'R0'
    && GATEWAY_TOOL_RISK.disposition_record === 'R0'
    && GATEWAY_TOOL_RISK.outbox_retry === 'R1'
    && GATEWAY_TOOL_PORT.say === 'Channel'
    && GATEWAY_TOOL_PORT.thread_lookup === 'Gateway'
    && GATEWAY_TOOL_PORT.outbox_retry === 'Gateway'
})

await check('say enqueues into the outbox instead of delivering directly', async () => {
  const value = await tools.get('say').execute({
    text: '磁盘用了 71%',
    threadId: 'thr_t',
    replyToMsgId: 'm_t',
    taskId: 'task_t',
  })
  const row = toolStore.getOutbox(value.id)
  return value.status === 'pending'
    && value.topic === 'say'
    && row.payload.text === '磁盘用了 71%'
    && row.threadId === 'thr_t'
    && row.replyToMsgId === 'm_t'
    && row.taskId === 'task_t'
    && toolStore.listOutbox({ status: 'pending' }).length === 1
})

await check('thread_lookup separates the chat route from the thread decisions', async () => {
  const thread = toolStore.resolveThread({ channelId: 'cli_t', chatId: 'chat_t' })
  toolStore.setSessionRoute({
    channelId: 'cli_t',
    chatId: 'chat_t',
    sessionKind: 'orchestrator',
    sessionId: 'sess_t',
  })
  toolStore.appendRouteDecision({
    triggerId: 'trig_t',
    action: 'answer',
    reason: 'continuation of the same conversation',
    threadId: thread.id,
  })
  const value = await tools.get('thread_lookup').execute({ threadId: thread.id, limit: 10 })
  return value.thread.id === thread.id
    && value.thread.chatId === 'chat_t'
    && value.routes.length === 1
    && value.routes[0].sessionId === 'sess_t'
    && value.decisions.length === 1
    && value.decisions[0].action === 'answer'
    && value.followUp.available === false
})

await check('thread_lookup accepts a chat-only lookup and refuses to guess', async () => {
  const value = await tools.get('thread_lookup').execute({ chatId: 'chat_t', channelId: 'cli_t' })
  let refused = false
  try {
    await tools.get('thread_lookup').execute({})
  } catch (error) {
    refused = error instanceof GatewayError && error.code === 'invalid-input'
  }
  return value.thread === null
    && value.routes.length === 1
    && value.decisions.length === 0
    && refused
})

await check('disposition_record appends a decision with its reason', async () => {
  const before = toolStore.listRouteDecisions().length
  const value = await tools.get('disposition_record').execute({
    triggerId: 'trig_t',
    action: 'attach',
    reason: 'owner followed up on task task_t',
    threadId: 'thr_t',
    targetTaskId: 'task_t',
    confidence: 0.7,
    promptVersion: 'router-v1',
  })
  const after = toolStore.listRouteDecisions()
  return after.length === before + 1
    && value.action === 'attach'
    && value.targetTaskId === 'task_t'
    && value.reason === 'owner followed up on task task_t'
})

await check('apply opens the configured database, registers tools and closes on dispose', () => {
  const previous = process.env.DSH_WFXM_AUDIT_DB
  const applyDb = join(dir, 'apply.sqlite')
  process.env.DSH_WFXM_AUDIT_DB = applyDb
  const applied = []
  let disposed = null
  try {
    apply({
      tools: { register: (tool) => applied.push(tool) },
      logger: {},
      on: (event, handler) => {
        if (event === 'dispose') disposed = handler
      },
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_WFXM_AUDIT_DB
    else process.env.DSH_WFXM_AUDIT_DB = previous
  }
  const created = existsSync(applyDb)
  if (typeof disposed === 'function') disposed()
  return applied.length === 4
    && created
    && name === 'dsh-wfxm-gateway'
    && inject.includes('tools')
})

// ---- Slice AO: thread history for the front desk ----------------------------

await check('threadHistory keeps only this thread’s messages and delivered replies', () => {
  const historyStore = createGatewayStore(join(dir, 'history.sqlite'))
  try {
    const one = historyStore.resolveThread({ channelId: 'cli_h', chatId: 'chat_one' })
    const two = historyStore.resolveThread({ channelId: 'cli_h', chatId: 'chat_two' })
    historyStore.acceptInbound({
      channelId: 'cli_h', msgId: 'h1', content: { text: '查一下 demo 服务' }, threadId: one.id,
    })
    historyStore.acceptInbound({
      channelId: 'cli_h', msgId: 'h2', content: { text: '另一个会话' }, threadId: two.id,
    })
    historyStore.acceptInbound({
      channelId: 'cli_h', msgId: 'h3', kind: 'control', content: { text: '停止 t1' }, threadId: one.id,
    })
    historyStore.enqueueOutbox({
      topic: 'say', payload: { text: 'demo 服务运行中' }, threadId: one.id,
    })
    const claimed = historyStore.claimOutbox({ owner: 'h', leaseMs: 10_000 })
    historyStore.markOutboxSent(claimed[0].id, 'om_h1')
    // Pending replies were never seen by the user, so they must not enter history.
    historyStore.enqueueOutbox({
      topic: 'say', payload: { text: '还没送达' }, threadId: one.id,
    })

    const entries = historyStore.threadHistory(one.id)
    return entries.length === 2
      && entries[0].role === 'user'
      && entries[0].text === '查一下 demo 服务'
      && entries[1].role === 'assistant'
      && entries[1].text === 'demo 服务运行中'
  } finally {
    historyStore.close()
  }
})

// ---- Slice AO.1: duplicate plain-text messages are ignored -------------------

await check('an identical message in one thread inside the window is ignored', async () => {
  const dedupeStore = createGatewayStore(join(dir, 'dedupe.sqlite'))
  try {
    const owner = dedupeStore.createActor({ kind: 'owner', displayName: 'Owner' })
    dedupeStore.bindChannel({ actorId: owner.id, channelId: 'cli_dup', externalUserId: 'open_dup' })
    const base = { channelId: 'cli_dup', externalUserId: 'open_dup', chatId: 'chat_dup' }
    const first = await ingestInbound({ store: dedupeStore }, {
      ...base, msgId: 'dup_1', content: { text: '检查磁盘' },
    })
    const second = await ingestInbound({ store: dedupeStore }, {
      ...base, msgId: 'dup_2', content: { text: '检查磁盘  ' },
    })
    const other = await ingestInbound({ store: dedupeStore }, {
      ...base, msgId: 'dup_3', content: { text: '检查内存' },
    })
    // Age both copies past the default 60s window; the same text is then new.
    const raw = new DatabaseConstructor(join(dir, 'dedupe.sqlite'))
    raw.prepare("UPDATE inbox SET received_at = ? WHERE msg_id IN ('dup_1', 'dup_2')")
      .run(new Date(Date.now() - 120_000).toISOString())
    raw.close()
    const third = await ingestInbound({ store: dedupeStore }, {
      ...base, msgId: 'dup_4', content: { text: '检查磁盘' },
    })
    const stored = dedupeStore.getInbox(second.inbox.id)
    return first.duplicate === false
      && second.duplicate === true
      && second.target.kind === 'none'
      && second.disposition?.action === 'ignore'
      && stored.status === 'done'
      && other.duplicate === false
      && third.duplicate === false
  } finally {
    dedupeStore.close()
  }
})

// ---- teardown ----------------------------------------------------------------

store.close()
retryStore.close()
dispatcherStore.close()
receiptStore.close()
progressStore.close()
toolStore.close()
ingestStore.close()
anchorStore.close()
memoryStore.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\ngateway: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
