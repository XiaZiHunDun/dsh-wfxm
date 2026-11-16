import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseConstructor from 'better-sqlite3'
import {
  DEFAULT_SNAPSHOT_KEEP,
  SNAPSHOT_TIMEOUT_MS,
  SnapshotError,
  capturePreimage,
  captureWorkspace,
  createPreimageRollbackPort,
  createSnapshotPort,
  createSnapshotStore,
  restorePreimage,
  restoreWorkspace,
  rollbackPreimages,
  scanWorkspace,
} from '../lib/index.js'
import { createTaskStore, createTaskWorker, prepareAssertions } from '@dsh-wfxm/tasks'

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

const dir = mkdtempSync(join(tmpdir(), 'snapshot-'))
const dbPath = join(dir, 'ops.sqlite')
const store = createSnapshotStore(dbPath)
const snapshotDir = join(dir, 'snapshots')
const workspace = join(dir, 'ws')
mkdirSync(join(workspace, 'src'), { recursive: true })
writeFileSync(join(workspace, 'src', 'app.js'), 'console.log("v1")\n')
writeFileSync(join(workspace, 'README.md'), '# demo\n')
mkdirSync(join(workspace, 'node_modules', 'dep'), { recursive: true })
writeFileSync(join(workspace, 'node_modules', 'dep', 'index.js'), 'ignored\n')

// ---- schema -----------------------------------------------------------------

await check('migration creates snapshots + file_preimages at v1', () => {
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  const version = db.prepare("SELECT version FROM schema_migrations WHERE module = 'snapshot'").get()
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name)
  db.close()
  return names.includes('snapshots')
    && names.includes('file_preimages')
    && version.version === 1
    && indexes.includes('ux_snapshots_content')
    && indexes.includes('ux_file_preimages_call')
    && DEFAULT_SNAPSHOT_KEEP === 100
    && SNAPSHOT_TIMEOUT_MS === 10_000
})

await check('a locator that cannot restore is refused at write time', () => {
  assert.throws(
    () => store.createSnapshot({ locator: 'manifest:abc' }),
    (error) => error instanceof SnapshotError && error.code === 'invalid-input',
  )
  const ok = store.createSnapshot({ locator: `dir:${join(dir, 'x')}` })
  return ok.kind === 'workspace' && ok.refCount === 0
})

// ---- 粒度一：文件级前镜像 -----------------------------------------------------

await check('a present pre-image restores the previous bytes', () => {
  const target = join(workspace, 'src', 'app.js')
  const preimage = capturePreimage({
    store,
    root: workspace,
    path: 'src/app.js',
    toolCallId: 'call_1',
  })
  writeFileSync(target, 'console.log("broken")\n')
  const restored = restorePreimage({ preimage, root: workspace })
  return preimage.state === 'present'
    && preimage.contentRef.startsWith('inline:')
    && preimage.sha256 !== null
    && restored.state === 'present'
    && readFileSync(target, 'utf8') === 'console.log("v1")\n'
})

await check('an absent tombstone deletes the path on restore', () => {
  const target = join(workspace, 'src', 'new.js')
  const preimage = capturePreimage({
    store,
    root: workspace,
    path: 'src/new.js',
    toolCallId: 'call_2',
  })
  writeFileSync(target, 'created by the agent\n')
  const restored = restorePreimage({ preimage, root: workspace })
  return preimage.state === 'absent'
    && preimage.contentRef === null
    && restored.state === 'absent'
    && !existsSync(target)
})

await check('content above the inline limit is spilled and still restorable', () => {
  const target = join(workspace, 'big.txt')
  const body = 'x'.repeat(64)
  writeFileSync(target, body)
  const preimage = capturePreimage({
    store,
    root: workspace,
    path: 'big.txt',
    toolCallId: 'call_3',
    inlineLimit: 16,
    contentDir: join(dir, 'spill'),
  })
  writeFileSync(target, 'clobbered')
  restorePreimage({ preimage, root: workspace })
  return preimage.contentRef.startsWith('file:')
    && preimage.sizeBytes === 64
    && readFileSync(target, 'utf8') === body
})

await check('the same tool call cannot overwrite its own pre-image', () => {
  const target = join(workspace, 'twice.txt')
  writeFileSync(target, 'original')
  const first = capturePreimage({
    store,
    root: workspace,
    path: 'twice.txt',
    toolCallId: 'call_4',
  })
  writeFileSync(target, 'already damaged')
  const second = capturePreimage({
    store,
    root: workspace,
    path: 'twice.txt',
    toolCallId: 'call_4',
  })
  restorePreimage({ preimage: second, root: workspace })
  return first.id === second.id
    && second.sha256 === first.sha256
    && readFileSync(target, 'utf8') === 'original'
})

await check('task rollback undoes pre-images newest-first', () => {
  const a = join(workspace, 'a.txt')
  const b = join(workspace, 'b.txt')
  writeFileSync(a, 'a0')
  capturePreimage({ store, root: workspace, path: 'a.txt', toolCallId: 'call_5a', taskId: 'task_x' })
  writeFileSync(b, 'b0')
  capturePreimage({ store, root: workspace, path: 'b.txt', toolCallId: 'call_5b', taskId: 'task_x' })
  writeFileSync(a, 'a-broken')
  writeFileSync(b, 'b-broken')
  const undone = rollbackPreimages({ store, taskId: 'task_x', root: workspace })
  return undone.length === 2
    && undone[0].path.endsWith('b.txt')
    && readFileSync(a, 'utf8') === 'a0'
    && readFileSync(b, 'utf8') === 'b0'
})

// ---- 粒度二：工作区级 ---------------------------------------------------------

await check('a workspace capture records a self-contained dir locator and manifest', () => {
  const { snapshot, scan } = captureWorkspace({ store, root: workspace, snapshotDir })
  const copy = snapshot.locator.slice('dir:'.length)
  return snapshot.kind === 'workspace'
    && snapshot.locator.startsWith('dir:')
    && snapshot.baselineRef === scan.manifest
    && snapshot.baselineRef.startsWith('manifest:')
    && snapshot.sizeBytes === scan.sizeBytes
    && scan.files.some((file) => file.rel === 'src/app.js')
    && !scan.files.some((file) => file.rel.startsWith('node_modules'))
    && existsSync(join(copy, 'src', 'app.js'))
    && readFileSync(join(copy, 'src', 'app.js'), 'utf8') === readFileSync(join(workspace, 'src', 'app.js'), 'utf8')
})

await check('capturing an empty workspace yields an empty dir snapshot', () => {
  const empty = join(dir, 'empty-ws')
  mkdirSync(empty, { recursive: true })
  const { snapshot, scan } = captureWorkspace({
    store,
    root: empty,
    snapshotDir: join(dir, 'snapshots-empty'),
  })
  const copy = snapshot.locator.slice('dir:'.length)
  return scan.files.length === 0 && existsSync(copy) && snapshot.sizeBytes === 0
})

await check('restoring a checkpoint rewrites files and reports extras', () => {
  const { snapshot } = captureWorkspace({ store, root: workspace, snapshotDir })
  writeFileSync(join(workspace, 'src', 'app.js'), 'broken')
  writeFileSync(join(workspace, 'late.txt'), 'not in the snapshot')
  const result = restoreWorkspace({ root: workspace, locator: snapshot.locator })
  return readFileSync(join(workspace, 'src', 'app.js'), 'utf8').includes('v1')
    && result.restored.includes('src/app.js')
    && result.extra.includes('late.txt')
    && existsSync(join(workspace, 'late.txt'))
})

await check('a mutation during capture is refused, not silently recorded', () => {
  let mutated = false
  const capture = () => captureWorkspace({
    store,
    root: workspace,
    snapshotDir,
    onFirstScan: () => {
      if (mutated) return
      mutated = true
      writeFileSync(join(workspace, 'src', 'app.js'), 'changed mid-capture')
    },
  })
  assert.throws(
    capture,
    (error) => error instanceof SnapshotError && error.code === 'concurrent-mutation',
  )
  writeFileSync(join(workspace, 'src', 'app.js'), 'console.log("v1")\n')
  return mutated
})

await check('an expired deadline refuses the capture', () => {
  assert.throws(
    () => captureWorkspace({ store, root: workspace, snapshotDir, timeoutMs: -1 }),
    (error) => error instanceof SnapshotError && error.code === 'snapshot-timeout',
  )
  return true
})

await check('only dir: locators can be restored by this adapter', () => {
  assert.throws(
    () => restoreWorkspace({ root: workspace, locator: 'restic:abc:/srv/app' }),
    (error) => error instanceof SnapshotError && error.code === 'not-supported',
  )
  return true
})

await check('manifest changes when a file changes', () => {
  const before = scanWorkspace(workspace).manifest
  writeFileSync(join(workspace, 'src', 'app.js'), 'console.log("v2")\n')
  const after = scanWorkspace(workspace).manifest
  writeFileSync(join(workspace, 'src', 'app.js'), 'console.log("v1")\n')
  return before !== after
})

// ---- 去重 / 引用计数 / 保留 ---------------------------------------------------

await check('identical content is stored once and reference-counted', () => {
  const one = store.createSnapshot({ locator: `dir:${join(dir, 'one')}`, contentKey: 'blob:abc' })
  const two = store.createSnapshot({ locator: `dir:${join(dir, 'two')}`, contentKey: 'blob:abc' })
  const released = store.releaseSnapshot(two.id)
  return one.id === two.id
    && two.refCount === 1
    && released.refCount === 0
    && released.locator === one.locator
})

await check('pruning keeps the newest N per kind and returns the doomed ids', () => {
  const pruneStore = createSnapshotStore(join(dir, 'prune.sqlite'))
  const base = Date.parse('2026-11-09T00:00:00.000Z')
  for (let index = 0; index < 4; index++) {
    pruneStore.createSnapshot({
      locator: `dir:${join(dir, `p${index}`)}`,
      createdAt: new Date(base + index * 1000),
    })
  }
  const doomed = pruneStore.pruneSnapshots({ keep: 2 })
  const left = pruneStore.listSnapshots()
  pruneStore.close()
  return doomed.length === 2
    && left.length === 2
    && left[0].locator.endsWith('p3')
})

await check('the rollback port restores one step and leaves other steps alone', async () => {
  const store = createSnapshotStore(join(dir, 'rollback.sqlite'))
  const first = join(dir, 'step-a.conf')
  const second = join(dir, 'step-b.conf')
  writeFileSync(first, 'a0')
  writeFileSync(second, 'b0')
  capturePreimage({ store, path: first, toolCallId: 'rb-1', taskId: 't-rb', checkpointId: 'cp-1' })
  capturePreimage({ store, path: second, toolCallId: 'rb-2', taskId: 't-rb', checkpointId: 'cp-2' })
  writeFileSync(first, 'a1')
  writeFileSync(second, 'b1')

  const port = createPreimageRollbackPort(store)
  const oneStep = port.rollback({ taskId: 't-rb', checkpointId: 'cp-2' })
  const afterStep = [readFileSync(first, 'utf8'), readFileSync(second, 'utf8')]
  const whole = port.rollback({ taskId: 't-rb' })
  const afterTask = [readFileSync(first, 'utf8'), readFileSync(second, 'utf8')]
  store.close()
  return oneStep.length === 1 && oneStep[0].path === second
    && afterStep[0] === 'a1' && afterStep[1] === 'b0'
    && whole.length === 2
    && afterTask[0] === 'a0' && afterTask[1] === 'b0'
})

// ---- ⑤ 的 SnapshotPort（跨模块） ----------------------------------------------

await check('the port refuses a task whose project has no workspace root', async () => {
  const port = createSnapshotPort({
    store,
    snapshotDir,
    resolveRoot: () => null,
  })
  await assert.rejects(
    () => port.capture({ id: 'task_none', projectId: 'proj_missing' }),
    (error) => error instanceof SnapshotError && error.code === 'not-found',
  )
  return true
})

await check('an R3 task runs only after a real capture (⑤ ↔ ⑦)', async () => {
  const taskStore = createTaskStore(join(dir, 'tasks.sqlite'))
  const task = taskStore.createTask({
    intent: 'restart the app service',
    riskLevel: 'R3',
    projectId: 'proj_alpha',
  })
  // R3 must carry executable criteria: the worker now refuses completion when
  // the Verifier has nothing to check (17 §8.4).
  const marker = join(workspace, 'r3-marker.txt')
  writeFileSync(marker, 'ok')
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: marker }])) {
    taskStore.addAssertion(task.id, prepared)
  }
  const port = createSnapshotPort({
    store,
    snapshotDir: join(dir, 'task-snapshots'),
    resolveRoot: (projectId) => (projectId === 'proj_alpha' ? workspace : null),
  })
  let executed = false
  const worker = createTaskWorker({
    store: taskStore,
    snapshot: port,
    execute: () => {
      executed = true
      return { status: 'succeeded', summary: 'done' }
    },
  })
  const report = await worker.runOnce()
  const finished = taskStore.getTask(task.id)
  const shots = store.listSnapshots({ kind: 'task' })
  const shot = shots[shots.length - 1]
  taskStore.close()
  return report.outcome === 'succeeded'
    && executed
    && finished.status === 'succeeded'
    && shots.length === 1
    && shot.locator.startsWith('dir:')
    && shot.baselineRef.startsWith('manifest:')
})

store.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
