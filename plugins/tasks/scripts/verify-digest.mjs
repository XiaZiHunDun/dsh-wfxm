/**
 * Task digest (tasks/digest.ts): deterministic, model-free summary of a window.
 * It must never invent numbers: finished work is counted by `finishedAt`, live
 * work is a snapshot of "now", and an empty day produces no message at all.
 */

import assert from 'node:assert/strict'

const { summarizeTaskDigest } = await import('../lib/index.js')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`PASS  ${name}`)
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const TO = new Date('2026-11-11T09:00:00+08:00')
const FROM = new Date(TO.getTime() - 24 * 3_600_000)

let seq = 0
function task(overrides = {}) {
  seq += 1
  const id = overrides.id ?? `tk_${String(seq).padStart(4, '0')}`
  return {
    id,
    projectId: null,
    conversationId: null,
    sessionId: null,
    startCursor: null,
    intent: `任务 ${seq}`,
    riskLevel: 'R1',
    status: 'queued',
    plan: null,
    attempt: 0,
    maxAttempts: 3,
    leaseOwner: null,
    leaseExpiresAt: null,
    correlationId: `c_${seq}`,
    round: 0,
    originMsgId: null,
    taskRef: `ref${seq}`,
    createdAt: new Date(TO.getTime() - 6 * 3_600_000).toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

check('an empty day produces no digest', () => {
  assert.equal(summarizeTaskDigest([], { from: FROM, to: TO }), null)
})

check('finished work is counted only inside the window', () => {
  const inside = task({ status: 'succeeded', finishedAt: new Date(TO.getTime() - 3_600_000).toISOString() })
  const outside = task({ status: 'succeeded', finishedAt: new Date(FROM.getTime() - 3_600_000).toISOString() })
  const digest = summarizeTaskDigest([inside, outside], { from: FROM, to: TO })
  assert.equal(digest.total, 1)
  assert.equal(digest.counts.succeeded, 1)
})

check('live work is a snapshot of now, regardless of age', () => {
  const old = task({ status: 'running', createdAt: new Date(FROM.getTime() - 72 * 3_600_000).toISOString() })
  const waiting = task({ status: 'waiting_approval' })
  const queued = task({ status: 'queued' })
  const paused = task({ status: 'paused' })
  const digest = summarizeTaskDigest([old, waiting, queued, paused], { from: FROM, to: TO })
  assert.equal(digest.counts.running, 1)
  assert.equal(digest.counts.waitingApproval, 1)
  assert.equal(digest.counts.queued, 1)
  assert.equal(digest.counts.paused, 1)
  assert.equal(digest.total, 4)
})

check('tasks created after the window are not counted', () => {
  const future = task({ status: 'running', createdAt: new Date(TO.getTime() + 60_000).toISOString() })
  assert.equal(summarizeTaskDigest([future], { from: FROM, to: TO }), null)
})

check('failed and cancelled finished tasks are counted separately', () => {
  const failed = task({ status: 'failed', finishedAt: new Date(TO.getTime() - 2 * 3_600_000).toISOString() })
  const cancelled = task({ status: 'cancelled', finishedAt: new Date(TO.getTime() - 3_600_000).toISOString() })
  const digest = summarizeTaskDigest([failed, cancelled], { from: FROM, to: TO })
  assert.equal(digest.counts.failed, 1)
  assert.equal(digest.counts.cancelled, 1)
  assert.equal(digest.total, 2)
})

check('the header lists non-zero buckets in a stable order', () => {
  const ok = task({ status: 'succeeded', finishedAt: new Date(TO.getTime() - 3_600_000).toISOString() })
  const bad = task({ status: 'failed', finishedAt: new Date(TO.getTime() - 2 * 3_600_000).toISOString() })
  const waiting = task({ status: 'waiting_approval' })
  const digest = summarizeTaskDigest([ok, bad, waiting], { from: FROM, to: TO })
  assert.match(digest.text.split('\n')[0], /^任务日报 11-11：完成 1 · 失败 1 · 待批准 1$/)
})

check('a quiet day with only live work still reports', () => {
  const digest = summarizeTaskDigest([task({ status: 'running' })], { from: FROM, to: TO })
  assert.equal(digest.text.split('\n')[0], '任务日报 11-11：进行中 1')
})

check('bullets prefer taskRef, fall back to the id prefix, and flatten newlines', () => {
  const ref = task({
    status: 'succeeded',
    taskRef: '8h99a67zp6',
    intent: '重启 nginx\n并复验',
    finishedAt: new Date(TO.getTime() - 3_600_000).toISOString(),
  })
  const noRef = task({
    id: 'abcdefgh1234',
    status: 'queued',
    taskRef: null,
    intent: '排队中的任务',
  })
  const digest = summarizeTaskDigest([ref, noRef], { from: FROM, to: TO })
  assert.match(digest.text, /· 8h99a67zp6 · 已完成 · 重启 nginx 并复验/)
  assert.match(digest.text, /· abcdefgh · 排队 · 排队中的任务/)
})

check('long intents are clipped to 40 characters', () => {
  const long = task({
    status: 'succeeded',
    intent: '一'.repeat(60),
    finishedAt: new Date(TO.getTime() - 3_600_000).toISOString(),
  })
  const digest = summarizeTaskDigest([long], { from: FROM, to: TO })
  assert.match(digest.text, /· ref\d+ · 已完成 · 一{40}…/)
})

check('maxLines caps the bullets and zero means header only', () => {
  const many = Array.from({ length: 8 }, () => task({
    status: 'succeeded',
    finishedAt: new Date(TO.getTime() - 3_600_000).toISOString(),
  }))
  const capped = summarizeTaskDigest(many, { from: FROM, to: TO, maxLines: 2 })
  assert.equal(capped.lines.length, 2)
  assert.equal(capped.text.split('\n').length, 3)
  const headerOnly = summarizeTaskDigest(many, { from: FROM, to: TO, maxLines: 0 })
  assert.equal(headerOnly.text.split('\n').length, 1)
})

check('finished work is listed newest first, then live work', () => {
  const older = task({
    status: 'succeeded',
    taskRef: 'older',
    finishedAt: new Date(TO.getTime() - 8 * 3_600_000).toISOString(),
  })
  const newer = task({
    status: 'failed',
    taskRef: 'newer',
    finishedAt: new Date(TO.getTime() - 1 * 3_600_000).toISOString(),
  })
  const live = task({ status: 'running', taskRef: 'live' })
  const digest = summarizeTaskDigest([older, newer, live], { from: FROM, to: TO })
  assert.deepEqual(digest.lines.map((line) => line.split(' · ')[1]), ['失败', '已完成', '进行中'])
})

check('a custom title replaces the daily header without changing counts', () => {
  const ok = task({ status: 'succeeded', finishedAt: new Date(TO.getTime() - 3_600_000).toISOString() })
  const digest = summarizeTaskDigest([ok], { from: FROM, to: TO, title: '任务（近 7 天）' })
  assert.equal(digest.text.split('\n')[0], '任务（近 7 天）：完成 1')
  assert.doesNotMatch(digest.text, /任务日报/)
})

check('BK usage: header appends cost when prices are configured', () => {
  const a = task({
    status: 'succeeded',
    finishedAt: new Date(TO.getTime() - 3_600_000).toISOString(),
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.0021,
  })
  const b = task({
    status: 'failed',
    finishedAt: new Date(TO.getTime() - 2 * 3_600_000).toISOString(),
    inputTokens: 800,
    outputTokens: 200,
    costUsd: 0.0009,
  })
  const digest = summarizeTaskDigest([a, b], { from: FROM, to: TO, maxLines: 0 })
  assert.equal(digest.usage.costUsd, 0.003)
  assert.match(digest.text, /费用 \$0\.0030/)
})

check('BK usage: tokens are visible even when no price is set', () => {
  const live = task({ status: 'running', inputTokens: 1500, outputTokens: 200, costUsd: 0 })
  const digest = summarizeTaskDigest([live], { from: FROM, to: TO, maxLines: 0 })
  assert.match(digest.text, /tokens 1\.5k\/200/)
  assert.doesNotMatch(digest.text, /费用/)
})

console.log(`\ntask-digest: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
