/**
 * G8：路由/专家反馈。
 *
 * `route_decisions` 只记录、任务上有 `expert`，之前没有任何汇总。这里按时间窗口
 * 把两者对起来：周报展示路由质量，失败率越线时进日报建议（与 P7-6 同一套阈值思路）。
 * 聚合只读、纯函数，网关与任务模块都不需要互相导入。
 */

export interface RoutingDecisionLike {
  action: string
  targetTaskId: string | null
  projectId: string | null
  projectMatchedBy: string | null
  createdAt: string
}

export interface RoutingTaskLike {
  id: string
  expert: string | null
  status: string
}

/** 一个专家（`null` = 未指派）在窗口内被路由到的任务与完成结果。 */
export interface ExpertOutcome {
  expert: string | null
  routed: number
  finished: number
  succeeded: number
  failed: number
}

export interface RoutingStats {
  decisions: number
  actions: { action: string; count: number }[]
  projects: { matchedBy: string; count: number }[]
  experts: ExpertOutcome[]
}

export interface ExpertThresholds {
  /** 失败率阈值（0-1）；0 关闭该条建议。 */
  failRate: number
  /** 少于该完成样本数时不下结论。 */
  minFinished: number
}

export const DEFAULT_EXPERT_THRESHOLDS: ExpertThresholds = { failRate: 0.3, minFinished: 5 }

const ACTION_LABELS: Readonly<Record<string, string>> = {
  answer: '回答',
  ack: '回执',
  ask: '反问',
  attach: '挂任务',
  accept: '接任务',
  ignore: '忽略',
  stop: '停止',
}

const MATCH_LABELS: Readonly<Record<string, string>> = {
  explicit: '显式',
  anchor: '锚点',
  sticky: '粘性',
  single: '单项目',
  asked: '反问后',
}

function percent(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 100)
}

function byCount(left: { count: number }, right: { count: number }): number {
  return right.count - left.count
}

/**
 * 窗口内没有路由决策时返回 null：周报省略整段，与其它可选段一致。
 * 任务结果按任务当前状态统计（路由发生在窗口内、完成可以晚于窗口）。
 */
export function aggregateRouting(input: {
  decisions: readonly RoutingDecisionLike[]
  tasks: readonly RoutingTaskLike[]
  from: Date
  to: Date
}): RoutingStats | null {
  const fromMs = input.from.getTime()
  const toMs = input.to.getTime()
  const inWindow = input.decisions.filter((decision) => {
    const at = Date.parse(decision.createdAt)
    return Number.isFinite(at) && at >= fromMs && at < toMs
  })
  if (inWindow.length === 0) return null

  const actions = new Map<string, number>()
  const projects = new Map<string, number>()
  const taskIds = new Set<string>()
  for (const decision of inWindow) {
    actions.set(decision.action, (actions.get(decision.action) ?? 0) + 1)
    if (decision.projectId !== null) {
      const matchedBy = decision.projectMatchedBy ?? 'unknown'
      projects.set(matchedBy, (projects.get(matchedBy) ?? 0) + 1)
    }
    if (decision.targetTaskId !== null) taskIds.add(decision.targetTaskId)
  }

  const tasksById = new Map(input.tasks.map((task) => [task.id, task]))
  const experts = new Map<string | null, ExpertOutcome>()
  for (const taskId of taskIds) {
    const task = tasksById.get(taskId)
    if (task === undefined) continue
    const entry = experts.get(task.expert)
      ?? { expert: task.expert, routed: 0, finished: 0, succeeded: 0, failed: 0 }
    entry.routed += 1
    if (task.status === 'succeeded' || task.status === 'failed') {
      entry.finished += 1
      if (task.status === 'succeeded') entry.succeeded += 1
      else entry.failed += 1
    }
    experts.set(task.expert, entry)
  }

  return {
    decisions: inWindow.length,
    actions: [...actions.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort(byCount),
    projects: [...projects.entries()]
      .map(([matchedBy, count]) => ({ matchedBy, count }))
      .sort(byCount),
    experts: [...experts.values()].sort(
      (left, right) => right.routed - left.routed || (left.expert ?? '').localeCompare(right.expert ?? ''),
    ),
  }
}

/** 周报段；没有专家完成样本时只报路由与项目命中。 */
export function formatRoutingWeekly(stats: RoutingStats): string {
  const lines = [
    `路由（近 7 天）：决策 ${stats.decisions}`
      + (stats.actions.length === 0
        ? ''
        : ` · ${stats.actions.map((item) => `${ACTION_LABELS[item.action] ?? item.action} ${item.count}`).join(' · ')}`),
  ]
  if (stats.projects.length > 0) {
    lines.push(
      `项目命中：${stats.projects.map((item) => `${MATCH_LABELS[item.matchedBy] ?? item.matchedBy} ${item.count}`).join(' / ')}`,
    )
  }
  if (stats.experts.length > 0) {
    lines.push(
      `专家：${stats.experts.map((item) => {
        const name = item.expert ?? '未指派'
        return item.finished === 0
          ? `${name} ${item.routed}（暂无完成样本）`
          : `${name} ${item.routed} · 成功 ${item.succeeded}/${item.finished}（${percent(item.succeeded, item.finished)}%）`
      }).join(' · ')}`,
    )
  }
  return lines.join('\n')
}

export interface ExpertBreach {
  expert: string | null
  failed: number
  finished: number
  reason: string
}

/** 失败率越线且样本足够时才报；日报建议与后续告警共用这一处判定。 */
export function evaluateExpertHealth(
  experts: readonly ExpertOutcome[],
  thresholds: ExpertThresholds = DEFAULT_EXPERT_THRESHOLDS,
): ExpertBreach[] {
  if (thresholds.failRate <= 0) return []
  const limit = Math.round(thresholds.failRate * 100)
  return experts
    .filter((item) => item.finished >= thresholds.minFinished
      && item.failed / item.finished >= thresholds.failRate)
    .map((item) => ({
      expert: item.expert,
      failed: item.failed,
      finished: item.finished,
      reason: `${item.expert ?? '未指派'} 失败 ${item.failed}/${item.finished}`
        + `（${percent(item.failed, item.finished)}%）≥ 阈值 ${limit}%`,
    }))
}
