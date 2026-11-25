/**
 * `/eval` 的落库版文案（P2-2）。所有输出都不含原文/绝对轨迹，只给 run 短 id 与摘要。
 */

import type { PromoteResult } from './promote.js'
import type { EvalFinding, EvalRun } from './store.js'

function evalRunRef(id: string): string {
  return id.slice(0, 8)
}

export function formatEvalRunStarted(run: EvalRun): string {
  return `已开始 L2 离线测评（run ${evalRunRef(run.id)}，约 1 秒）；完成后另发结果。`
}

/** 同一 5 分钟桶内重复请求：返回已有 run，不重跑。 */
export function formatEvalRunReused(run: EvalRun): string {
  return run.status === 'running'
    ? `L2 测评已在运行（run ${evalRunRef(run.id)}），不重复执行。`
    : `本时段已跑过 L2（run ${evalRunRef(run.id)}，${run.status}），不重复执行；结果见 /eval findings。`
}

export function formatEvalRunFinished(run: EvalRun, findings: readonly EvalFinding[]): string {
  const lines = [
    `测评完成（run ${evalRunRef(run.id)}）· ${run.advisory ? 'advisory' : '硬门禁'}`,
    `L2 离线：${run.passed ?? 0}/${run.total ?? 0} 任务通过`,
  ]
  if (run.status === 'timeout') lines.push('状态：超时，结果不完整（不据此推断通过）。')
  else lines.push(`状态：${run.status === 'ok' ? '通过' : '未通过'}`)
  if (findings.length > 0) {
    const labels = findings.slice(0, 3).map((item) => item.taskId === '' ? item.suite : item.taskId)
    lines.push(`失败 ${findings.length} 项：${labels.join('、')}${findings.length > labels.length ? ' 等' : ''}`)
  } else if (run.status === 'ok') {
    lines.push('失败：无')
  }
  lines.push('明细：/eval findings')
  return lines.join('\n')
}

export function formatEvalDbFindings(findings: readonly EvalFinding[]): string {
  if (findings.length === 0) return '没有未处理失败项。'
  return [
    `未处理 ${findings.length} 项：`,
    ...findings.slice(0, 20).map((item) => {
      const label = item.taskId === '' ? `${item.suite}（套件未全过）` : item.taskId
      const detail = item.detailDigest.replace(/^sha256:[0-9a-f]+ ?/, '').trim()
      return `- [${item.id.slice(0, 8)}] ${label} · ${item.suite}${detail === '' ? '' : `（${detail}）`}`
    }),
    ...(findings.length > 20 ? ['（仅显示前 20 项）'] : []),
    '处理：/eval promote <id> · /eval ignore <id>',
  ].join('\n')
}

export function formatEvalFlagRecorded(finding: EvalFinding): string {
  return `已记录 finding [${finding.id.slice(0, 8)}]（source=flag）；处理：/eval promote ${finding.id.slice(0, 8)} 或 /eval ignore ${finding.id.slice(0, 8)}。`
}

export function formatEvalFlagNeedsQuote(): string {
  return '请引用一条消息后再发送 /eval flag <原因>（需要被标记的 message_id）。'
}

export function formatEvalPromoted(result: PromoteResult): string {
  if (!result.ok) return `未生成候选：${result.reason}`
  return [
    `已生成候选 ${result.display}（${result.taskId}）· 契约校验通过。`,
    '入任务仍需人工：补全 turns/expect，移到 agent-eval/tasks/dsh/ 并提 PR。',
  ].join('\n')
}

export function formatEvalCandidateUnavailable(): string {
  return '候选生成需要 AGENT_EVAL_ROOT（agent-eval/src/contract.mjs）；当前未部署。'
}

export function formatEvalFindingMissing(ref: string, reason: 'not-found' | 'ambiguous'): string {
  return reason === 'ambiguous'
    ? `finding 前缀 ${ref} 命中多条，请给更长的 id。`
    : `找不到 finding ${ref}；用 /eval findings 查看。`
}

export function formatEvalFindingIgnored(finding: EvalFinding): string {
  return `已忽略 finding [${finding.id.slice(0, 8)}]。`
}

export function formatEvalFindingAlready(finding: EvalFinding): string {
  return `finding [${finding.id.slice(0, 8)}] 已是 ${finding.status}，无需重复处理。`
}

export interface EvalWeeklyInput {
  runs: readonly EvalRun[]
  findings: readonly EvalFinding[]
  from: Date
  to: Date
}

/** P2-4: 周报里的测评段；没有运行时返回 null，避免空段占版面。 */
export function formatEvalWeekly(input: EvalWeeklyInput): string | null {
  const from = input.from.getTime()
  const to = input.to.getTime()
  const runs = input.runs.filter((run) => {
    const at = Date.parse(run.startedAt)
    return Number.isFinite(at) && at >= from && at < to
  })
  if (runs.length === 0 && input.findings.length === 0) return null

  const failed = runs.filter((run) => run.status !== 'ok').length
  const lines = [
    `测评：近 7 天 run ${runs.length} · 通过 ${runs.length - failed} · 未通过/超时 ${failed} · 未处理 findings ${input.findings.length}`,
  ]
  for (const finding of input.findings.slice(0, 5)) {
    const label = finding.taskId === '' ? finding.suite : finding.taskId
    lines.push(`- [${finding.id.slice(0, 8)}] ${label} · ${finding.suite}`)
  }
  if (input.findings.length > 5) lines.push(`（其余 ${input.findings.length - 5} 项见 /eval findings）`)
  return lines.join('\n')
}

export function formatEvalRunRealHint(): string {
  return '真实套件只在 CI/nightly 执行；当前结果见 /eval。'
}

export function formatEvalEngineMissing(): string {
  return '测评引擎未部署（未设置 AGENT_EVAL_ROOT 或缺少 src/cli.mjs）；/eval run l2 仅限开发机。'
}

export function formatEvalRunFailed(error: string): string {
  return `L2 测评执行失败：${error}\n结果未写入通过状态；详见宿主日志。`
}
