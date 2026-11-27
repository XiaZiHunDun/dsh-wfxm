/**
 * B4-b isolation verification (slice U): the resolver decides the write unit
 * before the executor spawns, so these cases use real git repositories and a
 * real task store instead of mocking the lifecycle.
 *
 *   node plugins/tasks/scripts/verify-isolation.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '@dsh-wfxm/knowledge'
import { createIsolationResolver, createTaskStore } from '../lib/index.js'

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
  const dir = mkdtempSync(join(tmpdir(), `wfxm-isolation-${label}-`))
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

function makeRepo(label) {
  const dir = tempDir(label)
  git(dir, ['init', '-q'])
  writeFileSync(join(dir, 'app.txt'), 'base\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

function makeProject(root, extra = {}) {
  return {
    id: 'p1',
    name: 'demo',
    rootPath: root,
    vcs: 'git',
    prepareCmd: null,
    worktreeRoot: null,
    ...extra,
  }
}

const dbDir = tempDir('db')
store = createTaskStore(join(dbDir, 'ops.sqlite'))
const resolver = createIsolationResolver({ tasks: store })

await check('⑥ 项目登记：git 目录自动识别为 vcs=git，普通目录为 none', () => {
  const memoryDir = tempDir('memory')
  const memory = createMemoryStore(join(memoryDir, 'ops.sqlite'))
  try {
    const gitRepo = makeRepo('detect-git')
    const plain = tempDir('detect-plain')
    assert.equal(memory.upsertProject({ name: 'git-project', rootPath: gitRepo }).vcs, 'git')
    assert.equal(memory.upsertProject({ name: 'plain-project', rootPath: plain }).vcs, 'none')
    const updated = memory.upsertProject({ name: 'git-project', rootPath: gitRepo, prepareCmd: 'npm ci' })
    assert.equal(updated.prepareCmd, 'npm ci')
    assert.equal(updated.mergeMode, 'manual')
    return 'git/none + prepareCmd'
  } finally {
    memory.close()
  }
})

await check('非 git 项目：留在 workspace 根，任务记为 serial', async () => {
  const root = tempDir('plain')
  const task = store.createTask({ intent: 'touch a file', riskLevel: 'R0', projectId: 'p1' })
  const cwd = await resolver(task, makeProject(root, { vcs: 'none' }), root)
  assert.equal(cwd, root)
  assert.equal(store.getTask(task.id).isolation, 'serial')
  assert.equal(existsSync(join(root, '.agents')), false)
  return 'serial'
})

await check('交付物在共享 workspace：不建 worktree，cwd 就是共享 workspace（切片 AH）', async () => {
  const root = makeRepo('shared-write')
  const shared = tempDir('shared')
  const task = store.createTask({ intent: 'write a file', riskLevel: 'R2', projectId: 'p1' })
  store.addAssertion(task.id, { kind: 'file_exists', spec: { path: join(shared, 'r2-demo.txt') } })
  const cwd = await resolver(store.getTask(task.id), makeProject(root), shared)
  assert.equal(cwd, shared)
  assert.equal(store.getTask(task.id).isolation, 'serial')
  assert.equal(existsSync(join(root, '.agents')), false)
  return 'shared workspace'
})

await check('交付物在共享 workspace 之外：仍走 worktree（切片 AH 只放行共享根）', async () => {
  const root = makeRepo('shared-outside')
  const shared = tempDir('shared-outside-root')
  const elsewhere = tempDir('elsewhere')
  const task = store.createTask({ intent: 'write a file', riskLevel: 'R2', projectId: 'p1' })
  store.addAssertion(task.id, { kind: 'file_exists', spec: { path: join(elsewhere, 'out.txt') } })
  const cwd = await resolver(store.getTask(task.id), makeProject(root), shared)
  assert.notEqual(cwd, shared)
  assert.equal(store.getTask(task.id).isolation, 'worktree')
  return 'worktree'
})

await check('git 干净仓库：建 worktree + 分支，字段落库且 cwd 指向 worktree', async () => {
  const root = makeRepo('wt')
  const project = makeProject(root)
  const task = store.createTask({ intent: 'edit app', riskLevel: 'R0', projectId: 'p1' })
  const cwd = await resolver(task, project, root)
  const saved = store.getTask(task.id)
  assert.notEqual(cwd, root)
  assert.equal(cwd, join(root, '.agents', 'worktrees', saved.taskRef))
  assert.ok(existsSync(join(cwd, 'app.txt')), 'worktree misses tracked files')
  assert.equal(saved.isolation, 'worktree')
  assert.equal(saved.worktreePath, cwd)
  assert.equal(saved.branch, `wfxm/${saved.taskRef}`)
  assert.equal(saved.baseCommit, git(root, ['rev-parse', 'HEAD']).trim())
  assert.equal(saved.prepareState, 'none')
  assert.equal(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), saved.branch)
  return `${saved.branch} @ ${saved.baseCommit.slice(0, 12)}`
})

await check('同仓库两任务：各自 worktree，一侧写入不污染另一侧与 workspace 根', async () => {
  const root = makeRepo('parallel')
  const project = makeProject(root)
  const first = store.createTask({ intent: 'change app.txt', riskLevel: 'R0', projectId: 'p1' })
  const second = store.createTask({ intent: 'change app.txt', riskLevel: 'R0', projectId: 'p1' })
  const cwdA = await resolver(first, project, root)
  const cwdB = await resolver(second, project, root)
  assert.notEqual(cwdA, cwdB)
  writeFileSync(join(cwdA, 'app.txt'), 'from A\n')
  assert.equal(readFileSync(join(cwdB, 'app.txt'), 'utf8'), 'base\n')
  assert.equal(readFileSync(join(root, 'app.txt'), 'utf8'), 'base\n')
  return '2 worktrees'
})

await check('工作区不干净：降级 serial，不建 worktree', async () => {
  const root = makeRepo('dirty')
  writeFileSync(join(root, 'app.txt'), 'dirty\n')
  const task = store.createTask({ intent: 'edit app', riskLevel: 'R0', projectId: 'p1' })
  const cwd = await resolver(task, makeProject(root), root)
  assert.equal(cwd, root)
  assert.equal(store.getTask(task.id).isolation, 'serial')
  assert.equal(existsSync(join(root, '.agents', 'worktrees')), false)
  return 'serial'
})

await check('prepare_cmd 只跑一次，成功后记录 done + preparedAt', async () => {
  const root = makeRepo('prepare')
  const project = makeProject(root, { prepareCmd: 'echo prepared >> prepared.log' })
  const task = store.createTask({ intent: 'edit app', riskLevel: 'R0', projectId: 'p1' })
  const cwd = await resolver(task, project, root)
  assert.equal(readFileSync(join(cwd, 'prepared.log'), 'utf8'), 'prepared\n')
  let saved = store.getTask(task.id)
  assert.equal(saved.prepareState, 'done')
  assert.notEqual(saved.preparedAt, null)
  const again = await resolver(saved, project, root)
  assert.equal(again, cwd)
  assert.equal(readFileSync(join(cwd, 'prepared.log'), 'utf8'), 'prepared\n', 'prepare ran twice')
  saved = store.getTask(task.id)
  assert.equal(saved.prepareState, 'done')
  return 'once'
})

await check('prepare 不继承服务进程的 NODE_ENV=production', async () => {
  const root = makeRepo('prepare-node-env')
  const project = makeProject(root, {
    prepareCmd: `node -e "require('fs').writeFileSync('node-env.txt', process.env.NODE_ENV ?? 'unset')"`,
  })
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const task = store.createTask({ intent: 'prepare env', riskLevel: 'R0', projectId: 'p1' })
    const cwd = await resolver(task, project, root)
    // 继承 production 会让 pnpm/npm 跳过 devDependencies，worktree 里 tsc 缺失。
    assert.equal(readFileSync(join(cwd, 'node-env.txt'), 'utf8'), 'unset')
    return 'node_env unset'
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

await check('prepare 失败：任务失败且不回落共享 workspace', async () => {
  const root = makeRepo('prepare-fail')
  const project = makeProject(root, { prepareCmd: 'echo boom >&2; exit 7' })
  const task = store.createTask({ intent: 'edit app', riskLevel: 'R0', projectId: 'p1' })
  await assert.rejects(() => resolver(task, project, root), /prepare failed \(exit 7\)/)
  assert.equal(store.getTask(task.id).prepareState, 'failed')
  await assert.rejects(() => resolver(store.getTask(task.id), project, root), /failed prepare/)
  return 'failed loudly'
})

await check('worktree 目录丢失：拒绝重建（base_commit 漂移）', async () => {
  const root = makeRepo('missing')
  const project = makeProject(root)
  const task = store.createTask({ intent: 'edit app', riskLevel: 'R0', projectId: 'p1' })
  const cwd = await resolver(task, project, root)
  rmSync(cwd, { recursive: true, force: true })
  await assert.rejects(() => resolver(store.getTask(task.id), project, root), /is missing; not recreating/)
  return 'refused'
})

await check('worktreeRoot 越出项目根：拒绝', async () => {
  const root = makeRepo('escape')
  const outside = tempDir('outside')
  const task = store.createTask({ intent: 'edit app', riskLevel: 'R0', projectId: 'p1' })
  await assert.rejects(
    () => resolver(task, makeProject(root, { worktreeRoot: outside }), root),
    /escapes project root/,
  )
  return 'refused'
})

await check('没有项目：回落到宿主默认工作目录', async () => {
  const fallback = tempDir('fallback')
  const task = store.createTask({ intent: 'no project', riskLevel: 'R0' })
  const cwd = await resolver(task, null, fallback)
  assert.equal(cwd, fallback)
  assert.equal(store.getTask(task.id).isolation, 'serial')
  return 'fallback'
})

for (const dir of roots) rmSync(dir, { recursive: true, force: true })
store.close()
console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
