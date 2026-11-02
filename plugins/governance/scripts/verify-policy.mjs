import DatabaseConstructor from 'better-sqlite3'
import { rmSync, writeFileSync } from 'node:fs'
import { apply } from '../lib/index.js'

const dbPath = '/tmp/dsh-wfxm-policy-test.sqlite'
rmSync(dbPath, { force: true })
rmSync(`${dbPath}-wal`, { force: true })
rmSync(`${dbPath}-shm`, { force: true })
process.env.DSH_WFXM_AUDIT_DB = dbPath

const listeners = new Map()
const ctx = {
  on(event, listener) {
    listeners.set(event, listener)
  },
  logger: { info() {}, warn() {}, error() {} },
}

apply(ctx)
const pre = listeners.get('tools/pre-execute')
if (!pre) throw new Error('tools/pre-execute listener not registered')

const cases = [
  { name: 'write', args: { path: '/home/ailearn/escape.txt' }, expect: 'deny' },
  { name: 'write', args: { path: '/home/ailearn/projects/dsh-wfxm/ok.txt' }, expect: 'allow' },
  { name: 'edit', args: { file_path: '/etc/passwd' }, expect: 'deny' },
  { name: 'read', args: { path: '/home/ailearn/.dsh/.credentials.yaml' }, expect: 'deny' },
  { name: 'read', args: { path: '/home/ailearn/githubpro/deepseek-harness/README.md' }, expect: 'allow' },
  { name: 'bash', args: { command: 'sudo systemctl restart nginx' }, expect: 'deny' },
  { name: 'bash', args: { command: 'rm -rf /home/ailearn/projects/dsh-wfxm/tmp' }, expect: 'allow' },
  { name: 'bash', args: { command: 'rm -rf /home/ailearn/data' }, expect: 'deny' },
  { name: 'glob', args: { pattern: '*.ts' }, expect: 'allow' },
]

let pass = 0
let fail = 0
for (const [index, item] of cases.entries()) {
  let nextCalled = false
  const decision = await pre(
    { callId: `call-${index + 1}`, name: item.name, arguments: item.args },
    async () => {
      nextCalled = true
      return { kind: 'allow' }
    },
  )
  const actual = nextCalled ? 'allow' : decision?.kind
  const ok = actual === item.expect
  if (ok) pass += 1
  else fail += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${item.name} ${JSON.stringify(item.args)} -> ${actual}` +
      (decision?.reason ? ` (${decision.reason})` : ''),
  )
}

writeFileSync('/home/ailearn/projects/dsh-wfxm/config/KILL', 'test\n')
let killNext = false
const kill = await pre(
  { callId: 'call-kill', name: 'read', arguments: { path: '/tmp/x' } },
  async () => {
    killNext = true
    return { kind: 'allow' }
  },
)
rmSync('/home/ailearn/projects/dsh-wfxm/config/KILL', { force: true })
const killOk = !killNext && kill?.kind === 'deny'
console.log(`${killOk ? 'PASS' : 'FAIL'} kill-switch -> ${killNext ? 'allow' : kill?.kind}`)
if (killOk) pass += 1
else fail += 1

const db = new DatabaseConstructor(dbPath, { readonly: true })
const rows = db.prepare('SELECT verdict, rule_id, COUNT(*) AS n FROM decisions GROUP BY verdict, rule_id ORDER BY verdict, rule_id').all()
const total = db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n
db.close()

console.log('decisions:', JSON.stringify(rows), 'total:', total)
console.log(fail === 0 ? `ALL ${pass} PASS` : `${fail} FAILED`)
process.exitCode = fail === 0 ? 0 : 1
