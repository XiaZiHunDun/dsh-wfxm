/**
 * Deterministic risk escalation for the front desk (17 §7.1 / §8.3).
 *
 * The model may only propose R0/R1 (`parseDecision` rejects R2/R3), so opening
 * R2/R3 cannot come from the model — it comes from this rule layer, which can
 * only raise risk, never lower it. An escalation ships with the template
 * assertion that makes the task verifiable (13 §3.1: R2+ without criteria is
 * refused at both submit and completion).
 *
 * v1 template: restart/start of a managed systemd unit → R3 + `unit_restarted`
 * (proof the restart happened) + `service_active` (proof it is healthy now).
 * v2 template: writing to an explicit absolute file → R2 + `file_exists`.
 * Anything without a derivable assertion stays at its baseline risk, so the
 * "no criteria, no R2+" invariant is never bypassed.
 */

import { prepareAssertions, type PreparedAssertion } from './assertions.js'
import type { RiskLevel } from './model.js'

export interface RiskPlan {
  risk: RiskLevel
  /** Which rule fired, for the route decision / audit trail. */
  reasons: string[]
  assertions: PreparedAssertion[]
}

const START_OP = /(重启|重新启动|启动|拉起|restart|\bstart\b)/i
const EXPLICIT_UNIT = /\b(dsh-wfxm-managed-[a-z0-9][a-z0-9-]*\.service)\b/i
const NAMED_SERVICE =
  /(?:重启|重新启动|启动|拉起|restart|\bstart\b)\s*(?:一下|一遍)?\s*([a-z0-9][a-z0-9_.-]{0,40})\s*(?:服务|service)/i
/** A verb followed by this is a question about state, not a command. */
const STATE_QUESTION = /^\s*(是否|有没有|正常|健康|状态)/
/** How close the verb must sit to the unit to count as operating on it. */
const VERB_WINDOW = 14

/**
 * Was the start verb used as an *operation* on this unit? Distance alone is not
 * enough: "dsh-wfxm-managed-demo.service 启动是否正常" reads like a command but is
 * a question, and escalating it to R3 made a pure log read need two approvals
 * (2026-11-13 实测).
 */
function startOpNear(intent: string, unit: string): boolean {
  const at = intent.toLowerCase().indexOf(unit)
  if (at < 0) return false
  const matches = (window: string): boolean => {
    const hit = START_OP.exec(window)
    if (hit === null) return false
    return !STATE_QUESTION.test(window.slice(hit.index + hit[0].length))
  }
  const before = intent.slice(Math.max(0, at - VERB_WINDOW), at)
  const after = intent.slice(at + unit.length, at + unit.length + VERB_WINDOW)
  return matches(before) || matches(after)
}

function normalizeManaged(name: string): string {
  const bare = name.toLowerCase().replace(/\.service$/, '')
  return `${bare.startsWith('dsh-wfxm-managed-') ? bare : `dsh-wfxm-managed-${bare}`}.service`
}

/** Return the managed systemd unit this intent is starting/restarting, if unambiguous. */
export function managedUnitFor(intent: string): string | null {
  const explicit = EXPLICIT_UNIT.exec(intent)
  if (explicit !== null && startOpNear(intent, explicit[1].toLowerCase())) return explicit[1].toLowerCase()
  const named = NAMED_SERVICE.exec(intent)
  if (named !== null) return normalizeManaged(named[1])
  return null
}

const FILE_WRITE_OP = /(创建|新建|写入|写到|写进|生成|保存|追加|修改|改成|编辑)/
/**
 * Absolute path with ≥2 segments and an extension. A relative path is *not*
 * escalated: `file_exists` stats the path verbatim, and the service cwd is the
 * release dir, not the task workspace — resolving it would be a guess.
 */
const WRITTEN_FILE =
  /(?:^|[\s"'`（(“])(\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`”）),，。；;])/

/** Return the absolute file this intent writes to, if it is unambiguous. */
export function writtenFileFor(intent: string): string | null {
  if (!FILE_WRITE_OP.test(intent)) return null
  const hit = WRITTEN_FILE.exec(intent)
  return hit === null ? null : hit[1]
}

/**
 * Raise a baseline R0/R1 task when the intent is a state-changing service
 * operation that has a template assertion. `stop` is intentionally absent:
 * there is no negative `service_active` assertion kind, so it stays baseline
 * (and the tool-level approval still fails closed).
 */
export function planTaskRisk(intent: string, baseline: RiskLevel): RiskPlan {
  if (baseline === 'R2' || baseline === 'R3') {
    return { risk: baseline, reasons: [], assertions: [] }
  }
  const unit = managedUnitFor(intent)
  if (unit !== null) {
    const assertions = prepareAssertions([
      { kind: 'unit_restarted', unit },
      { kind: 'service_active', unit },
    ])
    return {
      risk: 'R3',
      reasons: [`svc-start:${unit}`],
      assertions,
    }
  }

  const file = writtenFileFor(intent)
  if (file !== null) {
    return {
      risk: 'R2',
      reasons: [`file-write:${file}`],
      assertions: prepareAssertions([{ kind: 'file_exists', path: file }]),
    }
  }
  return { risk: baseline, reasons: [], assertions: [] }
}
