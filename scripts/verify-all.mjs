#!/usr/bin/env node
/**
 * Run every verify suite in one deterministic pass (docs/16 §12.28).
 *
 *   node scripts/verify-all.mjs            # everything; host-only suites included
 *   node scripts/verify-all.mjs --ci       # skip suites that need a real host
 *   node scripts/verify-all.mjs --list
 *   node scripts/verify-all.mjs --only=gateway
 *
 * `live` posts real messages into the owner's Feishu chat, so it only runs when
 * `DSH_WFXM_VERIFY_LIVE=1` is set.
 *
 * A new `verify-*.mjs` must be registered below: an unlisted file fails the
 * run, so CI can never silently lose coverage.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const ci = argv.includes('--ci')
const listOnly = argv.includes('--list')
// The live suite posts real test bubbles into the owner's Feishu chat, so it is
// opt-in: `DSH_WFXM_VERIFY_LIVE=1` (2026-11-28 实测：默认全量会把 stub 回执发进真实会话).
const liveEnabled = process.env.DSH_WFXM_VERIFY_LIVE === '1'
const only = argv.find((item) => item.startsWith('--only='))?.slice('--only='.length) ?? null

/** `ci: false` = needs credentials / systemd / docker / a live ops DB. */
const SUITES = [
  { name: 'docs', file: 'scripts/verify-docs.mjs', ci: true },
  { name: 'supply', file: 'scripts/verify-supply.mjs', ci: true },
  { name: 'migrations', file: 'scripts/verify-migrations.mjs', ci: true },
  { name: 'changes', file: 'plugins/changes/scripts/verify-changes.mjs', ci: true },
  { name: 'calendar', file: 'plugins/calendar/scripts/verify-calendar.mjs', ci: true },
  { name: 'search', file: 'scripts/verify-search.mjs', ci: true },
  { name: 'project-tools', file: 'plugins/governance/scripts/verify-project-tools.mjs', ci: true },
  { name: 'executor', file: 'plugins/executor/scripts/verify-executor.mjs', ci: true },
  { name: 'expert', file: 'plugins/executor/scripts/verify-expert.mjs', ci: true },
  { name: 'feishu', file: 'plugins/feishu/scripts/verify-feishu.mjs', ci: true },
  { name: 'gateway', file: 'plugins/gateway/scripts/verify-gateway.mjs', ci: true },
  { name: 'conversation-digest', file: 'plugins/gateway/scripts/verify-conversation-digest.mjs', ci: true },
  { name: 'approvals', file: 'plugins/governance/scripts/verify-approvals.mjs', ci: true },
  { name: 'approval-bridge', file: 'plugins/governance/scripts/verify-approval-bridge.mjs', ci: true },
  { name: 'audit', file: 'plugins/governance/scripts/verify-audit.mjs', ci: false, env: { DSH_HOME: '/var/lib/dsh-wfxm' } },
  { name: 'concurrency', file: 'plugins/governance/scripts/verify-concurrency.mjs', ci: true },
  { name: 'grants', file: 'plugins/governance/scripts/verify-grants.mjs', ci: true },
  { name: 'grants-admin', file: 'plugins/governance/scripts/verify-grants-admin.mjs', ci: true },
  { name: 'audit-admin', file: 'plugins/governance/scripts/verify-audit-admin.mjs', ci: true },
  { name: 'policy', file: 'plugins/governance/scripts/verify-policy.mjs', ci: true },
  // Root cannot be denied by `chmod 000`; the failure is environmental, not a regression.
  { name: 'preimages', file: 'plugins/governance/scripts/verify-preimages.mjs', ci: true, advisoryWhenRoot: true },
  { name: 'host', file: 'plugins/host/scripts/verify-host.mjs', ci: true },
  { name: 'diagnostics', file: 'plugins/host/scripts/verify-diagnostics.mjs', ci: true },
  { name: 'knowledge', file: 'plugins/knowledge/scripts/verify-knowledge.mjs', ci: true },
  { name: 'mail', file: 'plugins/mail/scripts/verify-mail.mjs', ci: true },
  { name: 'projects-cli', file: 'plugins/knowledge/scripts/verify-projects-cli.mjs', ci: true },
  { name: 'notify', file: 'plugins/notify/scripts/verify-notify.mjs', ci: true },
  { name: 'orchestrator', file: 'plugins/orchestrator/scripts/verify-orchestrator.mjs', ci: true },
  { name: 'semantic', file: 'plugins/orchestrator/scripts/verify-semantic.mjs', ci: true },
  { name: 'redact', file: 'plugins/redact/scripts/verify-redact.mjs', ci: true },
  { name: 'reminder', file: 'plugins/reminder/scripts/verify-reminder.mjs', ci: true },
  { name: 'snapshot', file: 'plugins/snapshot/scripts/verify-snapshot.mjs', ci: true },
  { name: 'alerting', file: 'plugins/svcops/scripts/verify-alerting.mjs', ci: true },
  { name: 'inspection', file: 'plugins/svcops/scripts/verify-inspection.mjs', ci: true },
  { name: 'inspection-config', file: 'plugins/svcops/scripts/verify-inspection-config.mjs', ci: true },
  { name: 'report', file: 'plugins/svcops/scripts/verify-report.mjs', ci: true },
  { name: 'svcops', file: 'plugins/svcops/scripts/verify-svcops.mjs', ci: true },
  { name: 'svcops-tools', file: 'plugins/svcops/scripts/verify-svcops-tools.mjs', ci: true },
  { name: 'svcops-docker', file: 'plugins/svcops/scripts/verify-svcops-docker.mjs', ci: false },
  { name: 'tasks', file: 'plugins/tasks/scripts/verify-tasks.mjs', ci: true },
  { name: 'digest', file: 'plugins/tasks/scripts/verify-digest.mjs', ci: true },
  { name: 'isolation', file: 'plugins/tasks/scripts/verify-isolation.mjs', ci: true },
  { name: 'locks-cli', file: 'plugins/tasks/scripts/verify-locks-cli.mjs', ci: true },
  { name: 'merge', file: 'plugins/tasks/scripts/verify-merge.mjs', ci: true },
  { name: 'resource-locks', file: 'plugins/tasks/scripts/verify-resource-locks.mjs', ci: true },
  { name: 'risk', file: 'plugins/tasks/scripts/verify-risk.mjs', ci: true },
  { name: 'telemetry', file: 'plugins/telemetry/scripts/verify-telemetry.mjs', ci: true },
  { name: 'instrumentation', file: 'plugins/telemetry/scripts/verify-instrumentation.mjs', ci: true },
  { name: 'trace-cli', file: 'plugins/telemetry/scripts/verify-trace-cli.mjs', ci: true },
  { name: 'drills', file: 'scripts/verify-drills.mjs', ci: true },
  { name: 'backup', file: 'scripts/verify-backup.mjs', ci: true },
  { name: 'deploy', file: 'scripts/verify-deploy.mjs', ci: false },
  { name: 'health-alert', file: 'scripts/verify-health-alert.mjs', ci: true },
  { name: 'invariants', file: 'scripts/verify-invariants.mjs', ci: true },
  { name: 'live', file: 'scripts/verify-live.mjs', ci: false, env: {
    DSH_WFXM_FEISHU_CONFIG: '/etc/dsh-wfxm/credentials/feishu.json',
    DSH_WFXM_CREDENTIALS: '/etc/dsh-wfxm/credentials/credentials.yaml',
  } },
  { name: 'patrol', file: 'scripts/verify-patrol.mjs', ci: true },
  { name: 'release', file: 'scripts/verify-release.mjs', ci: true },
  { name: 'eval-loop', file: 'scripts/verify-eval-loop.mjs', ci: true },
  { name: 'serve', file: 'scripts/verify-serve.mjs', ci: true },
]

function discover() {
  const found = []
  for (const dir of ['scripts', ...readdirSync(join(root, 'plugins')).map((name) => `plugins/${name}/scripts`)]) {
    let entries
    try {
      entries = readdirSync(join(root, dir))
    } catch {
      continue
    }
    for (const file of entries) {
      if (file === 'verify-all.mjs') continue // the runner itself
      if (/^verify-.*\.mjs$/.test(file)) found.push(join(dir, file))
    }
  }
  return found.sort()
}

const registered = new Set(SUITES.map((suite) => suite.file))
const missing = discover().filter((file) => !registered.has(file))
if (missing.length > 0) {
  console.error('unregistered verify suite(s) — add them to scripts/verify-all.mjs:')
  for (const file of missing) console.error(`  ${file}`)
  process.exit(1)
}

const selected = SUITES
  .filter((suite) => (ci ? suite.ci : true))
  .filter((suite) => liveEnabled || suite.name !== 'live')
  .filter((suite) => only === null || suite.file.includes(only))

if (listOnly) {
  for (const suite of selected) console.log(`${suite.ci ? 'ci' : 'host'}  ${suite.name}  ${suite.file}`)
  process.exit(0)
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const results = []
const startedAll = Date.now()

for (const suite of selected) {
  const started = Date.now()
  process.stdout.write(`… ${suite.name}`)
  const env = { ...process.env, ...(suite.env ?? {}) }
  delete env.LD_LIBRARY_PATH
  const run = spawnSync(process.execPath, [suite.file], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 600_000,
  })
  const ms = Date.now() - started
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim()
  const advisory = suite.advisoryWhenRoot === true && isRoot
  const status = run.status === 0 ? 'PASS' : advisory ? 'ADV' : 'FAIL'
  results.push({ suite, status, ms, output })
  process.stdout.write(`\r${status}  ${suite.name} (${ms}ms)${' '.repeat(20)}\n`)
  if (status !== 'PASS') {
    const tail = output.split('\n').slice(-4).join(' | ').slice(0, 500)
    console.log(`     ${tail}`)
  }
}

const failed = results.filter((item) => item.status === 'FAIL')
const advisory = results.filter((item) => item.status === 'ADV')
const passed = results.filter((item) => item.status === 'PASS')

console.log(`\n${passed.length} passed · ${failed.length} failed · ${advisory.length} advisory · ${Date.now() - startedAll}ms`)
if (!liveEnabled && !ci && only === null) {
  console.log('  skipped: live — 会往真实飞书会话发消息；设 DSH_WFXM_VERIFY_LIVE=1 才跑')
}
for (const item of advisory) console.log(`  advisory: ${item.suite.name} (${item.suite.file})`)

if (failed.length > 0) {
  for (const item of failed) console.log(`  failed: ${item.suite.name} (${item.suite.file})`)
  process.exit(1)
}
