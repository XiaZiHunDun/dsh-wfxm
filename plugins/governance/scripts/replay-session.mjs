#!/usr/bin/env node
/**
 * Replay a recorded dsh session log (zstd JSONL) through the same audit mapper
 * used by the live plugin. Used to cover event types a live smoke may not
 * produce (e.g. approval/asked + approval/decided).
 *
 * Usage: node scripts/replay-session.mjs <session.v4.jsonl.zstd> [dbPath]
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAuditStore } from '../lib/audit/store.js'
import { toAuditFields } from '../lib/audit/events.js'

const [file, dbArg] = process.argv.slice(2)
if (!file) {
  console.error('usage: node scripts/replay-session.mjs <session.v4.jsonl.zstd> [dbPath]')
  process.exit(2)
}
const dbPath =
  dbArg ?? process.env.DSH_WFXM_AUDIT_DB ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ops.sqlite')

const decoded = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
if (decoded.error || decoded.status !== 0) {
  console.error(`failed to decode ${file}: ${decoded.error?.message ?? decoded.stderr}`)
  process.exit(1)
}

const store = createAuditStore(dbPath)
let sessionId = null
let appended = 0
let skipped = 0
for (const line of decoded.stdout.split('\n')) {
  if (!line.trim()) continue
  const record = JSON.parse(line)
  if (record.type === 'session') {
    sessionId = record.id
    continue
  }
  if (!sessionId) continue
  const fields = toAuditFields({ id: sessionId }, record)
  if (!fields) {
    skipped += 1
    continue
  }
  appended += store.append(fields) ? 1 : 0
}
store.close()
console.log(JSON.stringify({ file, dbPath, sessionId, appended, skipped }, null, 2))
