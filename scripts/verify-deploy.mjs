/**
 * Deploy artifact verification (slice H): the unit / env / polkit files are
 * claims about the host, so check them mechanically instead of by reading.
 *
 *   node scripts/verify-deploy.mjs
 *
 * - systemd unit: required hardening + a real `systemd-analyze verify` run
 *   (paths substituted to this machine; production expects /usr/bin/node).
 * - polkit rule: executed against a stub `polkit` object and asserted to allow
 *   exactly `dsh-wfxm-managed-*` for user `dshwfxm` on manage-units.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const unitPath = join(repoRoot, 'deploy/systemd/dsh-wfxm.service')
const backupUnitPath = join(repoRoot, 'deploy/systemd/dsh-wfxm-backup.service')
const timerPath = join(repoRoot, 'deploy/systemd/dsh-wfxm-backup.timer')
const journaldPath = join(repoRoot, 'deploy/journald/10-dsh-wfxm.conf')
const envPath = join(repoRoot, 'deploy/systemd/dsh-wfxm.env.example')
const polkitPath = join(repoRoot, 'deploy/polkit/50-dshwfxm.rules')

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    const detail = fn()
    passed += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(ok, message) {
  if (!ok) throw new Error(message)
}

const unit = readFileSync(unitPath, 'utf8')
const backupUnit = readFileSync(backupUnitPath, 'utf8')
const timer = readFileSync(timerPath, 'utf8')
const journald = readFileSync(journaldPath, 'utf8')
const envExample = readFileSync(envPath, 'utf8')

check('unit: 非 root + 单实例 + 只写数据目录', () => {
  const required = [
    'User=dshwfxm',
    'Group=dshwfxm',
    'Restart=on-failure',
    'TimeoutStopSec=30',
    'KillSignal=SIGTERM',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'PrivateTmp=yes',
    'RestrictSUIDSGID=yes',
    'CapabilityBoundingSet=',
    'ReadWritePaths=/var/lib/dsh-wfxm /var/backups/dsh-wfxm',
  ]
  const missing = required.filter((line) => !unit.includes(line))
  assert(missing.length === 0, `missing: ${missing.join(' | ')}`)
  assert(unit.includes('Environment=HOME=/var/lib/dsh-wfxm/home'), 'HOME not redirected; ProtectHome would hide dsh state')
  assert(!/User=root/.test(unit), 'must not run as root')
  assert(!/docker/.test(unit), 'unit must not request docker access')
  return '12 directives'
})

check('unit: ExecStart 指向 scripts/serve.mjs，环境来自 /etc/dsh-wfxm/env', () => {
  const exec = /^ExecStart=(.+)$/m.exec(unit)?.[1]?.trim()
  assert(exec !== undefined, 'no ExecStart')
  assert(exec.endsWith(' scripts/serve.mjs'), `ExecStart=${exec}`)
  assert(existsSync(join(repoRoot, 'scripts/serve.mjs')), 'scripts/serve.mjs missing')
  assert(unit.includes('EnvironmentFile=/etc/dsh-wfxm/env'), 'missing EnvironmentFile')
  assert(unit.includes('WorkingDirectory=/opt/dsh-wfxm/current'), 'WorkingDirectory must be the blue-green symlink')
  return exec
})

check('env 模板与 unit 的环境变量一致（非敏感项）', () => {
  const keys = ['DSH_WFXM_DATA_DIR', 'DSH_WFXM_CHANNEL', 'DSH_WFXM_FOREGROUND', 'DSH_WFXM_DSH_BIN', 'DSH_WFXM_FEISHU_CONFIG', 'DSH_WFXM_CREDENTIALS', 'DSH_WFXM_BACKUP_DIR', 'DSH_WFXM_BACKUP_KEEP']
  const missing = keys.filter((key) => !envExample.includes(`${key}=`))
  assert(missing.length === 0, `env example missing: ${missing.join(', ')}`)
  assert(!/app_secret|token|password/i.test(envExample), 'env example must not carry secrets')
  return `${keys.length} keys`
})

check('systemd-analyze verify 通过（路径替换到本机）', () => {
  if (!existsSync('/usr/bin/systemd-analyze') && !which('systemd-analyze')) return 'skipped: systemd-analyze not installed'
  const dir = mkdtempSync(join(tmpdir(), 'wfxm-unit-'))
  try {
    const envFile = join(dir, 'env')
    writeFileSync(envFile, 'DSH_WFXM_DATA_DIR=/tmp/wfxm-unit\n')
    const substituted = unit
      .replace(/^ExecStart=.*$/m, `ExecStart=${process.execPath} ${join(repoRoot, 'scripts/serve.mjs')}`)
      .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${repoRoot}`)
      .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${envFile}`)
      .replace(/^ReadWritePaths=.*$/m, `ReadWritePaths=${dir}`)
      .replace(/^Documentation=.*$/m, '')
    const file = join(dir, 'dsh-wfxm.service')
    writeFileSync(file, substituted)
    const output = execFileSync('systemd-analyze', ['verify', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return output.trim() === '' ? 'clean' : `warnings: ${output.trim().split('\n').length}`
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? ''
    throw new Error(`systemd-analyze verify failed\n${stderr || error.message}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('backup unit：oneshot + 非 root + 只写数据与备份目录', () => {
  const required = [
    'Type=oneshot',
    'User=dshwfxm',
    'Group=dshwfxm',
    'EnvironmentFile=/etc/dsh-wfxm/env',
    'ExecStart=/usr/bin/node /opt/dsh-wfxm/current/scripts/backup.mjs',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'PrivateTmp=yes',
    'ReadWritePaths=/var/lib/dsh-wfxm /var/backups/dsh-wfxm',
  ]
  const missing = required.filter((line) => !backupUnit.includes(line))
  assert(missing.length === 0, `missing: ${missing.join(' | ')}`)
  assert(!/User=root/.test(backupUnit), 'backup must not run as root')
  assert(existsSync(join(repoRoot, 'scripts/backup.mjs')), 'scripts/backup.mjs missing')
  return `${required.length} directives`
})

check('backup timer 每日 03:30 Persistent；journald 上限 500M/50M/30day', () => {
  for (const line of ['OnCalendar=*-*-* 03:30:00', 'RandomizedDelaySec=15m', 'Persistent=true', 'WantedBy=timers.target']) {
    assert(timer.includes(line), `timer missing ${line}`)
  }
  assert(journald.includes('[Journal]'), 'journald drop-in missing [Journal]')
  for (const line of ['SystemMaxUse=500M', 'SystemMaxFileSize=50M', 'MaxRetentionSec=30day']) {
    assert(journald.includes(line), `journald missing ${line}`)
  }
  return '4 timer + 4 journald lines'
})

check('install.sh：安装 backup unit/timer/drop-in，只 enable timer（不 --now）', () => {
  const install = readFileSync(join(repoRoot, 'deploy/install.sh'), 'utf8')
  for (const rel of ['systemd/dsh-wfxm-backup.service', 'systemd/dsh-wfxm-backup.timer', 'journald/10-dsh-wfxm.conf']) {
    assert(install.includes(rel), `install.sh does not reference ${rel}`)
  }
  assert(/systemctl enable dsh-wfxm-backup\.timer/.test(install), 'install.sh must enable the timer')
  assert(!/enable\s+--now\s+dsh-wfxm-backup/.test(install), 'install.sh must not --now the backup')
  assert(/restart systemd-journald/.test(install), 'journald drop-in changes must restart systemd-journald')
  return 'referenced + enabled'
})

check('systemd-analyze：backup unit 可 verify，journald drop-in 可解析', () => {
  if (!existsSync('/usr/bin/systemd-analyze') && !which('systemd-analyze')) return 'skipped: systemd-analyze not installed'
  const dir = mkdtempSync(join(tmpdir(), 'wfxm-backup-unit-'))
  try {
    const envFile = join(dir, 'env')
    writeFileSync(envFile, 'DSH_WFXM_BACKUP_DIR=/tmp/wfxm-backup\n')
    const substituted = backupUnit
      .replace(/^ExecStart=.*$/m, `ExecStart=${process.execPath} ${join(repoRoot, 'scripts/backup.mjs')}`)
      .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${repoRoot}`)
      .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${envFile}`)
      .replace(/^ReadWritePaths=.*$/m, `ReadWritePaths=${dir}`)
      .replace(/^Documentation=.*$/m, '')
    const file = join(dir, 'dsh-wfxm-backup.service')
    writeFileSync(file, substituted)
    execFileSync('systemd-analyze', ['verify', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

    const root = join(dir, 'root')
    mkdirSync(join(root, 'etc/systemd/journald.conf.d'), { recursive: true })
    writeFileSync(join(root, 'etc/systemd/journald.conf.d/10-dsh-wfxm.conf'), journald)
    const merged = execFileSync('systemd-analyze', ['cat-config', 'systemd/journald.conf', `--root=${root}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const line of ['SystemMaxUse=500M', 'SystemMaxFileSize=50M', 'MaxRetentionSec=30day']) {
      assert(merged.includes(line), `cat-config did not pick up ${line}`)
    }
    return 'unit + drop-in clean'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('polkit: 只放行 dshwfxm 对 dsh-wfxm-managed-* 的 manage-units', () => {
  const source = readFileSync(polkitPath, 'utf8')
  const rules = []
  const polkit = {
    Result: { YES: 'YES', NO: 'NO', AUTH_ADMIN: 'AUTH_ADMIN' },
    addRule: (callback) => rules.push(callback),
  }
  // The rule file is plain JS evaluated by polkitd; running it here asserts the
  // branching, not just the text.
  new Function('polkit', source)(polkit)
  assert(rules.length === 1, `expected 1 rule, got ${rules.length}`)
  const rule = rules[0]
  const action = (id, unitName) => ({ id, lookup: (key) => (key === 'unit' ? unitName : null) })
  const subject = (user) => ({ user })
  const cases = [
    ['managed unit → YES', rule(action('org.freedesktop.systemd1.manage-units', 'dsh-wfxm-managed-blog.service'), subject('dshwfxm')), 'YES'],
    ['unmanaged unit → undefined', rule(action('org.freedesktop.systemd1.manage-units', 'nginx.service'), subject('dshwfxm')), undefined],
    ['other user → undefined', rule(action('org.freedesktop.systemd1.manage-units', 'dsh-wfxm-managed-blog.service'), subject('root')), undefined],
    ['other action → undefined', rule(action('org.freedesktop.systemd1.manage-unit-files', 'dsh-wfxm-managed-blog.service'), subject('dshwfxm')), undefined],
    ['missing unit → undefined', rule(action('org.freedesktop.systemd1.manage-units', undefined), subject('dshwfxm')), undefined],
  ]
  for (const [label, actual, expected] of cases) {
    assert(actual === expected, `${label}: got ${actual}, want ${expected}`)
  }
  return '5 branches'
})

check('managed-unit wrapper：verb / 托管前缀 / 字符集三重校验', () => {
  const wrapperPath = join(repoRoot, 'deploy/bin/dsh-wfxm-unit-control')
  const run = (verb, unit) => {
    try {
      const stdout = execFileSync('/bin/sh', [wrapperPath, verb, unit], {
        env: { ...process.env, DSH_WFXM_SYSTEMCTL: '/bin/echo' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { code: 0, stdout: stdout.trim() }
    } catch (error) {
      return { code: error.status ?? 1, stdout: '' }
    }
  }
  const allowed = run('restart', 'dsh-wfxm-managed-blog.service')
  assert(allowed.code === 0, `managed restart should pass, got ${allowed.code}`)
  assert(allowed.stdout === 'restart dsh-wfxm-managed-blog.service', `unexpected exec: ${allowed.stdout}`)
  assert(run('stop', 'nginx.service').code === 64, 'unmanaged unit must be denied')
  assert(run('disable', 'dsh-wfxm-managed-blog.service').code === 64, 'non start/stop/restart verb must be denied')
  assert(run('restart', 'dsh-wfxm-managed-../evil.service').code === 64, 'dot-dot unit must be denied')
  return '4 branches'
})

check('sudoers 片段只授权 wrapper（NOPASSWD，不放开任意命令）', () => {
  const source = readFileSync(join(repoRoot, 'deploy/sudoers/dsh-wfxm-unit-control'), 'utf8')
  const lines = source.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  assert(lines.length === 1, `expected 1 rule line, got ${lines.length}`)
  assert(/^dshwfxm\s+ALL=\(root\)\s+NOPASSWD:\s+\/usr\/local\/sbin\/dsh-wfxm-unit-control\s+\*\s*$/.test(lines[0]), lines[0])
  return 'wrapper only'
})

function which(bin) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, bin))) return join(dir, bin)
  }
  return null
}

rmSync(join(tmpdir(), 'wfxm-unit-'), { recursive: true, force: true })
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
