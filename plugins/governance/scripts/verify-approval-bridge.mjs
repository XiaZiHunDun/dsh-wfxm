/**
 * ③ 任务级审批 → 工具级闸门（2026-11-11）。
 *
 * ⑤ 只在 claim 到 R2/R3（= ③ 已批准）的任务时注入 DSH_WFXM_APPROVED_LEVEL；
 * 子进程里的 governance 用它对 `svc_*` 写操作返回 allowed-once，其余委派。
 * 这里用假 ctx 直接驱动注册的 waterfall listener。
 */

import { rmSync } from 'node:fs'

const dbPath = '/tmp/dsh-wfxm-approval-bridge.sqlite'
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
process.env.DSH_WFXM_AUDIT_DB = dbPath

const { apply } = await import('../lib/index.js')

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function mount() {
  const listeners = new Map()
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener)
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  apply(ctx)
  return listeners
}

function setEnv(taskId, level) {
  if (taskId === undefined) delete process.env.DSH_WFXM_TASK_ID
  else process.env.DSH_WFXM_TASK_ID = taskId
  if (level === undefined) delete process.env.DSH_WFXM_APPROVED_LEVEL
  else process.env.DSH_WFXM_APPROVED_LEVEL = level
}

// ---- 已批准 R3 任务：svc_* 放行，其余委派 ------------------------------------

setEnv('task-approved', 'R3')
let listeners = mount()
const answer = listeners.get('approval/request')
check('an approved R3 task registers the approval/request answerer', typeof answer === 'function')

let delegated = 0
const passThrough = async () => {
  delegated += 1
  return 'denied'
}
const svc = await answer({ toolName: 'svc_restart', arguments: { unit: 'dsh-wfxm-managed-demo.service' } }, passThrough)
check('svc_* is allowed once by the task-level approval', svc === 'allowed-once' && delegated === 0, String(svc))

const other = await answer({ toolName: 'write', arguments: { path: '/tmp/x' } }, passThrough)
check('other tools still fall through (fail-closed)', other === 'denied' && delegated === 1, String(other))

const mail = await answer({ toolName: 'mail_archive', arguments: { uids: [7] } }, passThrough)
check('mail_archive is allowed once by the task-level approval', mail === 'allowed-once' && delegated === 1, String(mail))

const search = await answer({ toolName: 'mail_search', arguments: {} }, passThrough)
check('mail_search still falls through', search === 'denied' && delegated === 2, String(search))

// ---- R1 / 无任务：不注册，闸门保持原样 ---------------------------------------

setEnv('task-plain', 'R1')
listeners = mount()
check('an R1 child gets no auto-answerer', listeners.get('approval/request') === undefined)

setEnv(undefined, undefined)
listeners = mount()
check('a host/web process gets no auto-answerer', listeners.get('approval/request') === undefined)

// ---- 只有任务号或只有级别：都不注册 -----------------------------------------

setEnv('task-half', undefined)
listeners = mount()
check('task id without an approved level registers nothing', listeners.get('approval/request') === undefined)

setEnv(undefined, 'R3')
listeners = mount()
check('approved level without a task id registers nothing', listeners.get('approval/request') === undefined)

setEnv(undefined, undefined)
console.log(`\napproval-bridge: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
