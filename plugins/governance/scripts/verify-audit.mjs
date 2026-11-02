#!/usr/bin/env node
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { verifyAuditChain } from '../lib/audit/verify.js'

const dbPath =
  process.argv[2] ??
  process.env.DSH_WFXM_AUDIT_DB ??
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ops.sqlite')

const chain = verifyAuditChain(dbPath)
const db = new Database(dbPath)
const total = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n
const counts = db
  .prepare('SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY action')
  .all()
db.close()

console.log(JSON.stringify({ dbPath, chain, total, byAction: Object.fromEntries(counts.map((r) => [r.action, r.n])) }, null, 2))
if (!chain.ok) process.exit(1)
