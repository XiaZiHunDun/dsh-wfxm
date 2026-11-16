/**
 * Real smoke for 切片 B (manual, NOT part of verify): run one small task
 * through the whole chain against the real `dsh --profile headless`.
 *
 *   worker (⑤) → createDshExecutor → real dsh child → model writes hello.txt
 *   R3 snapshot gate (⑦ real port) → file_exists assertion
 *   env attribution → ④ in the child stamps file_preimages.task_id
 *
 * Needs: dsh on PATH, the headless profile's credentials plugin enabled
 * (~/.dsh/.credentials.yaml holds DEEPSEEK_API_KEY), and @dsh-wfxm/governance
 * mounted in the headless profile (it already is).
 *
 * Two databases on purpose: T1 (tasks + snapshots, parent side) and T2
 * (child-side audit/preimages via DSH_WFXM_AUDIT_DB) so the child's writes
 * never contend with the parent's lease heartbeats on one SQLite file.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTaskStore, createTaskWorker, evaluateAssertion, prepareAssertions } from '@dsh-wfxm/tasks'
import { createSnapshotPort, createSnapshotStore } from '@dsh-wfxm/snapshot'

const here = dirname(fileURLToPath(import.meta.url))
const { createDshExecutor } = await import(join(here, '..', 'lib', 'index.js'))

// ---- preconditions -----------------------------------------------------------

try {
  execFileSync('dsh', ['--version'], { stdio: 'pipe' })
} catch {
  console.error('SKIP: dsh binary not found on PATH')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'executor-smoke-'))
const workdir = join(dir, 'workspace')
const opsDb = join(dir, 'ops.sqlite') // T1: tasks + snapshots (parent)
const childDb = join(dir, 'child.sqlite') // T2: audit + preimages (child)
const snapshotDir = join(dir, 'snapshots')
const preimageDir = join(dir, 'preimage-content')
const policyFile = join(dir, 'policy.yaml')
const helloFile = join(workdir, 'hello.txt')

mkdirSync(workdir, { recursive: true })
// ⑦'s captureWorkspace cannot freeze an EMPTY directory (its tmp copy is only
// created while copying files); a .gitkeep mirrors a real, non-empty worktree.
writeFileSync(join(workdir, '.gitkeep'), '')
writeFileSync(
  policyFile,
  [
    'version: 1',
    'killSwitchFile: KILL',
    'writeRoots:',
    `  - ${workdir}`,
    'readRoots:',
    `  - ${workdir}`,
    'preimages:',
    '  enabled: true',
    `  roots:`,
    `    - ${workdir}`,
    '  inlineLimit: 1048576',
    `  contentDir: ${preimageDir}`,
    'bash:',
    '  denyPatterns: []',
    '',
  ].join('\n'),
)

const taskStore = createTaskStore(opsDb)
const snapshotStore = createSnapshotStore(opsDb)
const snapshot = createSnapshotPort({
  store: snapshotStore,
  snapshotDir,
  resolveRoot: () => workdir,
})

const task = taskStore.createTask({
  intent: [
    `Create a file at the absolute path ${helloFile} whose entire content is exactly:`,
    'hello-wfxm',
    '',
    'Use the write tool with that absolute path. Do not create any other file.',
    'When done, reply with exactly: wrote hello.txt',
  ].join('\n'),
  riskLevel: 'R3',
  projectId: 'smoke-project',
})
const [assertion] = prepareAssertions([{ kind: 'file_exists', path: helloFile }], {
  allowedPaths: [workdir],
})
taskStore.addAssertion(task.id, assertion)

const execute = createDshExecutor({
  env: {
    DSH_WFXM_POLICY: policyFile,
    DSH_WFXM_AUDIT_DB: childDb,
  },
  timeoutMs: 300_000,
  heartbeatMs: 10_000,
  checkpoints: taskStore,
  workdirResolver: () => workdir,
  onError: (error) => console.error('[smoke] executor internal:', error),
})
const worker = createTaskWorker({
  store: taskStore,
  execute,
  snapshot,
  owner: 'smoke-worker',
  leaseMs: 120_000,
  heartbeatMs: 10_000,
})

console.log(`[smoke] workspace: ${workdir}`)
console.log(`[smoke] task ${task.id} (R3) — spawning the real dsh child…`)
const report = await worker.runOnce()
console.log(`[smoke] worker report: ${JSON.stringify(report)}`)

if (report.outcome === 'failed' && /MISSING_CREDENTIAL|no API key/i.test(
  taskStore.listReceipts(task.id)[0]?.summary ?? '',
)) {
  console.error('SKIP: model credentials unavailable (store DEEPSEEK_API_KEY in ~/.dsh/.credentials.yaml)')
  process.exit(2)
}

let failures = 0
const expect = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const settled = taskStore.getTask(task.id)
const receipts = taskStore.listReceipts(task.id)
expect('task succeeded', report.outcome === 'succeeded' && settled.status === 'succeeded')
expect('receipt written with a session locator', receipts.length === 1 && receipts[0].evidenceLocator?.startsWith('dsh-session:'))
expect('hello.txt exists with the requested content', existsSync(helloFile) && readFileSync(helloFile, 'utf8').includes('hello-wfxm'))

const assertionOutcome = await evaluateAssertion({ kind: 'file_exists', spec: { path: helloFile } })
expect('file_exists assertion passes', assertionOutcome.status === 'pass')

const snapshotEvent = taskStore.listEvents(task.id).find((event) => event.type === 'task.snapshot')
expect('R3 snapshot gate captured before execution', snapshotEvent !== undefined)

const checkpoints = taskStore.listCheckpoints(task.id)
expect('one committed checkpoint for the attempt', checkpoints.length === 1 && checkpoints[0].status === 'committed')

// The child's governance mount stamped pre-images from the env bridge.
const childStore = createSnapshotStore(childDb)
const preimages = childStore.listPreimages({ taskId: task.id })
childStore.close()
expect(
  'file_preimages carries task_id from DSH_WFXM_TASK_ID',
  preimages.length >= 1 && preimages.every((row) => row.taskId === task.id),
)
if (preimages.length > 0) {
  expect(
    'pre-image is bound to the attempt checkpoint and the target file',
    preimages[0].checkpointId === checkpoints[0]?.id && preimages[0].path === helloFile,
  )
  console.log(`[smoke] pre-image: ${JSON.stringify({
    path: preimages[0].path,
    state: preimages[0].state,
    taskId: preimages[0].taskId,
    checkpointId: preimages[0].checkpointId,
  })}`)
} else {
  console.log('[smoke] no pre-images recorded — the model did not use a write tool?')
}

taskStore.close()
snapshotStore.close()
rmSync(dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nsmoke: OK' : `\nsmoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
