import { rmSync } from 'node:fs'
import { createApprovalStore } from '../lib/approval/store.js'

const dbPath = '/tmp/dsh-wfxm-approval-test.sqlite'
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })

let clock = new Date('2026-11-04T00:00:00.000Z')
const store = createApprovalStore(dbPath, {
  now: () => clock,
  nonce: (() => {
    let n = 0
    // Pad with a non-numeric char: `nonce-1` + zeros would collide with
    // `nonce-10` + zeros once the counter reaches double digits.
    return () => `nonce-${++n}`.padEnd(64, 'a')
  })(),
})

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const first = store.create({
  correlationId: 'corr-1',
  level: 'R2',
  summary: 'restart nginx',
  impact: { unit: 'nginx.service' },
})
check('create returns uuid v7 id', /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(first.id), first.id)
check('create returns 64-char nonce', first.nonce.length === 64, first.nonce)
check('create sets 10-minute expiry',
  new Date(first.expiresAt).getTime() - new Date(first.requestedAt).getTime() === 600_000,
  first.expiresAt)

const pending = store.get(first.id)
check('record starts pending', pending?.status === 'pending', pending?.status)
check('impact round-trips as object', pending?.impact.unit === 'nginx.service', JSON.stringify(pending?.impact))

const wrongNonce = store.answer({
  approvalId: first.id,
  decision: 'approved',
  actorId: 'owner',
  nonce: 'not-the-nonce',
})
check('wrong nonce is rejected', wrongNonce.ok === false && wrongNonce.code === 'nonce-invalid', wrongNonce.code)
check('wrong nonce does not consume the approval', store.get(first.id)?.status === 'pending')

const emptyActor = store.answer({
  approvalId: first.id,
  decision: 'approved',
  actorId: '   ',
  nonce: first.nonce,
})
check('empty actor is rejected', emptyActor.ok === false && emptyActor.code === 'actor-invalid', emptyActor.code)

const approved = store.answer({
  approvalId: first.id,
  decision: 'approved',
  actorId: 'owner',
  nonce: first.nonce,
})
check('correct nonce + actor approves', approved.ok === true && approved.status === 'approved', approved.code)
const decided = store.get(first.id)
check('decided_by records the actor', decided?.decidedBy === 'owner', decided?.decidedBy)
check('nonce_consumed_at is set', Boolean(decided?.nonceConsumedAt), decided?.nonceConsumedAt)

const replay = store.answer({
  approvalId: first.id,
  decision: 'approved',
  actorId: 'owner',
  nonce: first.nonce,
})
check('replayed nonce is refused', replay.ok === false && replay.code === 'not-pending', replay.code)

const second = store.create({
  correlationId: 'corr-2',
  level: 'R3',
  summary: 'drop database',
  impact: { database: 'ops' },
})
const rejected = store.answer({
  approvalId: second.id,
  decision: 'rejected',
  actorId: 'owner',
  nonce: second.nonce,
})
check('reject path records rejected', rejected.ok === true && rejected.status === 'rejected', rejected.code)

const expiring = store.create({
  correlationId: 'corr-3',
  level: 'R2',
  summary: 'short-lived',
  impact: {},
  ttlMs: 1_000,
})
clock = new Date('2026-11-04T00:00:02.000Z')
const late = store.answer({
  approvalId: expiring.id,
  decision: 'approved',
  actorId: 'owner',
  nonce: expiring.nonce,
})
check('expired approval is refused', late.ok === false && late.code === 'expired', late.code)
check('expired approval is marked expired', store.get(expiring.id)?.status === 'expired', store.get(expiring.id)?.status)
check('expired approval cannot be approved later', store.answer({
  approvalId: expiring.id,
  decision: 'approved',
  actorId: 'owner',
  nonce: expiring.nonce,
}).code === 'not-pending')

const withdrawn = store.create({
  correlationId: 'corr-4',
  level: 'R2',
  summary: 'withdraw me',
  impact: {},
})
const w = store.withdraw(withdrawn.id)
check('withdraw marks withdrawn', w.ok === true && w.status === 'withdrawn', w.code)
check('withdrawn approval cannot be answered', store.answer({
  approvalId: withdrawn.id,
  decision: 'approved',
  actorId: 'owner',
  nonce: withdrawn.nonce,
}).code === 'not-pending')

check('unknown approval returns not-found', store.answer({
  approvalId: '01900000-0000-7000-8000-000000000000',
  decision: 'approved',
  actorId: 'owner',
  nonce: 'x',
}).code === 'not-found')

// P1 (slice G): the channel records the card id it rendered so it can patch it later.
const carded = store.create({
  correlationId: 'corr-5',
  level: 'R2',
  summary: 'needs a card',
  impact: {},
})
check('setExternalMsgId records the card id', store.setExternalMsgId(carded.id, 'om_card_1') === true)
check('card id round-trips', store.get(carded.id)?.externalMsgId === 'om_card_1', store.get(carded.id)?.externalMsgId)
check('setExternalMsgId is idempotent', store.setExternalMsgId(carded.id, 'om_card_2') === true
  && store.get(carded.id)?.externalMsgId === 'om_card_2')
check('setExternalMsgId rejects unknown id', store.setExternalMsgId('01900000-0000-7000-8000-000000000001', 'om_x') === false)
check('setExternalMsgId rejects empty id', store.setExternalMsgId(carded.id, '') === false)
check('card id does not change the decision path', store.get(carded.id)?.status === 'pending')

// P2 (slice L): R3 is a two-step decision; R2 stays one click.
const highRisk = store.create({
  correlationId: 'corr-r3',
  level: 'R3',
  summary: 'restart dsh-wfxm-managed-demo.service',
  impact: { unit: 'dsh-wfxm-managed-demo.service' },
})
const firstClick = store.answer({
  approvalId: highRisk.id,
  decision: 'approved',
  actorId: 'owner',
  nonce: highRisk.nonce,
})
const staged = store.get(highRisk.id)
check('R3 first approve click asks for confirmation',
  firstClick.ok === false && firstClick.code === 'confirm-required', firstClick.code)
check('confirm-required echoes stage 1 and the unconsumed nonce',
  firstClick.stage === 1 && firstClick.nonce === highRisk.nonce)
check('staged R3 stays pending with no decision',
  staged.status === 'pending' && staged.decidedAt === null && staged.nonceConsumedAt === null)
check('staged R3 records who clicked first',
  staged.confirmStage === 1 && staged.confirmActor === 'owner' && staged.confirmAt !== null)

const again = store.answer({
  approvalId: highRisk.id,
  decision: 'approved',
  actorId: 'owner',
  nonce: highRisk.nonce,
})
check('a second approve click still does not settle R3', again.code === 'confirm-required')
check('double-clicking approve never consumes the nonce', store.get(highRisk.id).nonceConsumedAt === null)

const otherActor = store.answer({
  approvalId: highRisk.id,
  decision: 'confirmed',
  actorId: 'someone-else',
  nonce: highRisk.nonce,
})
check('another actor cannot finish the first click', otherActor.code === 'confirm-invalid', otherActor.code)

const confirmed = store.answer({
  approvalId: highRisk.id,
  decision: 'confirmed',
  actorId: 'owner',
  nonce: highRisk.nonce,
})
check('the dedicated confirm click settles R3',
  confirmed.ok === true && confirmed.status === 'approved', confirmed.code)
check('confirmed R3 records the decider and consumes the nonce',
  store.get(highRisk.id).decidedBy === 'owner' && store.get(highRisk.id).nonceConsumedAt !== null)
check('confirm is single-use',
  store.answer({
    approvalId: highRisk.id,
    decision: 'confirmed',
    actorId: 'owner',
    nonce: highRisk.nonce,
  }).code === 'not-pending')

const lowRisk = store.create({ correlationId: 'corr-r2-confirm', level: 'R2', summary: 'restart nginx' })
check('R2 has no second confirmation step',
  store.answer({
    approvalId: lowRisk.id,
    decision: 'confirmed',
    actorId: 'owner',
    nonce: lowRisk.nonce,
  }).code === 'confirm-invalid')
check('R2 still needs only one approve click',
  store.answer({
    approvalId: lowRisk.id,
    decision: 'approved',
    actorId: 'owner',
    nonce: lowRisk.nonce,
  }).ok === true)

const readOnly = store.create({ correlationId: 'corr-read', level: 'R3', summary: 'read me' })
store.get(readOnly.id)
store.get(readOnly.id)
check('reading details never changes the approval',
  store.get(readOnly.id)?.status === 'pending'
  && store.get(readOnly.id)?.nonceConsumedAt === null
  && store.get(readOnly.id)?.confirmStage === 0)

// P3: a never-clicked approval must be sweepable, otherwise its task stays parked.
const stale = store.create({
  correlationId: 'corr-stale',
  level: 'R3',
  summary: 'never clicked',
  impact: {},
  taskId: 'task-1',
  ttlMs: 1_000,
})
const live = store.create({ correlationId: 'corr-live', level: 'R2', summary: 'still waiting', impact: {} })
clock = new Date('2026-11-04T00:00:05.000Z')
const swept = store.expireOverdue()
check('expireOverdue sweeps only overdue pendings',
  swept.length === 1 && swept[0].approvalId === stale.id && swept[0].taskId === 'task-1',
  JSON.stringify(swept))
check('swept approval is marked expired', store.get(stale.id)?.status === 'expired')
check('non-overdue pending is left alone', store.get(live.id)?.status === 'pending')
check('a second sweep reports nothing', store.expireOverdue().length === 0)

store.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
