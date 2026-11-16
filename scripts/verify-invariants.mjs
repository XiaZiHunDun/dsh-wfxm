import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCrossModuleImports, checkPortIsolation, runChecks } from './check-invariants.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'check-invariants.mjs')

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

const dirs = []
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'invariants-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

check('clean tree passes (ports absent, workspace API import allowed)', () => {
  const root = fixture({
    'plugins/a/src/x.ts': "import { createNtfyFromEnv } from '@dsh-wfxm/notify'\nexport const x = createNtfyFromEnv\n",
  })
  const { ok, findings } = runChecks(root)
  assert.equal(ok, true, JSON.stringify(findings))
})

check('AR32: command name under ports/ is reported with line', () => {
  const root = fixture({
    'ports/svc.ts': "export interface SvcPort {}\n// calls systemctl restart\nexport const ok = 1\n",
  })
  const findings = checkPortIsolation(root)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'AR32')
  assert.equal(findings[0].line, 2)
  assert.match(findings[0].detail, /systemctl/)
})

check('AR32: product name and Chinese product name are both caught', () => {
  const root = fixture({
    'ports/a.ts': "export type Channel = 'feishu'\n",
    'ports/b.ts': "export const note = '微信兜底'\n",
  })
  const findings = checkPortIsolation(root)
  assert.equal(findings.length, 2)
  assert.deepEqual(findings.map((f) => f.file).sort(), ['ports/a.ts', 'ports/b.ts'])
})

check('AR32: nested ports directory inside a plugin is scanned', () => {
  const root = fixture({
    'plugins/a/src/ports/iface.ts': '// docker socket proxy\nexport const x = 1\n',
  })
  assert.equal(checkPortIsolation(root).length, 1)
})

check('AR32: clean port file with neutral words passes', () => {
  const root = fixture({
    'ports/iface.ts': 'export interface ListOptions { limit: number }\nexport const NAME = "runtime"\n',
  })
  assert.deepEqual(checkPortIsolation(root), [])
})

check('AR33: relative import escaping the package is a violation', () => {
  const root = fixture({
    'plugins/a/src/x.ts': "import { openDb } from '../../b/src/store.js'\n",
    'plugins/b/src/store.ts': 'export const openDb = 1\n',
  })
  const findings = checkCrossModuleImports(root)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'AR33')
  assert.match(findings[0].detail, /跨模块相对导入/)
})

check('AR33: deep import into another package store is a violation', () => {
  const root = fixture({
    'plugins/a/src/x.ts': "import { rows } from '@dsh-wfxm/b/lib/store.js'\nimport { t } from '@dsh-wfxm/b/lib/schema'\n",
  })
  const findings = checkCrossModuleImports(root)
  assert.equal(findings.length, 2)
  assert.ok(findings.every((f) => f.rule === 'AR33'))
})

check('AR33: bare workspace import and same-package store import are allowed', () => {
  const root = fixture({
    'plugins/a/src/x.ts': "import { notify } from '@dsh-wfxm/b'\nimport { mine } from './store.js'\n",
    'plugins/a/src/store.ts': 'export const mine = 1\n',
    'plugins/b/src/index.ts': 'export const notify = 1\n',
  })
  assert.deepEqual(checkCrossModuleImports(root), [])
})

check('AR33: dynamic import and require are parsed too', () => {
  const root = fixture({
    'plugins/a/src/x.ts': "const a = await import('@dsh-wfxm/b/lib/tables.js')\nconst b = require('../../b/src/store')\n",
  })
  const findings = checkCrossModuleImports(root)
  assert.equal(findings.length, 2)
})

check('CLI exits 0 on a clean tree', () => {
  const root = fixture({ 'plugins/a/src/x.ts': 'export const x = 1\n' })
  const run = spawnSync(process.execPath, [CLI, root], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /invariants: OK/)
})

check('CLI exits 1 and prints violations', () => {
  const root = fixture({
    'ports/leak.ts': '// uses journalctl\nexport const x = 1\n',
    'plugins/a/src/x.ts': "import { t } from '@dsh-wfxm/b/lib/tables'\n",
  })
  const run = spawnSync(process.execPath, [CLI, root], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /AR32 {2}ports\/leak\.ts:1/)
  assert.match(run.stderr, /AR33 {2}plugins\/a\/src\/x\.ts:1/)
  assert.match(run.stderr, /2 violation\(s\)/)
})

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })

console.log(`\ninvariants: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
