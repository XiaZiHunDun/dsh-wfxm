import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import DatabaseConstructor from 'better-sqlite3'

const root = mkdtempSync(join(tmpdir(), 'dsh-wfxm-concurrency-'))
const ws1 = join(root, 'ws1')
const ws2 = join(root, 'ws2')
mkdirSync(ws1, { recursive: true })
mkdirSync(ws2, { recursive: true })

const dbPath = join(root, 'ops.sqlite')
const policyPath = join(root, 'policy.yaml')
writeFileSync(
  policyPath,
  [
    'version: 2',
    'killSwitchFile: KILL',
    `writeRoots:`,
    `  - ${root}`,
    `readRoots:`,
    `  - ${root}`,
    'concurrency:',
    '  writeSerialization: true',
    '  conflictLimit: 2',
    'bash:',
    '  denyPatterns: []',
    '',
  ].join('\n'),
)
process.env.DSH_WFXM_AUDIT_DB = dbPath
process.env.DSH_WFXM_POLICY = policyPath

const { apply } = await import('../lib/index.js')

const listeners = new Map()
const warnings = []
const ctx = {
  workingDirectory: { get: (session) => session.header.cwd },
  logger: {
    info() {},
    warn: (...args) => warnings.push(args.join(' ')),
    error() {},
  },
  on(event, listener) {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
  },
}

apply(ctx)
const execute = listeners.get('tools/execute')?.[0]
const post = listeners.get('tools/post-execute')?.[0]
if (!execute) throw new Error('tools/execute listener not registered')
if (!post) throw new Error('tools/post-execute listener not registered')

let seq = 0
function execFor(name, args, agent) {
  seq += 1
  return { callId: `call-${seq}`, name, arguments: args, agent, signal: new AbortController().signal }
}

function agentFor(id, cwd) {
  return { id, session: { header: { cwd } } }
}
const agentA = agentFor('session-a', ws1)
const agentB = agentFor('session-b', ws1)
const agentC = agentFor('session-c', ws2)

async function write(name, args, agent, body) {
  return execute(execFor(name, args, agent), async () => {
    if (body) await body()
    else applyMutation(name, args)
    return { isError: false }
  })
}

async function attemptWrite(name, args, agent) {
  return execute(execFor(name, args, agent), async () => {
    applyMutation(name, args)
    return { isError: false }
  })
}

function applyMutation(name, args) {
  if (name === 'write') {
    writeFileSync(args.file_path, args.content)
    return
  }
  const current = readFileSync(args.file_path, 'utf8')
  writeFileSync(args.file_path, current.replace(args.old_string, args.new_string))
}

async function recordRead(path, agent, isError = false) {
  await post(execFor('read', { file_path: path }, agent), { isError }, async () => ({ kind: 'accept' }))
}

let pass = 0
let fail = 0
function check(ok, label, detail = '') {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Same workspace writes serialize.
const intervals = []
const slowBody = async () => {
  const start = performance.now()
  await new Promise((resolve) => setTimeout(resolve, 40))
  intervals.push([start, performance.now()])
}
await Promise.all([
  write('write', { file_path: join(ws1, 'serial.txt'), content: 'a' }, agentA, slowBody),
  write('edit', { file_path: join(ws1, 'serial.txt'), old_string: 'a', new_string: 'b' }, agentB, slowBody),
])
const sorted = intervals.slice().sort((left, right) => left[0] - right[0])
const overlapped = sorted[0][1] > sorted[1][0]
check(!overlapped, 'same-workspace writes are serialized', JSON.stringify(sorted))

// 2. Different workspaces stay parallel.
const parallelIntervals = []
const parallelBody = async () => {
  const start = performance.now()
  await new Promise((resolve) => setTimeout(resolve, 40))
  parallelIntervals.push([start, performance.now()])
}
await Promise.all([
  write('write', { file_path: join(ws1, 'parallel.txt'), content: 'a' }, agentB, parallelBody),
  write('write', { file_path: join(ws2, 'parallel.txt'), content: 'b' }, agentC, parallelBody),
])
const overlapsParallel = parallelIntervals[0][0] < parallelIntervals[1][1] && parallelIntervals[1][0] < parallelIntervals[0][1]
check(overlapsParallel, 'different workspaces stay parallel', JSON.stringify(parallelIntervals))

// 3. A read -> B write -> A write is refused as stale.
const shared = join(ws1, 'shared.txt')
writeFileSync(shared, 'v1')
await recordRead(shared, agentA)
await write('write', { file_path: shared, content: 'v2' }, agentB)
let staleRejected = false
try {
  await write('write', { file_path: shared, content: 'stale' }, agentA)
} catch (error) {
  staleRejected = /状态已变化/.test(String(error?.message))
}
check(staleRejected, 'write after another session changed the file is refused', readFileSync(shared, 'utf8'))

// 4. Re-reading refreshes the snapshot and allows the write.
await recordRead(shared, agentA)
await write('write', { file_path: shared, content: 'v3' }, agentA)
check(readFileSync(shared, 'utf8') === 'v3', 're-read then write succeeds')

// 5. Consecutive conflicts reach the limit and are recorded.
writeFileSync(shared, 'v4')
await recordRead(shared, agentA)
await recordRead(shared, agentB)
await write('write', { file_path: shared, content: 'v5' }, agentB)
await attemptWrite('write', { file_path: shared, content: 'x1' }, agentA).catch(() => {})
writeFileSync(shared, 'v6')
await attemptWrite('write', { file_path: shared, content: 'x2' }, agentA).catch(() => {})
check(warnings.some((line) => line.includes('consecutive write conflicts')), 'conflict limit emits notification hook warning', warnings.join(' | '))

// 6. A file never read by this session may still be created.
const fresh = join(ws1, 'fresh.txt')
await write('write', { file_path: fresh, content: 'new' }, agentC)
check(readFileSync(fresh, 'utf8') === 'new', 'write without prior read is allowed')

// 7. Absent observation then another session creates the file -> refused.
const absent = join(ws1, 'absent.txt')
await recordRead(absent, agentA)
await write('write', { file_path: absent, content: 'theirs' }, agentB)
let createRejected = false
try {
  await attemptWrite('write', { file_path: absent, content: 'mine' }, agentA)
} catch (error) {
  createRejected = /状态已变化/.test(String(error?.message))
}
check(createRejected, 'create after another session created the file is refused')

const db = new DatabaseConstructor(dbPath, { readonly: true })
const rows = db
  .prepare('SELECT rule_id, verdict, COUNT(*) AS n FROM decisions GROUP BY rule_id, verdict ORDER BY rule_id')
  .all()
db.close()
const decisions = JSON.stringify(rows)
check(
  rows.some((row) => row.rule_id === 'workspace-conflict' && row.n >= 1) &&
    rows.some((row) => row.rule_id === 'workspace-conflict-repeat' && row.n >= 1),
  'conflicts recorded in decisions',
  decisions,
)

rmSync(root, { recursive: true, force: true })
console.log(fail === 0 ? `ALL ${pass} PASS` : `${fail} FAILED`)
process.exitCode = fail === 0 ? 0 : 1
