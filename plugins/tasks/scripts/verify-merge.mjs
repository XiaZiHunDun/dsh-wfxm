/**
 * B4-b merge / release / prune verification (slice V, Phase 2).
 *
 * Real git repositories and a real task store: the merge path runs `git merge`
 * for real, so conflicts, cleanup and the "already released" edge are observed
 * on disk instead of mocked.
 *
 *   node plugins/tasks/scripts/verify-merge.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createIsolationResolver,
  createIsolationService,
  createTaskStore,
  realRun,
} from '../lib/index.js'

let pass = 0
let fail = 0
const roots = []
let store = null

async function check(name, fn) {
  try {
    const detail = await fn()
    pass += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `wfxm-merge-${label}-`))
  roots.push(dir)
  return dir
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'wfxm-test',
      GIT_AUTHOR_EMAIL: 'wfxm@test',
      GIT_COMMITTER_NAME: 'wfxm-test',
      GIT_COMMITTER_EMAIL: 'wfxm@test',
    },
  })
}

function gitFails(cwd, args) {
  try {
    git(cwd, args)
    return false
  } catch {
    return true
  }
}

function makeRepo(label, content = 'base\n') {
  const dir = tempDir(label)
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'app.txt'), content)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

function makeProject(id, root) {
  return {
    id,
    name: id,
    rootPath: root,
    vcs: 'git',
    prepareCmd: null,
    worktreeRoot: null,
    mergeMode: 'manual',
  }
}

function commitFile(cwd, name, content, message) {
  writeFileSync(join(cwd, name), content)
  git(cwd, ['add', name])
  git(cwd, ['commit', '-q', '-m', message])
}

async function worktreeTask(projectId, resolver, project, intent = 'edit app') {
  const task = store.createTask({ intent, riskLevel: 'R0', projectId })
  const cwd = await resolver(task, project, project.rootPath)
  return { task, cwd }
}

function succeed(taskId) {
  // L0: `running` is entered only through `claimTask`.
  const claimed = store.claimTask({ owner: 'verify-merge', leaseMs: 60_000, taskId })
  if (claimed === null) throw new Error(`task ${taskId} is not claimable`)
  store.transition(taskId, { to: 'succeeded', summary: 'done' })
}

const dbDir = tempDir('db')
store = createTaskStore(join(dbDir, 'ops.sqlite'))
const resolver = createIsolationResolver({ tasks: store })
const service = createIsolationService({ tasks: store })

await check('合并成功：目标分支落地、merged、worktree/分支清理，任务仍是 succeeded', async () => {
  const root = makeRepo('ok')
  const project = makeProject('ok', root)
  const { task, cwd } = await worktreeTask('ok', resolver, project)
  commitFile(cwd, 'app.txt', 'from task\n', 'task change')
  succeed(task.id)

  const result = await service.merge(task.id, project)
  const saved = store.getTask(task.id)
  assert.equal(result.state, 'merged')
  assert.equal(readFileSync(join(root, 'app.txt'), 'utf8'), 'from task\n')
  assert.equal(saved.mergeState, 'merged')
  assert.equal(saved.status, 'succeeded')
  assert.equal(existsSync(cwd), false)
  assert.equal(git(root, ['branch', '--list', saved.branch]).trim(), '')
  return `${saved.branch} → main`
})

await check('合并期间持有 git:<root> 租约，结束后释放', async () => {
  const root = makeRepo('git-lock')
  const project = makeProject('git-lock', root)
  const { task, cwd } = await worktreeTask('git-lock', resolver, project)
  commitFile(cwd, 'app.txt', 'locked\n', 'task change')
  succeed(task.id)
  const key = `git:${root}`
  let observed = false
  const observing = createIsolationService({
    tasks: store,
    run: (command, args, opts) => {
      if (command === 'git' && args.includes('merge') && !args.includes('--abort')) {
        observed = store.listResourceLocks()
          .some((lock) => lock.resourceKey === key && lock.taskId === task.id)
      }
      return realRun(command, args, opts)
    },
  })
  const result = await observing.merge(task.id, project)
  assert.equal(result.state, 'merged')
  assert.equal(observed, true, 'git lease must be live during git merge')
  assert.equal(store.listResourceLocks().filter((lock) => lock.resourceKey === key).length, 0)
  return 'leased and released'
})

await check('同仓库被其它任务占住时等待到超时报 conflict，释放后可合并', async () => {
  const root = makeRepo('git-busy')
  const project = makeProject('git-busy', root)
  const { task, cwd } = await worktreeTask('git-busy', resolver, project)
  commitFile(cwd, 'app.txt', 'busy\n', 'task change')
  succeed(task.id)

  const holder = store.createTask({ intent: 'git lock holder', riskLevel: 'R0' })
  const key = `git:${root}`
  assert.equal(store.acquireResourceLocks({ taskId: holder.id, keys: [key], ttlSec: 60 }).acquired.length, 1)

  const busy = createIsolationService({ tasks: store, lockTimeoutMs: 200 })
  await assert.rejects(
    () => busy.merge(task.id, project),
    (error) => error.code === 'conflict',
  )
  assert.equal(store.getTask(task.id).mergeState, 'none')

  store.releaseTaskResourceLocks(holder.id)
  const result = await service.merge(task.id, project)
  assert.equal(result.state, 'merged')
  assert.equal(store.listResourceLocks().filter((lock) => lock.resourceKey === key).length, 0)
  return 'waited then merged'
})

await check('重复合并：第二次 invalid-task，不产生第二个 merge', async () => {
  const root = makeRepo('again')
  const project = makeProject('again', root)
  const { task, cwd } = await worktreeTask('again', resolver, project)
  commitFile(cwd, 'app.txt', 'once\n', 'task change')
  succeed(task.id)
  await service.merge(task.id, project)
  await assert.rejects(
    () => service.merge(task.id, project),
    (error) => error.code === 'invalid-task',
  )
  assert.equal(store.getTask(task.id).mergeState, 'merged')
  return 'rejected'
})

const conflictRepo = makeRepo('conflict')
const conflictProject = makeProject('conflict', conflictRepo)
const conflictA = await worktreeTask('conflict', resolver, conflictProject, 'change app A')
const conflictB = await worktreeTask('conflict', resolver, conflictProject, 'change app B')
commitFile(conflictA.cwd, 'app.txt', 'A wins\n', 'A')
commitFile(conflictB.cwd, 'app.txt', 'B wins\n', 'B')
succeed(conflictA.task.id)
succeed(conflictB.task.id)
await service.merge(conflictA.task.id, conflictProject)

await check('冲突：merge_state=conflict、冲突路径非空、MERGE_HEAD 已清、任务状态不变', async () => {
  const result = await service.merge(conflictB.task.id, conflictProject)
  const saved = store.getTask(conflictB.task.id)
  assert.equal(result.state, 'conflict')
  assert.deepEqual(result.conflictPaths, ['app.txt'])
  assert.equal(saved.mergeState, 'conflict')
  assert.equal(saved.status, 'succeeded')
  assert.equal(git(conflictRepo, ['status', '--porcelain', '--untracked-files=no']).trim(), '')
  assert.equal(gitFails(conflictRepo, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']), true)
  return result.conflictPaths.join(',')
})

await check('冲突解决后重试：同一任务可再次合并', async () => {
  const cwd = store.getTask(conflictB.task.id).worktreePath
  assert.equal(gitFails(cwd, ['merge', 'main', '-m', 'sync main']), true)
  writeFileSync(join(cwd, 'app.txt'), 'A and B\n')
  git(cwd, ['add', 'app.txt'])
  git(cwd, ['commit', '-q', '-m', 'resolve'])
  const result = await service.merge(conflictB.task.id, conflictProject)
  assert.equal(result.state, 'merged')
  assert.equal(store.getTask(conflictB.task.id).mergeState, 'merged')
  return 'merged after resolve'
})

await check('worktree 有未提交改动：拒绝合并，状态保持 none', async () => {
  const root = makeRepo('dirty-wt')
  const project = makeProject('dirty-wt', root)
  const { task, cwd } = await worktreeTask('dirty-wt', resolver, project)
  writeFileSync(join(cwd, 'app.txt'), 'uncommitted\n')
  succeed(task.id)
  await assert.rejects(
    () => service.merge(task.id, project),
    (error) => error.code === 'conflict',
  )
  assert.equal(store.getTask(task.id).mergeState, 'none')
  return 'refused'
})

await check('主仓库脏：拒绝合并，状态保持 none', async () => {
  const root = makeRepo('dirty-main')
  const project = makeProject('dirty-main', root)
  const { task, cwd } = await worktreeTask('dirty-main', resolver, project)
  commitFile(cwd, 'app.txt', 'task\n', 'task change')
  succeed(task.id)
  writeFileSync(join(root, 'app.txt'), 'local edit\n')
  await assert.rejects(
    () => service.merge(task.id, project),
    (error) => error.code === 'conflict',
  )
  assert.equal(store.getTask(task.id).mergeState, 'none')
  return 'refused'
})

await check('分支缺失：not-found，不重建', async () => {
  const root = makeRepo('gone')
  const project = makeProject('gone', root)
  const { task, cwd } = await worktreeTask('gone', resolver, project)
  commitFile(cwd, 'app.txt', 'gone\n', 'task change')
  succeed(task.id)
  const branch = store.getTask(task.id).branch
  git(root, ['worktree', 'remove', '--force', cwd])
  git(root, ['branch', '-D', branch])
  await assert.rejects(
    () => service.merge(task.id, project),
    (error) => error.code === 'not-found',
  )
  assert.equal(git(root, ['branch', '--list', branch]).trim(), '')
  return 'missing'
})

await check('release 幂等：第二次 alreadyReleased，merge_state 保持 abandoned', async () => {
  const root = makeRepo('release')
  const project = makeProject('release', root)
  const { task, cwd } = await worktreeTask('release', resolver, project)
  succeed(task.id)
  const first = await service.release(task.id, 'failed', project)
  assert.equal(first.alreadyReleased, false)
  assert.equal(first.removedWorktree, true)
  assert.equal(store.getTask(task.id).mergeState, 'abandoned')
  assert.equal(existsSync(cwd), false)
  const second = await service.release(task.id, 'failed', project)
  assert.equal(second.alreadyReleased, true)
  assert.equal(store.getTask(task.id).mergeState, 'abandoned')
  return 'idempotent'
})

await check('prune：超期终态删除并 abandoned，未超期/冲突态不动，dry-run 不改库', async () => {
  const root = makeRepo('prune')
  const project = makeProject('prune', root)
  const old = await worktreeTask('prune', resolver, project, 'old work')
  succeed(old.task.id)
  const held = await worktreeTask('prune', resolver, project, 'held for owner')
  succeed(held.task.id)
  store.setIsolation(held.task.id, { mergeState: 'pending' })
  store.setIsolation(held.task.id, { mergeState: 'conflict' })

  const future = createIsolationService({ tasks: store, now: () => new Date(Date.now() + 8 * 86_400_000) })
  const dry = await future.prune(project, { olderThanMs: 7 * 86_400_000, dryRun: true })
  assert.ok(dry.candidates.some((task) => task.id === old.task.id))
  assert.equal(dry.candidates.some((task) => task.id === held.task.id), false)
  assert.equal(existsSync(old.cwd), true)
  assert.equal(store.getTask(old.task.id).mergeState, 'none')

  const real = await future.prune(project, { olderThanMs: 7 * 86_400_000 })
  assert.deepEqual(real.failed, [])
  assert.ok(real.removed.includes(old.task.id))
  assert.equal(existsSync(old.cwd), false)
  assert.equal(store.getTask(old.task.id).mergeState, 'abandoned')
  assert.equal(existsSync(held.cwd), true)

  const fresh = await worktreeTask('prune', resolver, project, 'fresh work')
  succeed(fresh.task.id)
  const recent = await service.prune(project, { olderThanMs: 7 * 86_400_000 })
  assert.equal(recent.candidates.some((task) => task.id === fresh.task.id), false)
  assert.equal(existsSync(fresh.cwd), true)
  return `removed ${real.removed.length}`
})

await check('非法 merge 迁移与 serial 合并状态被拒', async () => {
  const root = makeRepo('state')
  const project = makeProject('state', root)
  const { task } = await worktreeTask('state', resolver, project)
  succeed(task.id)
  assert.throws(
    () => store.setIsolation(task.id, { mergeState: 'merged' }),
    (error) => error.code === 'invalid-task',
  )
  store.setIsolation(task.id, { mergeState: 'pending' })
  store.setIsolation(task.id, { mergeState: 'merged' })
  assert.throws(
    () => store.setIsolation(task.id, { mergeState: 'pending' }),
    (error) => error.code === 'invalid-task',
  )
  const serial = store.createTask({ intent: 'serial work', riskLevel: 'R0', projectId: 'state' })
  assert.throws(
    () => store.setIsolation(serial.id, { mergeState: 'abandoned' }),
    (error) => error.code === 'invalid-task',
  )
  await assert.rejects(
    () => service.merge(serial.id, project),
    (error) => error.code === 'invalid-task',
  )
  return 'rejected'
})

store.close()
for (const root of roots) rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
