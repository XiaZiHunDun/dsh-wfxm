/**
 * G2/G3 scheduled-patrol verification: config parsing, alert grading/quiet
 * window, daily digest once per day, persistence, and delivery isolation.
 *
 *   node scripts/verify-patrol.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createInspectionPatrol,
  createInspectionStore,
  formatInspectionDigest,
  formatInspectionWeek,
  isoWeekKey,
  readPatrolConfig,
} from '@dsh-wfxm/svcops'

const roots = []
let passed = 0
let failed = 0

function tempPath(label) {
  const dir = mkdtempSync(join(tmpdir(), `wfxm-patrol-${label}-`))
  roots.push(dir)
  return join(dir, 'ops.sqlite')
}

function report(status, items) {
  return { checklistId: 'default-min-safe', status, items }
}

const FAIL = report('fail', [
  { id: 'disk', label: '根分区使用率', status: 'fail', value: '95%', threshold: '≥85% 警告 / ≥92% 失败' },
  { id: 'memory', label: '可用内存', status: 'ok', value: '48%', threshold: '≤15% 警告 / ≤7% 失败' },
])
const OK = report('ok', [
  { id: 'disk', label: '根分区使用率', status: 'ok', value: '41%', threshold: '≥85% 警告 / ≥92% 失败' },
  { id: 'memory', label: '可用内存', status: 'ok', value: '63%', threshold: '≤15% 警告 / ≤7% 失败' },
])
const WARN = report('warn', [
  { id: 'disk', label: '根分区使用率', status: 'warn', value: '86%', threshold: '≥85% 警告 / ≥92% 失败' },
  { id: 'memory', label: '可用内存', status: 'ok', value: '48%', threshold: '≤15% 警告 / ≤7% 失败' },
])

const checks = []
function check(name, fn) {
  checks.push([name, fn])
}

check('readPatrolConfig: defaults', () => {
  const { config, warnings } = readPatrolConfig({}, 'host-58')
  assert.equal(config.intervalMinutes, 15)
  assert.equal(config.digestHour, 9)
  assert.equal(config.target, 'host-58')
  assert.deepEqual(warnings, [])
})

check('readPatrolConfig: 0/-1 disable, invalid keeps defaults', () => {
  const off = readPatrolConfig({
    DSH_WFXM_PATROL_INTERVAL_MINUTES: '0',
    DSH_WFXM_DIGEST_HOUR: '-1',
  }, 'h')
  assert.equal(off.config.intervalMinutes, 0)
  assert.equal(off.config.digestHour, -1)
  assert.deepEqual(off.warnings, [])

  const bad = readPatrolConfig({
    DSH_WFXM_PATROL_INTERVAL_MINUTES: '15m',
    DSH_WFXM_DIGEST_HOUR: '24',
  }, 'h')
  assert.equal(bad.config.intervalMinutes, 15)
  assert.equal(bad.config.digestHour, 9)
  assert.equal(bad.warnings.length, 2)
})

check('formatInspectionDigest: empty window', () => {
  const text = formatInspectionDigest(
    { hours: 24, now: new Date(0), runs: 0, byStatus: { ok: 0, warn: 0, fail: 0, skipped: 0 }, byAlert: { silent: 0, digest: 0, immediate: 0 }, latest: null, findings: [] },
    'h',
  )
  assert.match(text, /没有巡检记录/)
})

check('runOnce: fail pushes once, quiet window suppresses, retry after it', async () => {
  const dbPath = tempPath('alert')
  const deliveries = []
  let current = new Date(2026, 10, 11, 10, 0, 0)
  const patrol = createInspectionPatrol({
    dbPath,
    config: { intervalMinutes: 15, digestHour: -1, target: 'h' },
    collect: async () => FAIL,
    now: () => current,
    deliver: (delivery) => deliveries.push(delivery),
  })

  const first = await patrol.runOnce()
  assert.equal(first.pushed, 'alert')
  assert.equal(deliveries.length, 1)
  assert.match(deliveries[0].text, /根分区使用率: 95%/)
  assert.match(deliveries[0].dedupeKey, /^patrol-alert:h:disk:/)

  const quiet = await patrol.runOnce()
  assert.equal(quiet.pushed, null)
  assert.equal(deliveries.length, 1)

  current = new Date(2026, 10, 11, 10, 31, 0)
  const retry = await patrol.runOnce()
  assert.equal(retry.pushed, 'alert')
  assert.equal(deliveries.length, 2)
  assert.notEqual(deliveries[1].dedupeKey, deliveries[0].dedupeKey)

  patrol.stop()
  const store = createInspectionStore(dbPath)
  assert.equal(store.listSince('2026-01-01T00:00:00.000Z').length, 3)
  store.close()
})

check('runOnce: digest once per day at/after the configured hour', async () => {
  const dbPath = tempPath('digest')
  const deliveries = []
  let current = new Date(2026, 10, 11, 10, 0, 0)
  const patrol = createInspectionPatrol({
    dbPath,
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => current,
    deliver: (delivery) => deliveries.push(delivery),
  })

  const first = await patrol.runOnce()
  assert.equal(first.pushed, 'digest')
  assert.equal(deliveries.length, 1)
  assert.match(deliveries[0].text, /\[巡检日报\] h/)
  assert.match(deliveries[0].dedupeKey, /^patrol-digest:h:2026-11-11$/)

  const sameDay = await patrol.runOnce()
  assert.equal(sameDay.pushed, null)
  assert.equal(deliveries.length, 1)

  current = new Date(2026, 10, 12, 9, 1, 0)
  const nextDay = await patrol.runOnce()
  assert.equal(nextDay.pushed, 'digest')
  assert.equal(deliveries.length, 2)

  patrol.stop()
})

check('runOnce: before the digest hour stays silent', async () => {
  const dbPath = tempPath('early')
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath,
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 8, 59, 0),
    deliver: (delivery) => deliveries.push(delivery),
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, null)
  assert.equal(deliveries.length, 0)
  patrol.stop()
})

check('runOnce: the task digest shares the daily gate but has its own key', async () => {
  const deliveries = []
  const calls = []
  let current = new Date(2026, 10, 11, 10, 0, 0)
  const patrol = createInspectionPatrol({
    dbPath: tempPath('tasks-digest'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => current,
    deliver: (delivery) => deliveries.push(delivery),
    taskDigest: (window) => {
      calls.push(window)
      return '任务日报 11-11：完成 1\n· abc · 已完成 · 重启 nginx'
    },
  })

  const first = await patrol.runOnce()
  assert.equal(first.pushed, 'digest+tasks')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].to.getTime(), current.getTime())
  assert.equal(calls[0].from.getTime(), current.getTime() - 24 * 3_600_000)
  assert.deepEqual(deliveries.map((item) => item.dedupeKey), [
    'patrol-digest:h:2026-11-11',
    'task-digest:2026-11-11',
  ])
  assert.match(deliveries[1].text, /^任务日报 11-11：完成 1/)

  const sameDay = await patrol.runOnce()
  assert.equal(sameDay.pushed, null)
  assert.equal(calls.length, 1)
  assert.equal(deliveries.length, 2)
  patrol.stop()
})

check('runOnce: the conversation digest has its own key and shares the window', async () => {
  const deliveries = []
  const calls = []
  const current = new Date(2026, 10, 11, 10, 0, 0)
  const patrol = createInspectionPatrol({
    dbPath: tempPath('conv-digest'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => current,
    deliver: (delivery) => deliveries.push(delivery),
    conversationDigest: (window) => {
      calls.push(window)
      return '会话日报 11-11：会话 1 · 消息 2'
    },
  })

  const first = await patrol.runOnce()
  assert.equal(first.pushed, 'digest+conversations')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].to.getTime(), current.getTime())
  assert.equal(calls[0].from.getTime(), current.getTime() - 24 * 3_600_000)
  assert.deepEqual(deliveries.map((item) => item.dedupeKey), [
    'patrol-digest:h:2026-11-11',
    'conversation-digest:2026-11-11',
  ])
  assert.match(deliveries[1].text, /^会话日报 11-11：会话 1/)

  const sameDay = await patrol.runOnce()
  assert.equal(sameDay.pushed, null)
  assert.equal(calls.length, 1)
  assert.equal(deliveries.length, 2)
  patrol.stop()
})

check('runOnce: an empty conversation digest adds no message', async () => {
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath: tempPath('conv-empty'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
    taskDigest: () => '任务日报 11-11：完成 1',
    conversationDigest: () => null,
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, 'digest+tasks')
  assert.deepEqual(deliveries.map((item) => item.dedupeKey), [
    'patrol-digest:h:2026-11-11',
    'task-digest:2026-11-11',
  ])
  patrol.stop()
})

check('runOnce: a throwing conversation digest is isolated and not retried', async () => {
  const warnings = []
  const deliveries = []
  let calls = 0
  const patrol = createInspectionPatrol({
    dbPath: tempPath('conv-throw'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
    logger: { warn: (message) => warnings.push(message) },
    taskDigest: () => '任务日报 11-11：完成 1',
    conversationDigest: () => {
      calls += 1
      throw new Error('thread store gone')
    },
  })
  const first = await patrol.runOnce()
  assert.equal(first.pushed, 'digest+tasks')
  assert.equal(deliveries.length, 2)
  assert.match(warnings.join('\n'), /conversation digest failed: thread store gone/)
  const sameDay = await patrol.runOnce()
  assert.equal(sameDay.pushed, null)
  assert.equal(calls, 1)
  patrol.stop()
})

check('runOnce: before the digest hour the conversation digest is not called', async () => {
  let calls = 0
  const patrol = createInspectionPatrol({
    dbPath: tempPath('conv-early'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 8, 59, 0),
    deliver: () => {},
    conversationDigest: () => {
      calls += 1
      return '会话日报'
    },
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, null)
  assert.equal(calls, 0)
  patrol.stop()
})

check('runOnce: an async conversation digest is awaited before delivery', async () => {
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath: tempPath('conv-async'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
    conversationDigest: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return '会话日报 11-11：会话 1 · 消息 1\n今天清理了 /tmp。'
    },
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, 'digest+conversations')
  assert.match(deliveries[1].text, /今天清理了 \/tmp。/)
  patrol.stop()
})

check('runOnce: a rejecting async conversation digest is isolated', async () => {
  const warnings = []
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath: tempPath('conv-reject'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
    logger: { warn: (message) => warnings.push(message) },
    conversationDigest: async () => {
      throw new Error('model down')
    },
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, 'digest')
  assert.equal(deliveries.length, 1)
  assert.match(warnings.join('\n'), /conversation digest failed: model down/)
  patrol.stop()
})

check('runOnce: the outbox line rides the daily digest and its window (Slice Q)', async () => {
  const deliveries = []
  const calls = []
  const current = new Date(2026, 10, 11, 10, 0, 0)
  const patrol = createInspectionPatrol({
    dbPath: tempPath('outbox-digest'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => current,
    deliver: (delivery) => deliveries.push(delivery),
    outboxDigest: (window) => {
      calls.push(window)
      return '出站：失败 2 · 积压 1（重试 1）'
    },
  })

  const first = await patrol.runOnce()
  assert.equal(first.pushed, 'digest')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].to.getTime(), current.getTime())
  assert.equal(calls[0].from.getTime(), current.getTime() - 24 * 3_600_000)
  assert.match(deliveries[0].text, /出站：失败 2 · 积压 1（重试 1）$/)

  const sameDay = await patrol.runOnce()
  assert.equal(sameDay.pushed, null)
  assert.equal(calls.length, 1)
  patrol.stop()
})

check('runOnce: a throwing outbox digest is isolated (Slice Q)', async () => {
  const warnings = []
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath: tempPath('outbox-throw'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
    logger: { warn: (message) => warnings.push(message) },
    outboxDigest: () => {
      throw new Error('outbox store gone')
    },
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, 'digest')
  assert.doesNotMatch(deliveries[0].text, /出站/)
  assert.match(warnings.join('\n'), /outbox digest failed: outbox store gone/)
  patrol.stop()
})

check('runOnce: an empty task digest adds no message', async () => {
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath: tempPath('tasks-empty'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
    taskDigest: () => null,
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, 'digest')
  assert.equal(deliveries.length, 1)
  patrol.stop()
})

check('runOnce: a throwing task digest is isolated and not retried', async () => {
  const warnings = []
  let calls = 0
  const patrol = createInspectionPatrol({
    dbPath: tempPath('tasks-throw'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => FAIL,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: () => {},
    logger: { warn: (message) => warnings.push(message) },
    taskDigest: () => {
      calls += 1
      throw new Error('task store gone')
    },
  })
  const first = await patrol.runOnce()
  assert.equal(first.pushed, 'alert+digest')
  assert.match(warnings.join('\n'), /task digest failed: task store gone/)
  const sameDay = await patrol.runOnce()
  assert.equal(sameDay.pushed, null)
  assert.equal(calls, 1)
  patrol.stop()
})

check('runOnce: before the digest hour the task digest is not called', async () => {
  let calls = 0
  const patrol = createInspectionPatrol({
    dbPath: tempPath('tasks-early'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 8, 59, 0),
    deliver: () => {},
    taskDigest: () => {
      calls += 1
      return '任务日报'
    },
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, null)
  assert.equal(calls, 0)
  patrol.stop()
})

check('runOnce: delivery failure is isolated', async () => {
  const warnings = []
  const patrol = createInspectionPatrol({
    dbPath: tempPath('deliver-fail'),
    config: { intervalMinutes: 15, digestHour: -1, target: 'h' },
    collect: async () => FAIL,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: () => { throw new Error('transport down') },
    logger: { warn: (message) => warnings.push(message) },
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, 'alert')
  assert.match(warnings.join('\n'), /transport down/)
  patrol.stop()
})

check('start: interval 0 does not arm a timer', async () => {
  const patrol = createInspectionPatrol({
    dbPath: tempPath('off'),
    config: { intervalMinutes: 0, digestHour: 9, target: 'h' },
    collect: async () => OK,
    deliver: () => {},
  })
  patrol.start()
  patrol.stop()
})

check('isoWeekKey: ISO weeks across year boundaries', () => {
  assert.equal(isoWeekKey(new Date(2026, 10, 11, 10, 0, 0)), '2026-W46')
  assert.equal(isoWeekKey(new Date(2024, 11, 30, 10, 0, 0)), '2025-W01')
  assert.equal(isoWeekKey(new Date(2026, 0, 1, 10, 0, 0)), '2026-W01')
})

check('formatInspectionWeek: counts, findings cap, empty window', () => {
  const digest = {
    hours: 168,
    now: new Date(2026, 10, 11, 10, 0, 0),
    runs: 42,
    byStatus: { ok: 40, warn: 1, fail: 1, skipped: 0 },
    byAlert: { silent: 40, digest: 1, immediate: 1 },
    latest: { ranAt: '2026-11-11T10:00:00.000Z', target: 'h', status: 'fail', level: 'immediate' },
    findings: ['disk 92%', 'memory 8%', 'load 9.0', 'port 8080 down'],
  }
  const text = formatInspectionWeek(digest)
  assert.match(text, /巡检 42 次：正常 40 \/ 警告 1 \/ 失败 1 \/ 跳过 0/)
  assert.match(text, /持续项：disk 92%；memory 8%；load 9\.0$/)
  assert.doesNotMatch(text, /port 8080 down/)

  const empty = formatInspectionWeek({
    hours: 168,
    now: new Date(2026, 10, 11, 10, 0, 0),
    runs: 0,
    byStatus: { ok: 0, warn: 0, fail: 0, skipped: 0 },
    byAlert: { silent: 0, digest: 0, immediate: 0 },
    latest: null,
    findings: [],
  })
  assert.match(empty, /近 7 天没有记录/)
})

check('readPatrolConfig: weekly day default/-1/invalid', () => {
  assert.equal(readPatrolConfig({}, 'h').config.weeklyDay, 1)
  assert.equal(readPatrolConfig({ DSH_WFXM_WEEKLY_DIGEST_DAY: '-1' }, 'h').config.weeklyDay, -1)
  assert.equal(readPatrolConfig({ DSH_WFXM_WEEKLY_DIGEST_DAY: '6' }, 'h').config.weeklyDay, 6)

  const bad = readPatrolConfig({ DSH_WFXM_WEEKLY_DIGEST_DAY: '7' }, 'h')
  assert.equal(bad.config.weeklyDay, 1)
  assert.equal(bad.warnings.length, 1)
  assert.match(bad.warnings[0], /DSH_WFXM_WEEKLY_DIGEST_DAY/)
})

check('runOnce: the weekly report replaces the daily digests on its day', async () => {
  const deliveries = []
  const weeklyCalls = []
  let dailyCalls = 0
  let current = new Date(2026, 10, 11, 10, 0, 0) // Wednesday
  const patrol = createInspectionPatrol({
    dbPath: tempPath('weekly'),
    config: { intervalMinutes: 15, digestHour: 9, weeklyDay: 3, target: 'h' },
    collect: async () => OK,
    now: () => current,
    deliver: (delivery) => deliveries.push(delivery),
    taskDigest: () => {
      dailyCalls += 1
      return '任务日报 11-11：完成 1'
    },
    conversationDigest: () => {
      dailyCalls += 1
      return '会话日报 11-11：会话 1'
    },
    weeklySections: (window) => {
      weeklyCalls.push(window)
      return '任务（近 7 天）：完成 2\n· abc · 已完成 · 重启 nginx\n会话（近 7 天）：会话 1 · 消息 3'
    },
  })

  const first = await patrol.runOnce()
  assert.equal(first.pushed, 'weekly')
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].dedupeKey, 'weekly-digest:2026-W46')
  assert.match(deliveries[0].text, /^\[周报\] h · 11-04 ~ 11-11/)
  assert.match(deliveries[0].text, /巡检 1 次：正常 1/)
  assert.match(deliveries[0].text, /任务（近 7 天）：完成 2/)
  assert.equal(weeklyCalls.length, 1)
  assert.equal(weeklyCalls[0].to.getTime(), current.getTime())
  assert.equal(weeklyCalls[0].from.getTime(), current.getTime() - 168 * 3_600_000)
  assert.equal(dailyCalls, 0)

  const sameDay = await patrol.runOnce()
  assert.equal(sameDay.pushed, null)
  assert.equal(deliveries.length, 1)
  assert.equal(weeklyCalls.length, 1)
  assert.equal(dailyCalls, 0)

  current = new Date(2026, 10, 12, 10, 0, 0) // Thursday: daily reports resume
  const nextDay = await patrol.runOnce()
  assert.equal(nextDay.pushed, 'digest+tasks+conversations')
  assert.equal(dailyCalls, 2)
  assert.equal(weeklyCalls.length, 1)
  patrol.stop()
})

check('runOnce: the outbox line also closes the weekly report (Slice Q)', async () => {
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath: tempPath('weekly-outbox'),
    config: { intervalMinutes: 15, digestHour: 9, weeklyDay: 3, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
    weeklySections: () => '任务（近 7 天）：完成 2',
    outboxDigest: () => '出站：失败 0 · 积压 0',
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, 'weekly')
  assert.match(deliveries[0].text, /任务（近 7 天）：完成 2\n出站：失败 0 · 积压 0$/)
  patrol.stop()
})

check('runOnce: weekly sections are isolated, and non-weekly/early ticks skip them', async () => {
  const warnings = []
  const deliveries = []
  let calls = 0
  const patrol = createInspectionPatrol({
    dbPath: tempPath('weekly-throw'),
    config: { intervalMinutes: 15, digestHour: 9, weeklyDay: 3, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
    logger: { warn: (message) => warnings.push(message) },
    weeklySections: () => {
      calls += 1
      throw new Error('task store gone')
    },
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, 'weekly')
  assert.equal(deliveries.length, 1)
  assert.match(deliveries[0].text, /巡检 1 次/)
  assert.doesNotMatch(deliveries[0].text, /任务（近 7 天）/)
  assert.match(warnings.join('\n'), /weekly sections failed: task store gone/)
  patrol.stop()

  let offCalls = 0
  const off = createInspectionPatrol({
    dbPath: tempPath('weekly-off'),
    config: { intervalMinutes: 15, digestHour: 9, weeklyDay: 4, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: () => {},
    weeklySections: () => {
      offCalls += 1
      return '任务（近 7 天）：完成 0'
    },
  })
  assert.equal((await off.runOnce()).pushed, 'digest')
  assert.equal(offCalls, 0)
  off.stop()

  let earlyCalls = 0
  const early = createInspectionPatrol({
    dbPath: tempPath('weekly-early'),
    config: { intervalMinutes: 15, digestHour: 9, weeklyDay: 3, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 8, 59, 0),
    deliver: () => {},
    weeklySections: () => {
      earlyCalls += 1
      return '任务（近 7 天）：完成 0'
    },
  })
  assert.equal((await early.runOnce()).pushed, null)
  assert.equal(earlyCalls, 0)
  early.stop()
})

check('candidates: a repeated fail bumps seen_count without duplicating rows', async () => {
  const dbPath = tempPath('candidate-repeat')
  let current = new Date(2026, 10, 11, 10, 0, 0)
  const patrol = createInspectionPatrol({
    dbPath,
    config: { intervalMinutes: 15, digestHour: -1, target: 'h' },
    collect: async () => FAIL,
    now: () => current,
    deliver: () => {},
  })

  await patrol.runOnce()
  current = new Date(2026, 10, 11, 10, 16, 0)
  const second = await patrol.runOnce()
  // The alert is quieted here, but candidate recording still runs.
  assert.equal(second.pushed, null)
  patrol.stop()

  const store = createInspectionStore(dbPath)
  const digest = store.candidateDigest('2026-01-01T00:00:00.000Z')
  assert.equal(digest.opened, 1)
  assert.equal(digest.stillOpen, 1)
  assert.equal(digest.open.length, 1)
  assert.equal(digest.open[0].ruleId, 'disk-pressure')
  assert.equal(digest.open[0].lastObserved, '95%')
  assert.equal(digest.open[0].seenCount, 2)
  store.close()
})

check('candidates: recovery resolves, and a later fail reopens', async () => {
  const dbPath = tempPath('candidate-reopen')
  let current = new Date(2026, 10, 11, 10, 0, 0)
  let currentReport = FAIL
  const patrol = createInspectionPatrol({
    dbPath,
    config: { intervalMinutes: 15, digestHour: -1, target: 'h' },
    collect: async () => currentReport,
    now: () => current,
    deliver: () => {},
  })

  await patrol.runOnce()
  currentReport = OK
  current = new Date(2026, 10, 11, 10, 16, 0)
  await patrol.runOnce()

  const store = createInspectionStore(dbPath)
  const recovered = store.candidateDigest('2026-01-01T00:00:00.000Z')
  assert.equal(recovered.opened, 1)
  assert.equal(recovered.resolved, 1)
  assert.equal(recovered.stillOpen, 0)
  assert.equal(recovered.open.length, 0)

  currentReport = FAIL
  current = new Date(2026, 10, 11, 10, 32, 0)
  await patrol.runOnce()
  const reopened = store.candidateDigest('2026-01-01T00:00:00.000Z')
  assert.equal(reopened.resolved, 0)
  assert.equal(reopened.stillOpen, 1)
  assert.equal(reopened.open[0].seenCount, 2)

  store.close()
  patrol.stop()
})

check('candidates: the daily digest shows counts/bullets and omits an empty section', async () => {
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath: tempPath('candidate-digest'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => FAIL,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
  })
  await patrol.runOnce()
  patrol.stop()

  const digest = deliveries.find((item) => item.dedupeKey.startsWith('patrol-digest:'))
  assert.ok(digest !== undefined)
  assert.match(digest.text, /候选：新增 1 · 恢复 0 · 未决 1/)
  assert.match(digest.text, /- 根分区使用率偏高（95%，首次 .* \/ 最近 .*）/)

  const quietDeliveries = []
  const quiet = createInspectionPatrol({
    dbPath: tempPath('candidate-digest-empty'),
    config: { intervalMinutes: 15, digestHour: 9, target: 'h' },
    collect: async () => OK,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => quietDeliveries.push(delivery),
  })
  await quiet.runOnce()
  quiet.stop()
  assert.equal(quietDeliveries.length, 1)
  assert.doesNotMatch(quietDeliveries[0].text, /候选/)
})

check('candidates: the immediate fail alert carries the observe line', async () => {
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath: tempPath('candidate-alert-line'),
    config: { intervalMinutes: 15, digestHour: -1, target: 'h' },
    collect: async () => FAIL,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
  })
  await patrol.runOnce()
  patrol.stop()
  assert.equal(deliveries.length, 1)
  assert.match(deliveries[0].text, /已记录为候选（observe，不自动建任务）。/)
})

check('candidates: warn findings open candidates but push no immediate alert', async () => {
  const dbPath = tempPath('candidate-warn')
  const deliveries = []
  const patrol = createInspectionPatrol({
    dbPath,
    config: { intervalMinutes: 15, digestHour: -1, target: 'h' },
    collect: async () => WARN,
    now: () => new Date(2026, 10, 11, 10, 0, 0),
    deliver: (delivery) => deliveries.push(delivery),
  })
  const result = await patrol.runOnce()
  assert.equal(result.pushed, null)
  assert.equal(deliveries.length, 0)
  patrol.stop()

  const store = createInspectionStore(dbPath)
  const digest = store.candidateDigest('2026-01-01T00:00:00.000Z')
  assert.equal(digest.opened, 1)
  assert.equal(digest.stillOpen, 1)
  assert.equal(digest.open[0].ruleId, 'disk-pressure')
  store.close()
})

for (const [name, fn] of checks) {
  try {
    const detail = await fn()
    passed += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Temp cleanup is best-effort.
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
