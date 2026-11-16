/**
 * Minimal safe inspection checklist (G2 + B4): disk / memory / load /
 * failed units / listening ports / log error rate. Thresholds are the
 * owner-approved defaults from docs/08 §六; keep them here so the report and
 * the tests agree on one source of truth.
 */

export type InspectionItemStatus = 'ok' | 'warn' | 'fail' | 'skipped'

export interface InspectionThresholds {
  diskWarnPct: number
  diskFailPct: number
  memWarnAvailPct: number
  memFailAvailPct: number
  loadWarnPerCore: number
  loadFailPerCore: number
  logErrWarn: number
  logErrFail: number
  logWindowMinutes: number
}

export const DEFAULT_THRESHOLDS: InspectionThresholds = {
  diskWarnPct: 85,
  diskFailPct: 92,
  memWarnAvailPct: 15,
  memFailAvailPct: 7,
  loadWarnPerCore: 1.5,
  loadFailPerCore: 3,
  logErrWarn: 20,
  logErrFail: 100,
  logWindowMinutes: 60,
}

/** Default checklist id recorded in `inspections.checklist_id`. */
export const DEFAULT_CHECKLIST_ID = 'default-min-safe'

export interface HostMetrics {
  /** Root filesystem used percent (0-100); null when `df` is unavailable. */
  diskUsedPct: number | null
  /** MemAvailable as percent of MemTotal (0-100); null when /proc is unavailable. */
  memAvailablePct: number | null
  cpuCores: number
  load1: number | null
  /** Full unit names from `systemctl --failed`; null when systemd is absent. */
  failedUnits: string[] | null
  /** Listening TCP ports; null when `ss` is unavailable or unreadable. */
  listeningPorts: number[] | null
  /** `journalctl -p err` line count in the window; null when unreadable. */
  logErrors: number | null
}

export interface InspectionItem {
  id: string
  label: string
  status: InspectionItemStatus
  value: string
  threshold: string
  detail?: string
}

export interface InspectionReport {
  checklistId: string
  status: InspectionItemStatus
  items: InspectionItem[]
}

function grade(value: number, warn: number, fail: number): InspectionItemStatus {
  if (value >= fail) return 'fail'
  if (value >= warn) return 'warn'
  return 'ok'
}

function worst(items: InspectionItem[]): InspectionItemStatus {
  const live = items.filter((item) => item.status !== 'skipped')
  if (live.length === 0) return 'skipped'
  if (live.some((item) => item.status === 'fail')) return 'fail'
  if (live.some((item) => item.status === 'warn')) return 'warn'
  return 'ok'
}

/**
 * Pure evaluation: no I/O, so every threshold branch is unit-testable.
 * `expectedPorts` is empty by default — ports are then reported, not asserted,
 * because the minimal checklist has no desired-state source yet.
 */
export function evaluate(
  metrics: HostMetrics,
  thresholds: InspectionThresholds = DEFAULT_THRESHOLDS,
  expectedPorts: number[] = [],
): InspectionReport {
  const items: InspectionItem[] = []

  items.push(metrics.diskUsedPct === null
    ? { id: 'disk', label: '根分区使用率', status: 'skipped', value: '不可读', threshold: `≥${thresholds.diskWarnPct}% 警告 / ≥${thresholds.diskFailPct}% 失败` }
    : {
        id: 'disk',
        label: '根分区使用率',
        status: grade(metrics.diskUsedPct, thresholds.diskWarnPct, thresholds.diskFailPct),
        value: `${metrics.diskUsedPct}%`,
        threshold: `≥${thresholds.diskWarnPct}% 警告 / ≥${thresholds.diskFailPct}% 失败`,
      })

  items.push(metrics.memAvailablePct === null
    ? { id: 'memory', label: '可用内存', status: 'skipped', value: '不可读', threshold: `≤${thresholds.memWarnAvailPct}% 警告 / ≤${thresholds.memFailAvailPct}% 失败` }
    : {
        id: 'memory',
        label: '可用内存',
        status: grade(
          -metrics.memAvailablePct,
          -thresholds.memWarnAvailPct,
          -thresholds.memFailAvailPct,
        ),
        value: `${metrics.memAvailablePct}%`,
        threshold: `≤${thresholds.memWarnAvailPct}% 警告 / ≤${thresholds.memFailAvailPct}% 失败`,
      })

  const perCore = metrics.load1 === null || metrics.cpuCores <= 0
    ? null
    : Math.round((metrics.load1 / metrics.cpuCores) * 100) / 100
  items.push(perCore === null
    ? { id: 'load', label: '1 分钟负载/核', status: 'skipped', value: '不可读', threshold: `≥${thresholds.loadWarnPerCore} 警告 / ≥${thresholds.loadFailPerCore} 失败` }
    : {
        id: 'load',
        label: '1 分钟负载/核',
        status: grade(perCore, thresholds.loadWarnPerCore, thresholds.loadFailPerCore),
        value: `${perCore}（${metrics.cpuCores} 核）`,
        threshold: `≥${thresholds.loadWarnPerCore} 警告 / ≥${thresholds.loadFailPerCore} 失败`,
      })

  items.push(metrics.failedUnits === null
    ? { id: 'units', label: '失败 unit', status: 'skipped', value: 'systemd 不可用', threshold: '>0 失败' }
    : {
        id: 'units',
        label: '失败 unit',
        status: metrics.failedUnits.length === 0 ? 'ok' : 'fail',
        value: String(metrics.failedUnits.length),
        threshold: '>0 失败',
        ...(metrics.failedUnits.length > 0
          ? { detail: metrics.failedUnits.slice(0, 10).join(', ') }
          : {}),
      })

  const missing = expectedPorts.filter(
    (port) => !(metrics.listeningPorts ?? []).includes(port),
  )
  items.push(metrics.listeningPorts === null
    ? { id: 'ports', label: '监听端口', status: 'skipped', value: 'ss 不可用', threshold: expectedPorts.length > 0 ? `期望 ${expectedPorts.join('/')}` : '仅报告' }
    : {
        id: 'ports',
        label: '监听端口',
        status: expectedPorts.length === 0 ? 'ok' : missing.length === 0 ? 'ok' : 'fail',
        value: `${metrics.listeningPorts.length} 个监听`,
        threshold: expectedPorts.length > 0 ? `期望 ${expectedPorts.join('/')}` : '仅报告',
        ...(missing.length > 0 ? { detail: `缺失 ${missing.join('/')}` } : {}),
      })

  items.push(metrics.logErrors === null
    ? { id: 'logs', label: `错误日志/${thresholds.logWindowMinutes}min`, status: 'skipped', value: 'journal 不可读', threshold: `≥${thresholds.logErrWarn} 警告 / ≥${thresholds.logErrFail} 失败` }
    : {
        id: 'logs',
        label: `错误日志/${thresholds.logWindowMinutes}min`,
        status: grade(metrics.logErrors, thresholds.logErrWarn, thresholds.logErrFail),
        value: String(metrics.logErrors),
        threshold: `≥${thresholds.logErrWarn} 警告 / ≥${thresholds.logErrFail} 失败`,
      })

  return { checklistId: DEFAULT_CHECKLIST_ID, status: worst(items), items }
}
