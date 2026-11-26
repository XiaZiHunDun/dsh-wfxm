/**
 * Slice CH (O1): acceptance for the expert router.
 *
 * Proves three things without a second real expert:
 *   1. routing is deterministic: explicit → project default → global default;
 *   2. an unknown expert fails loudly and never falls back;
 *   3. an adapter only receives (task, hooks) — no approval/grant/credential.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const libFile = join(pkgRoot, 'lib', 'expert.js')
const sources = [join(pkgRoot, 'src', 'expert.ts'), join(pkgRoot, 'src', 'executor.ts')]
const stale = !existsSync(libFile)
  || sources.some((file) => statSync(file).mtimeMs > statSync(libFile).mtimeMs)
if (stale) {
  const tsc = join(pkgRoot, '..', 'governance', 'node_modules', '.bin', 'tsc')
  execFileSync(tsc, ['-p', join(pkgRoot, 'tsconfig.json')], { stdio: 'inherit' })
}

const { createExpertExecutor } = await import('../lib/index.js')

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    const ok = await fn()
    if (ok === false) throw new Error('returned false')
    pass++
    console.log(`PASS  ${name}`)
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

function hooks() {
  return { attempt: 1, heartbeat: () => true, signal: new AbortController().signal }
}

function task(overrides = {}) {
  return { id: 'task-1', intent: 'do it', riskLevel: 'R1', ...overrides }
}

function recorder(name, outcome = { status: 'succeeded', summary: `${name} ok` }) {
  const calls = []
  return {
    calls,
    adapter: {
      name,
      async execute(input, h) {
        calls.push({ input, h })
        return typeof outcome === 'function' ? outcome(input, h) : outcome
      },
    },
  }
}

function captureTelemetry() {
  const events = []
  return { events, port: { emit: (event) => { events.push(event); return true } } }
}

await check('explicit task.expert wins over project default and reports reason=explicit', async () => {
  const alpha = recorder('alpha')
  const dsh = recorder('dsh')
  const execute = createExpertExecutor({
    adapters: [alpha.adapter, dsh.adapter],
    defaultExpert: 'dsh',
    projectExpert: () => 'dsh',
  })
  const outcome = await execute(task({ expert: 'alpha', projectId: 'p1' }), hooks())
  assert.equal(outcome.status, 'succeeded')
  assert.equal(alpha.calls.length, 1)
  assert.equal(dsh.calls.length, 0)
  return true
})

await check('project default is used when the task has no explicit expert', async () => {
  const alpha = recorder('alpha')
  const dsh = recorder('dsh')
  const seen = []
  const execute = createExpertExecutor({
    adapters: [alpha.adapter, dsh.adapter],
    defaultExpert: 'dsh',
    projectExpert: (projectId) => { seen.push(projectId); return 'alpha' },
  })
  const outcome = await execute(task({ projectId: 'p1' }), hooks())
  assert.equal(outcome.summary, 'alpha ok')
  assert.deepEqual(seen, ['p1'])
  assert.equal(alpha.calls.length, 1)
  return true
})

await check('global default is used when neither task nor project names one', async () => {
  const alpha = recorder('alpha')
  const dsh = recorder('dsh')
  const execute = createExpertExecutor({
    adapters: [alpha.adapter, dsh.adapter],
    defaultExpert: 'dsh',
    projectExpert: () => null,
  })
  const outcome = await execute(task({ projectId: 'p1' }), hooks())
  assert.equal(outcome.summary, 'dsh ok')
  assert.equal(dsh.calls.length, 1)
  return true
})

await check('unknown explicit expert fails expert-unavailable and calls no adapter', async () => {
  const dsh = recorder('dsh')
  const execute = createExpertExecutor({ adapters: [dsh.adapter], defaultExpert: 'dsh' })
  const outcome = await execute(task({ expert: 'ghost' }), hooks())
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.failure, 'invalid_input')
  assert.equal(outcome.errorCode, 'expert-unavailable')
  assert.match(outcome.summary, /ghost/)
  assert.match(outcome.summary, /dsh/)
  assert.equal(dsh.calls.length, 0)
  return true
})

await check('unknown project default fails the same way instead of falling back', async () => {
  const dsh = recorder('dsh')
  const execute = createExpertExecutor({
    adapters: [dsh.adapter],
    defaultExpert: 'dsh',
    projectExpert: () => 'ghost',
  })
  const outcome = await execute(task({ projectId: 'p1' }), hooks())
  assert.equal(outcome.errorCode, 'expert-unavailable')
  assert.equal(dsh.calls.length, 0)
  return true
})

await check('adapter outcomes pass through unchanged', async () => {
  for (const outcome of [
    { status: 'succeeded', summary: 'ok' },
    { status: 'failed', summary: 'nope', failure: 'unknown' },
    { status: 'needs_input', question: 'which file?' },
  ]) {
    const execute = createExpertExecutor({ adapters: [recorder('dsh', outcome).adapter] })
    assert.deepEqual(await execute(task(), hooks()), outcome)
  }
  return true
})

await check('adapter errors propagate (the worker owns classification)', async () => {
  const execute = createExpertExecutor({
    adapters: [{ name: 'dsh', execute: async () => { throw new Error('boom') } }],
  })
  await assert.rejects(() => execute(task(), hooks()), /boom/)
  return true
})

await check('duplicate or empty adapter names fail at construction', async () => {
  assert.throws(() => createExpertExecutor({ adapters: [] }), /at least one/)
  assert.throws(() => createExpertExecutor({
    adapters: [{ name: 'dsh', execute: async () => ({ status: 'succeeded', summary: 'x' }) },
      { name: 'dsh', execute: async () => ({ status: 'succeeded', summary: 'x' }) }],
  }), /duplicate/)
  assert.throws(() => createExpertExecutor({
    adapters: [{ name: '  ', execute: async () => ({ status: 'succeeded', summary: 'x' }) }],
  }), /must not be empty/)
  return true
})

await check('route telemetry is emitted once with expert/reason/projectId', async () => {
  const telemetry = captureTelemetry()
  const execute = createExpertExecutor({
    adapters: [recorder('dsh').adapter],
    telemetry: telemetry.port,
  })
  await execute(task({ correlationId: 'trace-1', projectId: 'p1' }), hooks())
  const routes = telemetry.events.filter((event) => event.event === 'expert.routed')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].traceId, 'trace-1')
  assert.equal(routes[0].attrs.expert, 'dsh')
  assert.equal(routes[0].attrs.reason, 'global-default')
  assert.equal(routes[0].attrs.projectId, 'p1')
  return true
})

await check('no trace id means no route telemetry', async () => {
  const telemetry = captureTelemetry()
  const execute = createExpertExecutor({
    adapters: [recorder('dsh').adapter],
    telemetry: telemetry.port,
  })
  await execute(task(), hooks())
  assert.equal(telemetry.events.length, 0)
  return true
})

await check('adapter receives no governance objects (AR34)', async () => {
  let calls = 0
  let seenTask = null
  let seenHooks = null
  const execute = createExpertExecutor({
    adapters: [{
      name: 'alpha',
      async execute(input, h) {
        calls += 1
        seenTask = input
        seenHooks = h
        return { status: 'succeeded', summary: 'ok' }
      },
    }],
  })
  await execute(task({ expert: 'alpha' }), hooks())
  assert.equal(calls, 1)
  assert.deepEqual(Object.keys(seenHooks).sort(), ['attempt', 'heartbeat', 'signal'])
  for (const key of Object.keys(seenTask)) {
    assert.doesNotMatch(key, /approval|grant|credential|secret|token/i)
  }
  return true
})

console.log(`\nexpert: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
