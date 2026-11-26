import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseConstructor from 'better-sqlite3'
import {
  MEMORY_TOOL_RISK,
  MemoryError,
  checkFacts,
  createMemoryStore,
  createPathProbe,
  createProjectLookupPort,
  formatFactHealth,
  formatPendingProposals,
  gateFact,
  prepareFact,
  projectMemoryContext,
  registerMemoryTools,
} from '../lib/index.js'
// Cross-module acceptance only: the real port must satisfy ①'s resolver (11 §5.3.1).
import { resolveProject } from '@dsh-wfxm/gateway'

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

const dir = mkdtempSync(join(tmpdir(), 'knowledge-'))
const dbPath = join(dir, 'ops.sqlite')
const existingPath = mkdtempSync(join(tmpdir(), 'knowledge-path-'))
const missingPath = join(dir, 'does-not-exist')

const now = new Date('2026-11-09T08:00:00.000Z')
const store = createMemoryStore(dbPath)

const envFact = (overrides = {}) => ({
  subject: 'dsh-wfxm',
  predicate: 'package-manager',
  value: 'pnpm',
  kind: 'environment',
  source: 'observed',
  evidence: { probe: 'package-manager', value: 'pnpm' },
  ...overrides,
})

await check('migration creates projects, memory_facts, memory_edges', () => {
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  const version = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get('memory')
  db.close()
  return names.includes('projects')
    && names.includes('memory_facts')
    && names.includes('memory_edges')
    && names.includes('project_aliases')
    && names.includes('memory_proposals')
    && names.includes('schema_migrations')
    && version.version === 4
})

await check('migration is idempotent on reopen', () => {
  const again = createMemoryStore(dbPath)
  const ok = again.listProjects().length === 0
  again.close()
  return ok
})

await check('projects upsert / get / archive', () => {
  const created = store.upsertProject({ name: 'dsh-wfxm', rootPath: '/home/ailearn/projects/dsh-wfxm' })
  const updated = store.upsertProject({
    name: 'dsh-wfxm',
    rootPath: '/srv/dsh-wfxm',
    defaultExpert: 'ops',
  })
  const byName = store.getProjectByName('dsh-wfxm')
  const archived = store.archiveProject(created.id)
  const visible = store.listProjects().some((project) => project.id === created.id)
  const all = store.listProjects({ includeArchived: true }).some((project) => project.id === created.id)
  return created.id === updated.id
    && updated.rootPath === '/srv/dsh-wfxm'
    && byName?.defaultExpert === 'ops'
    && archived
    && visible === false
    && all
})

await check('environment fact without evidence is rejected', () => {
  try {
    prepareFact({ ...envFact(), evidence: null }, now)
    return false
  } catch (error) {
    return error instanceof MemoryError && error.code === 'evidence-required'
  }
})

await check('preference fact needs no evidence', () => {
  const { fact } = prepareFact({
    subject: 'owner',
    predicate: 'reply-style',
    value: 'concise',
    kind: 'preference',
    source: 'user-confirmed',
  }, now)
  return fact.kind === 'preference' && fact.evidence === null
})

await check('scope=project requires projectId', () => {
  try {
    prepareFact({ ...envFact(), scope: 'project' }, now)
    return false
  } catch (error) {
    return error instanceof MemoryError && error.code === 'missing-project'
  }
})

await check('inferred needs confidence in (0, 1]', () => {
  let missing = false
  let outOfRange = false
  try {
    prepareFact({ ...envFact(), source: 'inferred' }, now)
  } catch (error) {
    missing = error instanceof MemoryError && error.code === 'confidence-required'
  }
  try {
    prepareFact({ ...envFact(), source: 'inferred', confidence: 1.5 }, now)
  } catch (error) {
    outOfRange = error instanceof MemoryError && error.code === 'invalid-confidence'
  }
  return missing && outOfRange
})

await check('probe output is truncated to 200 chars', () => {
  const long = 'x'.repeat(500)
  const { fact } = prepareFact(envFact({ evidence: { probe: 'package-manager', value: long } }), now)
  return fact.evidence.value.length === 200
})

await check('secrets in value and evidence are masked before storage', () => {
  // 运行时拼接假 key，避免源码里出现完整形态被 secret scanning 拦下。
  const fakeKey = 'sk-' + 'abcdefghijklmnopqrstuvwx'
  const { fact, redactions } = prepareFact(envFact({
    value: `token ${fakeKey}`,
    evidence: { probe: 'package-manager', value: 'Authorization: Bearer abcdefghijklmnopqrstuvwx' },
  }), now)
  return redactions.length >= 2
    && !fact.value.includes(fakeKey)
    && fact.value.includes('[redacted:api-key:')
    && !fact.evidence.value.includes('abcdefghijklmnopqrstuvwx')
})

await check('fingerprint is derived when omitted', () => {
  const { fact } = prepareFact(envFact(), now)
  return typeof fact.evidence.fingerprint === 'string' && fact.evidence.fingerprint.length === 16
})

const first = store.insertFact(prepareFact(envFact(), now).fact)
const second = store.insertFact(prepareFact(envFact({ value: 'npm' }), now).fact)

await check('supersede keeps history and hides the old row', () => {
  const ok = store.supersedeFact(first.id, second.id)
  const live = store.liveFacts({ subject: 'dsh-wfxm' })
  const old = store.getFact(first.id)
  return ok
    && live.length === 1
    && live[0].id === second.id
    && old?.supersededBy === second.id
})

await check('superseding an already superseded row is a no-op', () => {
  return store.supersedeFact(first.id, second.id) === false
})

await check('liveFacts filters by predicate and limit', () => {
  const project = store.upsertProject({ name: 'p2', rootPath: '/tmp/p2' })
  store.insertFact(prepareFact(envFact({
    scope: 'project',
    projectId: project.id,
    subject: 'p2',
    predicate: 'path',
    value: '/tmp/p2',
    evidence: { probe: 'path', value: '/tmp/p2' },
  }), now).fact)
  const byPredicate = store.liveFacts({ predicate: 'path' })
  const byProject = store.liveFacts({ projectId: project.id })
  const limited = store.liveFacts({ limit: 1 })
  return byPredicate.length === 1
    && byProject.length === 1
    && limited.length === 1
})

await check('touchInjected records the injection and skips superseded rows', () => {
  const stamp = '2026-11-09T09:00:00.000Z'
  const touched = store.touchInjected([second.id, first.id], stamp)
  return touched === 1
    && store.getFact(second.id)?.lastInjectedAt === stamp
    && store.getFact(first.id)?.lastInjectedAt === null
})

await check('gate accepts when the probe agrees', async () => {
  const fact = prepareFact(envFact({ value: '/tmp', evidence: { probe: 'path', value: '/tmp' } }), now).fact
  const result = await gateFact(fact, { probe: createPathProbe() })
  return result.decision === 'accept' && result.verification === 'match'
})

await check('gate rejects a contradiction', async () => {
  const fact = prepareFact(envFact({ value: missingPath, evidence: { probe: 'path', value: missingPath } }), now).fact
  const result = await gateFact(fact, { probe: createPathProbe() })
  return result.decision === 'reject' && result.verification === 'unverified'
})

await check('gate treats a throwing probe as unverified (fail-soft)', async () => {
  const fact = prepareFact(envFact({ value: '/tmp', evidence: { probe: 'path', value: '/tmp' } }), now).fact
  const result = await gateFact(fact, {
    probe: () => { throw new Error('boom') },
  })
  return result.decision === 'accept-unverified' && result.verification === 'unverified'
})

await check('gate skips predicates outside the whitelist', async () => {
  let called = 0
  const fact = prepareFact(envFact({
    predicate: 'mood',
    evidence: { probe: 'mood', value: 'calm' },
  }), now).fact
  const result = await gateFact(fact, {
    probe: () => { called += 1; return { status: 'match' } },
  })
  return called === 0 && result.decision === 'accept-unverified'
})

await check('gate never probes a preference fact', async () => {
  let called = 0
  const fact = prepareFact({
    subject: 'owner',
    predicate: 'reply-style',
    value: 'concise',
    kind: 'preference',
    source: 'user-confirmed',
  }, now).fact
  const result = await gateFact(fact, { probe: () => { called += 1; return { status: 'mismatch' } } })
  return called === 0 && result.decision === 'accept'
})

await check('health reports conflicts without choosing one', async () => {
  const s = createMemoryStore(join(dir, 'conflict.sqlite'))
  const key = envFact()
  s.insertFact(prepareFact(key, now).fact)
  s.insertFact(prepareFact(key, now).fact)
  const report = await checkFacts({ store: s, now })
  s.close()
  return report.counts.conflict === 2 && report.status === 'warn'
})

await check('health reports orphan facts', async () => {
  const s = createMemoryStore(join(dir, 'orphan.sqlite'))
  s.insertFact(prepareFact(envFact({ scope: 'project', projectId: 'ghost' }), now).fact)
  const report = await checkFacts({ store: s, now })
  s.close()
  return report.counts.orphan === 1
})

await check('health reports expired facts', async () => {
  const s = createMemoryStore(join(dir, 'expired.sqlite'))
  const old = '2026-01-01T00:00:00.000Z'
  s.insertFact(prepareFact(envFact({
    validFrom: old,
    evidence: { probe: 'package-manager', value: 'pnpm', observedAt: old },
  }), new Date('2026-11-09T00:00:00.000Z')).fact)
  const report = await checkFacts({ store: s, now: new Date('2026-11-09T00:00:00.000Z') })
  s.close()
  return report.counts.expired === 1
})

await check('unavailable probes are counted, not reported stale', async () => {
  const s = createMemoryStore(join(dir, 'stale.sqlite'))
  const probe = createPathProbe()
  s.insertFact(prepareFact(envFact({
    subject: 'gone',
    predicate: 'path',
    value: '/tmp',
    evidence: { probe: 'path', value: '/tmp' },
  }), now).fact)
  s.insertFact(prepareFact(envFact({
    subject: 'host',
    predicate: 'port',
    value: '8080',
    evidence: { probe: 'port', value: '8080' },
  }), now).fact)
  const report = await checkFacts({ store: s, now, probe })
  s.close()
  return report.counts.stale === 0
    && report.probeUnavailable === 1
    && report.findings.every((finding) => finding.check !== 'stale')
})

await check('a path fact that disappeared is reported stale', async () => {
  const s = createMemoryStore(join(dir, 'stale2.sqlite'))
  const fact = s.insertFact(prepareFact(envFact({
    subject: 'old-dir',
    predicate: 'path',
    value: existingPath,
    evidence: { probe: 'path', value: existingPath },
  }), now).fact)
  // Point the stored observation at a path that does not exist any more.
  s.close()
  const db = new DatabaseConstructor(join(dir, 'stale2.sqlite'))
  db.prepare('UPDATE memory_facts SET evidence_json = ? WHERE id = ?').run(
    JSON.stringify({ probe: 'path', value: missingPath, observedAt: now.toISOString(), fingerprint: 'x' }),
    fact.id,
  )
  db.close()
  const reopened = createMemoryStore(join(dir, 'stale2.sqlite'))
  const report = await checkFacts({ store: reopened, now, probe: createPathProbe() })
  reopened.close()
  return report.counts.stale === 1
})

await check('health lists facts not injected for 30 days as review candidates', async () => {
  const s = createMemoryStore(join(dir, 'review.sqlite'))
  const old = '2026-09-01T00:00:00.000Z'
  const stale = s.insertFact(prepareFact(envFact({ subject: 'old' }), now).fact)
  const fresh = s.insertFact(prepareFact(envFact({ subject: 'new' }), now).fact)
  s.touchInjected([stale.id], old)
  s.touchInjected([fresh.id], '2026-11-08T00:00:00.000Z')
  const report = await checkFacts({ store: s, now: new Date('2026-11-09T00:00:00.000Z') })
  s.close()
  return report.reviewCandidates.length === 1 && report.reviewCandidates[0].factId === stale.id
})

// --- tools -----------------------------------------------------------------

function makeCtx() {
  const registered = []
  return { ctx: { tools: { register: (tool) => registered.push(tool) } }, registered }
}

const { ctx, registered } = makeCtx()
registerMemoryTools(ctx, { store, probe: createPathProbe(), now: () => now })
const tools = new Map(registered.map((tool) => [tool.name, tool]))

await check('registers six tools with their risk baseline', () => {
  return registered.length === 6
    && tools.has('mem_facts')
    && tools.has('mem_remember')
    && tools.has('mem_propose')
    && tools.has('mem_proposals')
    && tools.has('mem_resolve')
    && tools.has('mem_health')
    && MEMORY_TOOL_RISK.mem_facts === 'R0'
    && MEMORY_TOOL_RISK.mem_remember === 'R1'
    && MEMORY_TOOL_RISK.mem_propose === 'R1'
    && MEMORY_TOOL_RISK.mem_proposals === 'R0'
    && MEMORY_TOOL_RISK.mem_resolve === 'R1'
    && MEMORY_TOOL_RISK.mem_health === 'R0'
})

await check('mem_remember writes a verified path fact', async () => {
  const value = await tools.get('mem_remember').execute({
    subject: 'workspace',
    predicate: 'path',
    value: existingPath,
    kind: 'environment',
    source: 'observed',
    probe: 'path',
  })
  const stored = store.getFact(value.factId)
  return value.written
    && value.decision === 'accept'
    && stored?.evidence.verification === 'match'
})

await check('mem_remember rejects a contradiction and keeps the old fact', async () => {
  const previous = store.liveFacts({ subject: 'workspace' })[0]
  const value = await tools.get('mem_remember').execute({
    subject: 'workspace',
    predicate: 'path',
    value: missingPath,
    kind: 'environment',
    source: 'observed',
    probe: 'path',
    supersedes: previous.id,
  })
  const stillLive = store.liveFacts({ subject: 'workspace' })
  return value.written === false
    && value.decision === 'reject'
    && stillLive.length === 1
    && stillLive[0].id === previous.id
})

await check('mem_remember supersedes an explicit target', async () => {
  const previous = store.liveFacts({ subject: 'workspace' })[0]
  const value = await tools.get('mem_remember').execute({
    subject: 'workspace',
    predicate: 'path',
    value: existingPath,
    kind: 'environment',
    source: 'user-confirmed',
    probe: 'path',
    supersedes: previous.id,
  })
  const previousRow = store.getFact(previous.id)
  return value.written && value.superseded && previousRow.supersededBy === value.factId
})

await check('mem_remember raises for an invalid supersede target', async () => {
  try {
    await tools.get('mem_remember').execute({
      subject: 'workspace',
      predicate: 'path',
      value: existingPath,
      kind: 'environment',
      source: 'observed',
      probe: 'path',
      supersedes: 'not-a-fact',
    })
    return false
  } catch (error) {
    return error instanceof MemoryError && error.code === 'invalid-fact'
  }
})

await check('mem_facts returns only live facts', async () => {
  const value = await tools.get('mem_facts').execute({ subject: 'workspace' })
  return value.total === 1
    && value.facts[0].verification === 'match'
    && store.liveFacts({ subject: 'workspace' }).length === 1
})

await check('mem_health returns the five-class report', async () => {
  const value = await tools.get('mem_health').execute({})
  return typeof value.checkedAt === 'string'
    && value.scanned === store.liveFacts().length
    && value.counts.conflict === 0
    && Array.isArray(value.reviewCandidates)
})

// ---- G5 proposals (Slice CF) ------------------------------------------------

let demoProposalId = null

await check('mem_propose files a pending proposal without writing a fact', async () => {
  const value = await tools.get('mem_propose').execute({
    subject: 'proposal-demo',
    predicate: 'reply-language',
    value: 'zh-CN',
    kind: 'preference',
    source: 'inferred',
    confidence: 0.8,
    reason: 'owner used Chinese in every turn this week',
  })
  demoProposalId = value.proposalId
  return value.status === 'pending'
    && value.proposalId !== null
    && value.alreadyPending === false
    && store.liveFacts({ subject: 'proposal-demo' }).length === 0
    && store.getProposal(value.proposalId)?.status === 'pending'
})

await check('mem_propose returns duplicate for an identical live fact', async () => {
  const live = store.insertFact(prepareFact({
    subject: 'proposal-dup',
    predicate: 'note',
    value: 'same',
    kind: 'preference',
    source: 'user-confirmed',
  }, now).fact)
  const value = await tools.get('mem_propose').execute({
    subject: 'proposal-dup',
    predicate: 'note',
    value: 'same',
    kind: 'preference',
    source: 'user-confirmed',
    reason: 'same value again',
  })
  return value.status === 'duplicate'
    && value.proposalId === null
    && value.existingFactId === live.id
    && store.listProposals({ status: 'pending' }).every((item) => item.subject !== 'proposal-dup')
})

await check('mem_propose flags a conflict and suggests supersede', async () => {
  const old = store.insertFact(prepareFact({
    subject: 'proposal-conflict',
    predicate: 'path',
    value: '/srv/old',
    kind: 'environment',
    source: 'observed',
    evidence: { probe: 'path', value: '/srv/old' },
  }, now).fact)
  const value = await tools.get('mem_propose').execute({
    subject: 'proposal-conflict',
    predicate: 'path',
    value: existingPath,
    kind: 'environment',
    source: 'observed',
    probe: 'path',
    reason: 'the workspace moved',
  })
  const proposal = store.getProposal(value.proposalId)
  return value.status === 'conflict'
    && value.supersedes === old.id
    && value.existingValue === '/srv/old'
    && proposal?.supersedes === old.id
})

await check('a second conflicting value is refused until the owner cleans up', async () => {
  for (const value of ['/srv/a', '/srv/b']) {
    store.insertFact(prepareFact({
      subject: 'proposal-two',
      predicate: 'path',
      value,
      kind: 'environment',
      source: 'observed',
      evidence: { probe: 'path', value },
    }, now).fact)
  }
  const value = await tools.get('mem_propose').execute({
    subject: 'proposal-two',
    predicate: 'path',
    value: '/srv/c',
    kind: 'environment',
    source: 'observed',
    probe: 'path',
    reason: 'third value',
  })
  return value.status === 'conflict'
    && value.proposalId === null
    && store.listProposals({ status: 'pending' }).every((item) => item.subject !== 'proposal-two')
})

await check('mem_proposals lists pending proposals with their reason', async () => {
  const value = await tools.get('mem_proposals').execute({})
  const listed = value.proposals.find((item) => item.id === demoProposalId)
  return value.total >= 1
    && listed !== undefined
    && listed.subject === 'proposal-demo'
    && listed.reason.includes('Chinese')
    && listed.ageDays === 0
})

await check('mem_resolve confirm writes the fact and closes the proposal', async () => {
  const value = await tools.get('mem_resolve').execute({ id: demoProposalId, decision: 'confirm' })
  const proposal = store.getProposal(demoProposalId)
  const stored = store.getFact(value.factId)
  return value.resolved
    && value.status === 'confirmed'
    && stored?.value === 'zh-CN'
    && proposal?.status === 'confirmed'
    && proposal.factId === value.factId
    && store.liveFacts({ subject: 'proposal-demo' }).length === 1
})

await check('mem_resolve confirm supersedes the conflicting fact', async () => {
  const conflict = store.listProposals({ status: 'pending' })
    .find((item) => item.subject === 'proposal-conflict')
  const value = await tools.get('mem_resolve').execute({ id: conflict.id, decision: 'confirm' })
  const old = store.getFact(conflict.supersedes)
  return value.resolved
    && value.superseded === true
    && old?.supersededBy === value.factId
    && store.liveFacts({ subject: 'proposal-conflict' }).length === 1
})

await check('mem_resolve reject writes nothing', async () => {
  const created = await tools.get('mem_propose').execute({
    subject: 'proposal-reject',
    predicate: 'tone',
    value: 'formal',
    kind: 'preference',
    source: 'inferred',
    confidence: 0.6,
    reason: 'maybe',
  })
  const value = await tools.get('mem_resolve').execute({ id: created.proposalId, decision: 'reject' })
  return value.resolved
    && value.status === 'rejected'
    && store.liveFacts({ subject: 'proposal-reject' }).length === 0
    && store.getProposal(created.proposalId)?.status === 'rejected'
})

await check('an expired proposal cannot be confirmed', async () => {
  const expired = store.insertProposal({
    fact: prepareFact({
      subject: 'proposal-expired',
      predicate: 'tone',
      value: 'short',
      kind: 'preference',
      source: 'user-confirmed',
    }, now).fact,
    reason: 'too old',
    expiresAt: '2026-11-01T00:00:00.000Z',
    supersedes: null,
  })
  const value = await tools.get('mem_resolve').execute({ id: expired.id, decision: 'confirm' })
  return value.resolved === false
    && value.status === 'expired'
    && store.liveFacts({ subject: 'proposal-expired' }).length === 0
})

await check('pending proposals survive a reopen and stay out of facts', () => {
  const path = join(dir, 'proposal-reopen.sqlite')
  const first = createMemoryStore(path)
  const proposal = first.insertProposal({
    fact: prepareFact({
      subject: 'persisted',
      predicate: 'note',
      value: 'v',
      kind: 'preference',
      source: 'user-confirmed',
    }, now).fact,
    reason: 'persist me',
    expiresAt: '2027-01-01T00:00:00.000Z',
    supersedes: null,
  })
  first.close()
  const again = createMemoryStore(path)
  const row = again.getProposal(proposal.id)
  const facts = again.liveFacts({ subject: 'persisted' })
  again.close()
  return row?.status === 'pending' && facts.length === 0
})

await check('formatPendingProposals is quiet when empty and renders the reply hint', () => {
  const quiet = formatPendingProposals([], now)
  const busy = formatPendingProposals([{
    id: 'mp-1',
    subject: 'owner',
    predicate: 'tone',
    value: 'short',
    createdAt: '2026-11-07T08:00:00.000Z',
  }], now)
  return quiet === null
    && /记忆提案：1 条待确认（最早 2 天）/.test(busy)
    && /mp-1 owner\.tone = short/.test(busy)
    && /回复「记住 <id>」或「不记 <id>」/.test(busy)
})

await check('formatFactHealth: quiet hosts return null; findings/candidates/probes render', () => {
  const quiet = formatFactHealth({
    checkedAt: now.toISOString(),
    scanned: 0,
    status: 'ok',
    counts: { conflict: 0, expired: 0, 'no-source': 0, orphan: 0, stale: 0 },
    findings: [],
    reviewCandidates: [],
    probeUnavailable: 0,
  })
  const busy = formatFactHealth({
    checkedAt: now.toISOString(),
    scanned: 3,
    status: 'warn',
    counts: { conflict: 1, expired: 1, 'no-source': 0, orphan: 0, stale: 0 },
    findings: [
      { check: 'conflict', factId: 'f1', subject: 'gateway', predicate: 'port', detail: '' },
      { check: 'expired', factId: 'f2', subject: 'host', predicate: 'unit', detail: '' },
    ],
    reviewCandidates: [{
      factId: 'f3',
      subject: 'old',
      predicate: 'note',
      lastInjectedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      ageDays: 40,
    }],
    probeUnavailable: 2,
  })
  return quiet === null
    && /扫描 3 条：冲突 1 \/ 过期 1 \/ 无来源 0 \/ 孤儿 0 \/ 失效 0/.test(busy)
    && /- 冲突：gateway\.port（f1）/.test(busy)
    && /- 复核候选 1 条（>30 天未被引用）/.test(busy)
    && /探针不可用 2 条，未计失效/.test(busy)
    && /只提示，不自动取代。/.test(busy)
})

// ---- cross-project boundary (08 §七 #3: 项目事实隔离、偏好共享) --------------

await check('a preference cannot be project-scoped or carry projectId', () => {
  const base = {
    subject: 'owner',
    predicate: 'reply-style',
    value: 'concise',
    kind: 'preference',
    source: 'user-confirmed',
  }
  try {
    prepareFact({ ...base, scope: 'project', projectId: 'proj_a' }, now)
    return false
  } catch (error) {
    if (!(error instanceof MemoryError && error.code === 'invalid-fact')) return false
  }
  try {
    prepareFact({ ...base, projectId: 'proj_a' }, now)
    return false
  } catch (error) {
    return error instanceof MemoryError && error.code === 'invalid-fact'
  }
})

await check('a project read returns global preferences plus its own facts, never another project', () => {
  const boundary = createMemoryStore(join(dir, 'boundary.sqlite'))
  const put = (input) => boundary.insertFact(prepareFact(input, now).fact)
  put({
    subject: 'owner',
    predicate: 'reply-style',
    value: 'short',
    kind: 'preference',
    source: 'user-confirmed',
  })
  put({ ...envFact(), scope: 'project', projectId: 'proj_a', subject: 'deploy', predicate: 'script' })
  put({ ...envFact(), scope: 'project', projectId: 'proj_b', subject: 'deploy', predicate: 'script' })

  const forA = boundary.liveFacts({ forProject: 'proj_a' })
  const exactA = boundary.liveFacts({ projectId: 'proj_a' })
  const noContext = boundary.liveFacts({ scope: 'global' })
  boundary.close()

  const keysOf = (rows) => rows.map((row) => `${row.scope}:${row.projectId ?? '-'}:${row.subject}`).sort()
  return JSON.stringify(keysOf(forA)) === JSON.stringify(['global:-:owner', 'project:proj_a:deploy'])
    && JSON.stringify(keysOf(exactA)) === JSON.stringify(['project:proj_a:deploy'])
    && JSON.stringify(keysOf(noContext)) === JSON.stringify(['global:-:owner'])
})

await check('mem_facts defaults to global and refuses a project scope without projectId', async () => {
  const globalOnly = await tools.get('mem_facts').execute({})
  const missing = await tools.get('mem_facts').execute({ scope: 'project' }).then(
    () => null,
    (error) => error,
  )
  return globalOnly.facts.every((fact) => fact.scope === 'global')
    && missing instanceof MemoryError
    && missing.code === 'missing-project'
})

// ---- project aliases (11 §5.3.1 片 1) ---------------------------------------

await check('an alias resolves case-insensitively and belongs to one project', () => {
  const s = createMemoryStore(join(dir, 'alias.sqlite'))
  const a = s.upsertProject({ name: 'dsh-wfxm', rootPath: '/srv/dsh-wfxm' })
  const b = s.upsertProject({ name: 'WFXM', rootPath: '/srv/WFXM' })
  s.addProjectAlias({ projectId: a.id, alias: 'Ops' })
  s.addProjectAlias({ projectId: a.id, alias: '管家' })

  const hit = s.resolveProjectAlias('ops')
  const byName = s.resolveProjectAlias('wfxm')
  const aliases = s.listProjectAliases(a.id)
  s.close()
  return hit?.id === a.id
    && byName?.id === b.id
    && aliases.length === 2
    && aliases.every((row) => row.projectId === a.id)
})

await check('re-adding the same alias is idempotent; another project is a conflict', () => {
  const s = createMemoryStore(join(dir, 'alias2.sqlite'))
  const a = s.upsertProject({ name: 'alpha', rootPath: '/srv/alpha' })
  const b = s.upsertProject({ name: 'beta', rootPath: '/srv/beta' })
  const first = s.addProjectAlias({ projectId: a.id, alias: 'a' })
  const again = s.addProjectAlias({ projectId: a.id, alias: 'A' })
  const conflict = (() => {
    try {
      s.addProjectAlias({ projectId: b.id, alias: 'a' })
      return null
    } catch (error) {
      return error
    }
  })()
  const shadow = (() => {
    try {
      s.addProjectAlias({ projectId: a.id, alias: 'beta' })
      return null
    } catch (error) {
      return error
    }
  })()
  const count = s.listProjectAliases(a.id).length
  s.close()
  return first.createdAt === again.createdAt
    && count === 1
    && conflict instanceof MemoryError
    && conflict.code === 'conflict'
    && shadow instanceof MemoryError
    && shadow.code === 'conflict'
})

await check('aliases reject empty input and missing projects, and can be removed', () => {
  const s = createMemoryStore(join(dir, 'alias3.sqlite'))
  const a = s.upsertProject({ name: 'gamma', rootPath: '/srv/gamma' })
  const empty = (() => {
    try {
      s.addProjectAlias({ projectId: a.id, alias: '  ' })
      return null
    } catch (error) {
      return error
    }
  })()
  const missing = (() => {
    try {
      s.addProjectAlias({ projectId: 'nope', alias: 'g' })
      return null
    } catch (error) {
      return error
    }
  })()
  s.addProjectAlias({ projectId: a.id, alias: 'g' })
  const removed = s.removeProjectAlias({ projectId: a.id, alias: 'G' })
  const after = s.resolveProjectAlias('g')
  const byName = s.resolveProjectAlias('gamma')
  s.close()
  return empty instanceof MemoryError
    && empty.code === 'invalid-fact'
    && missing instanceof MemoryError
    && missing.code === 'not-found'
    && removed === true
    && after === null
    && byName?.name === 'gamma'
})

await check('an archived project stops matching but keeps its alias rows', () => {
  const s = createMemoryStore(join(dir, 'alias4.sqlite'))
  const a = s.upsertProject({ name: 'delta', rootPath: '/srv/delta' })
  const b = s.upsertProject({ name: 'epsilon', rootPath: '/srv/epsilon' })
  s.addProjectAlias({ projectId: a.id, alias: 'd' })
  s.archiveProject(a.id)

  const byAlias = s.resolveProjectAlias('d')
  const byName = s.resolveProjectAlias('delta')
  const choices = s.listProjectChoices()
  const kept = s.listProjectAliases(a.id)
  s.close()
  return byAlias === null
    && byName === null
    && choices.length === 1
    && choices[0].id === b.id
    && kept.length === 1
})

await check('a v1 memory database upgrades to the latest schema', () => {
  const upgradePath = join(dir, 'memory-upgrade.sqlite')
  const first = createMemoryStore(upgradePath)
  first.close()

  // Rebuild `projects` in its v1 shape and pretend only v1 was applied. The
  // v1 memory tables (facts/edges) are still intact, so the reopen exercises
  // exactly the v2 (aliases) + v3 (isolation columns) expand steps.
  const raw = new DatabaseConstructor(upgradePath)
  raw.exec(`
    DROP TABLE project_aliases;
    DROP TABLE projects;
    CREATE TABLE projects (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL UNIQUE,
      root_path      TEXT NOT NULL,
      rules_doc      TEXT,
      default_expert TEXT,
      created_at     TEXT NOT NULL,
      archived_at    TEXT
    );
    INSERT INTO projects(id, name, root_path, rules_doc, default_expert, created_at, archived_at)
      VALUES ('p-zeta', 'zeta', '/srv/zeta', NULL, NULL, datetime('now'), NULL);
    DELETE FROM schema_migrations WHERE module = 'memory' AND version > 1;
  `)
  raw.close()

  const reopened = createMemoryStore(upgradePath)
  const version = new DatabaseConstructor(upgradePath, { readonly: true })
    .prepare("SELECT MAX(version) AS version FROM schema_migrations WHERE module = 'memory'")
    .get()
  const upgraded = reopened.getProject('p-zeta')
  reopened.addProjectAlias({ projectId: 'p-zeta', alias: 'z' })
  const hit = reopened.resolveProjectAlias('z')
  reopened.close()
  return version.version === 4
    && upgraded?.vcs === 'none'
    && upgraded?.mergeMode === 'manual'
    && hit?.id === 'p-zeta'
})

// ---- assembly point (11 §5.3.1 片 3, 13 §2.2) -------------------------------

await check('⑥ real port answers ① resolver: explicit / single / ask', () => {
  const s = createMemoryStore(join(dir, 'port.sqlite'))
  const alpha = s.upsertProject({ name: 'alpha', rootPath: '/srv/alpha' })
  const beta = s.upsertProject({ name: 'beta', rootPath: '/srv/beta' })
  s.addProjectAlias({ projectId: alpha.id, alias: 'a' })
  const port = createProjectLookupPort(s)

  const noSignal = resolveProject({ port })
  const byAlias = resolveProject({ port, explicitAlias: 'A' })
  const byName = resolveProject({ port, explicitAlias: 'beta' })
  const unknown = resolveProject({ port, explicitAlias: 'zzz' })
  const sticky = resolveProject({ port, stickyProjectId: beta.id })
  s.close()

  const single = createMemoryStore(join(dir, 'port-single.sqlite'))
  single.upsertProject({ name: 'only', rootPath: '/srv/only' })
  const onlyOne = resolveProject({ port: createProjectLookupPort(single) })
  single.close()

  return noSignal.matchedBy === 'asked'
    && noSignal.candidates.length === 2
    && byAlias.projectId === alpha.id
    && byAlias.matchedBy === 'explicit'
    && byAlias.name === 'alpha'
    && byName.projectId === beta.id
    && byName.matchedBy === 'explicit'
    && unknown.projectId === null
    && unknown.candidates.length === 2
    && sticky.projectId === beta.id
    && sticky.matchedBy === 'sticky'
    && onlyOne.matchedBy === 'single'
    && onlyOne.name === 'only'
})

await check('an archived project disappears from the port', () => {
  const s = createMemoryStore(join(dir, 'port-archived.sqlite'))
  const a = s.upsertProject({ name: 'keep', rootPath: '/srv/keep' })
  const b = s.upsertProject({ name: 'gone', rootPath: '/srv/gone' })
  s.addProjectAlias({ projectId: b.id, alias: 'g' })
  s.archiveProject(b.id)

  const port = createProjectLookupPort(s)
  const choices = port.listProjects()
  const byAlias = port.resolveAlias('g')
  const byName = port.resolveAlias('gone')
  const resolved = resolveProject({ port })
  s.close()
  return choices.length === 1
    && choices[0].projectId === a.id
    && byAlias === null
    && byName === null
    && resolved.matchedBy === 'single'
    && resolved.projectId === a.id
})

const seedFact = (s, input) => s.insertFact(prepareFact(input, now).fact)
const contextKeys = (facts) =>
  facts.map((fact) => `${fact.scope}:${fact.projectId ?? '-'}:${fact.subject}`).sort()

await check('a turn context is global facts plus its own project, never another', () => {
  const s = createMemoryStore(join(dir, 'context.sqlite'))
  const alpha = s.upsertProject({ name: 'alpha', rootPath: '/srv/alpha' })
  const beta = s.upsertProject({ name: 'beta', rootPath: '/srv/beta' })
  seedFact(s, {
    subject: 'owner',
    predicate: 'reply-style',
    value: 'short',
    kind: 'preference',
    source: 'user-confirmed',
  })
  seedFact(s, {
    subject: 'host',
    predicate: 'os',
    value: 'debian-12',
    kind: 'environment',
    source: 'observed',
    scope: 'global',
    evidence: { probe: 'os', value: 'debian-12' },
  })
  seedFact(s, { ...envFact(), scope: 'project', projectId: alpha.id, subject: 'alpha-deploy' })
  seedFact(s, { ...envFact(), scope: 'project', projectId: beta.id, subject: 'beta-deploy' })

  const forAlpha = projectMemoryContext(s, { projectId: alpha.id })
  const noContext = projectMemoryContext(s)
  s.close()
  return JSON.stringify(contextKeys(forAlpha.facts))
    === JSON.stringify(['global:-:host', 'global:-:owner', `project:${alpha.id}:alpha-deploy`])
    && forAlpha.project?.name === 'alpha'
    && JSON.stringify(contextKeys(noContext.facts))
    === JSON.stringify(['global:-:host', 'global:-:owner'])
    && noContext.project === null
})

await check('an unknown or archived project is refused, never silently global', () => {
  const s = createMemoryStore(join(dir, 'context-refused.sqlite'))
  const gone = s.upsertProject({ name: 'gone', rootPath: '/srv/gone' })
  s.archiveProject(gone.id)
  const unknown = (() => {
    try {
      projectMemoryContext(s, { projectId: 'nope' })
      return null
    } catch (error) {
      return error
    }
  })()
  const archived = (() => {
    try {
      projectMemoryContext(s, { projectId: gone.id })
      return null
    } catch (error) {
      return error
    }
  })()
  s.close()
  return unknown instanceof MemoryError
    && unknown.code === 'not-found'
    && archived instanceof MemoryError
    && archived.code === 'not-found'
})

await check('the fingerprint tracks the fact set and touch records the injection', () => {
  const s = createMemoryStore(join(dir, 'context-fingerprint.sqlite'))
  const alpha = s.upsertProject({ name: 'alpha', rootPath: '/srv/alpha' })
  const first = seedFact(s, { ...envFact(), scope: 'project', projectId: alpha.id })

  const before = projectMemoryContext(s, { projectId: alpha.id })
  const again = projectMemoryContext(s, { projectId: alpha.id })
  const injected = projectMemoryContext(s, { projectId: alpha.id, touch: true, at: now })
  const afterTouch = s.getFact(first.id)
  seedFact(s, { ...envFact(), scope: 'project', projectId: alpha.id, subject: 'second' })
  const grown = projectMemoryContext(s, { projectId: alpha.id })
  s.close()

  return before.fingerprint.length === 16
    && before.fingerprint === again.fingerprint
    && injected.injectedAt === now.toISOString()
    && afterTouch.lastInjectedAt === now.toISOString()
    && grown.fingerprint !== before.fingerprint
})

store.close()
rmSync(dir, { recursive: true, force: true })
rmSync(existingPath, { recursive: true, force: true })

console.log(`\nknowledge: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
