/**
 * E3 项目级授权（Slice AX）：白名单加载与 `project-tool` 判定。
 *
 * 运行：node plugins/governance/scripts/verify-project-tools.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, loadPolicy } from '../lib/index.js'

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    const ok = await fn()
    if (ok) {
      pass++
      console.log(`PASS  ${name}`)
    } else {
      fail++
      console.log(`FAIL  ${name}`)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-project-tools-'))

function mount(name, tools) {
  const root = join(dir, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'policy.yaml'), [
    'version: 1',
    'killSwitchFile: KILL',
    'projectToolsFile: project-tools.json',
    'writeRoots: []',
    'readRoots: []',
  ].join('\n'))
  if (tools !== null) {
    writeFileSync(
      join(root, 'project-tools.json'),
      typeof tools === 'string' ? tools : JSON.stringify(tools, null, 2),
    )
  }
  process.env.DSH_WFXM_POLICY = join(root, 'policy.yaml')
  return loadPolicy()
}

const policy = mount('strict', {
  default: ['read'],
  projects: {
    'proj-a': ['read', 'write', 'exec_*', 'mail_read'],
  },
})

await check('a project allowlist admits listed tools', async () =>
  evaluate(policy, 'read', {}, 'proj-a').verdict === 'allow')

await check('suffix wildcards admit a tool family', async () =>
  evaluate(policy, 'exec_run', {}, 'proj-a').verdict === 'allow'
  && evaluate(policy, 'exec_start', {}, 'proj-a').verdict === 'allow')

await check('an unlisted tool is denied with rule=project-tool', async () => {
  const verdict = evaluate(policy, 'mail_search', {}, 'proj-a')
  return verdict.verdict === 'deny'
    && verdict.rule === 'project-tool'
    && verdict.reason.includes('proj-a')
})

await check('an unregistered project falls back to default', async () =>
  evaluate(policy, 'read', {}, 'proj-b').verdict === 'allow'
  && evaluate(policy, 'write', {}, 'proj-b').verdict === 'deny')

await check('no project id keeps the pre-E3 behaviour', async () =>
  evaluate(policy, 'write', {}).verdict === 'allow'
  && evaluate(policy, 'mail_search', {}, null).verdict === 'allow')

await check('a missing allowlist file disables E3', async () => {
  const lenient = mount('missing', null)
  return lenient.projectTools === null
    && evaluate(lenient, 'write', {}, 'proj-a').verdict === 'allow'
})

await check('a malformed allowlist fails closed at mount', async () => {
  try {
    mount('broken', '{ not json')
    return false
  } catch (error) {
    return error instanceof Error && error.message.includes('Unexpected')
      || error instanceof SyntaxError
  }
})

const killRoot = mount('kill', { default: ['read'], projects: {} })
writeFileSync(join(killRoot.killSwitchPath), '1')
await check('the kill switch still wins over a project allowlist', async () =>
  evaluate(killRoot, 'read', {}, 'proj-a').rule === 'kill-switch')
rmSync(join(killRoot.killSwitchPath), { force: true })

await check('DSH_WFXM_HALT_FILE overrides the policy-relative kill switch', async () => {
  const runtimeKill = join(dir, 'runtime-KILL')
  process.env.DSH_WFXM_HALT_FILE = runtimeKill
  const resolved = loadPolicy().killSwitchPath === runtimeKill
  delete process.env.DSH_WFXM_HALT_FILE
  return resolved
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed · ${fail} failed`)
if (fail > 0) process.exit(1)
