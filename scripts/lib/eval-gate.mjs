/**
 * `/eval` 硬门禁开关（P2-4）：观察期截止前 advisory，之后默认硬门禁。
 *
 * `scripts/eval/snapshot.mjs` 与 `scripts/release.mjs` 共用同一判定，
 * 避免观察期日期与环境变量口径在两处漂移。
 */
export const EVAL_HARD_GATE_AFTER = Date.parse('2026-12-08T00:00:00+08:00')

/**
 * `EVAL_HARD_GATE=1/0` 显式覆盖；未设置时按观察期截止判定。
 * `hard` / `advisory` 供脚本单次参数覆盖（snapshot 的 `--hard|--advisory`），
 * 优先级低于环境变量。
 */
export function evalHardGate({ hard = false, advisory = false, now = Date.now() } = {}) {
  const override = process.env.EVAL_HARD_GATE
  if (override === '1') return true
  if (override === '0') return false
  if (hard) return true
  if (advisory) return false
  return now >= EVAL_HARD_GATE_AFTER
}
