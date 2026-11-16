/**
 * Instant answers for read-only questions (slice E).
 *
 * "看看磁盘占用" does not need a task and does not need a model: the host can
 * read `df` / `/proc/meminfo` / `/proc/loadavg` in milliseconds. This module is
 * the deterministic first hand (docs/17 principle 2: rules before the model) so
 * the common read-only question never spawns a dsh session, and never lands a
 * "task" that the owner then waits minutes for.
 *
 * Deliberately conservative: a message only qualifies when it is short, names a
 * resource, asks about it, and contains no action verb. Anything else falls
 * through to the model, which is better at ambiguous language than a keyword
 * list. A probe that cannot read anything returns null — never a guessed number.
 */

export interface ResourceSnapshot {
  diskUsedPct: number | null
  memAvailablePct: number | null
  load1: number | null
  cpuCores: number
}

export type QuickRequestKind = 'resources' | 'tasks' | 'units' | 'ports' | 'logs'

/** A parsed read-only question plus the target the probe needs (Slice S). */
export type QuickRequest =
  | { kind: 'resources' }
  | { kind: 'tasks' }
  | { kind: 'units'; unit: string }
  | { kind: 'ports'; port: number }
  | { kind: 'logs'; minutes: number }

/**
 * Read-only inspection seams (Slice S). All optional: an absent probe falls
 * through to the model instead of guessing. The host wires these to ⑦'s
 * existing probes (`systemctl status` / `ss` / `journalctl -p err`).
 */
export interface QuickChecks {
  unitStatus?: ((unit: string) => Promise<string | null>) | null
  listeningPorts?: (() => Promise<number[] | null>) | null
  logErrors?: ((minutes: number) => Promise<number | null>) | null
}

export interface QuickAnswer {
  kind: QuickRequestKind
  text: string
}

/** Statuses that count as "进行中" when answering a progress question. */
const LIVE_STATUSES: readonly string[] = ['queued', 'running', 'waiting_input', 'waiting_approval']

const MAX_LENGTH = 40

/** Anything that implies doing something must not be answered with a probe. */
const ACTION_WORDS = /(重启|启动|停止|暂停|清理|删|删除|安装|升级|部署|修改|改一下|改成|配置|备份|恢复|迁移|创建|新建|执行|跑一下|发一下|定时)/

const RESOURCE_NOUNS = /(磁盘|硬盘|内存|cpu|负载|系统资源|资源占用|使用率)/
const TASK_NOUNS = /(任务|进度|做到哪)/
const LOG_NOUNS = /(错误日志|报错日志|日志.*(错误|报错)|(错误|报错|err).*日志)/
const PORT_NOUNS = /(端口|port)/i
/** Windows we cannot answer faithfully with a short probe; let the model handle them. */
const LOG_WINDOW_NOISE = /(今天|昨天|本周|上周|近一周|7\s*天|七天)/
const GENERIC_UNIT_NAMES = /^(系统|所有|这些|这个|那个|托管|全部)$/

const QUERY_WORDS = /(看看|查看|看下|多少|占用|用了|状态|怎么样|如何|够不够|还剩|剩余|到哪|进度|在跑|运行中|通不通|通吗|在听|监听|开着|有没有|多吗|几条)/

/** One short clause only: a question with extra requests is the model's job. */
const MULTI_CLAUSE = /[，,。；;]|然后|顺便|再帮我/

interface TaskLookup {
  listTaskThreads(input: { threadId: string; liveOnly?: boolean }): { taskId: string }[]
  getTask(taskId: string): { taskRef: string | null; status: string; intent: string } | null
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

function parseMinutes(text: string): number {
  const match = /(\d+)\s*(?:分钟|min)/i.exec(text)
  if (match === null) return 15
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 1 && value <= 1440 ? value : 15
}

function parsePort(text: string): number | null {
  const match = /(\d{1,5})/.exec(text)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/**
 * Only units we can name deterministically: a full `*.service`, our managed
 * prefix, or `<name> 服务` mapped onto the managed convention. A bare
 * "服务状态" has no target and falls through to the model.
 */
function parseUnit(text: string): string | null {
  const full = /([A-Za-z0-9_.@:-]+\.service)\b/.exec(text)
  if (full !== null) return full[1]
  const managed = /(dsh-wfxm-managed-[A-Za-z0-9_.@-]+)/.exec(text)
  if (managed !== null) {
    return managed[1].endsWith('.service') ? managed[1] : `${managed[1]}.service`
  }
  const short = /([A-Za-z][A-Za-z0-9_-]{1,40})\s*(?:服务|service|unit)/i.exec(text)
  if (short === null) return null
  const name = short[1]
  if (GENERIC_UNIT_NAMES.test(name)) return null
  return `dsh-wfxm-managed-${name.toLowerCase()}.service`
}

export function parseQuickRequest(text: string): QuickRequest | null {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > MAX_LENGTH) return null
  if (ACTION_WORDS.test(trimmed)) return null
  if (MULTI_CLAUSE.test(trimmed)) return null
  if (!QUERY_WORDS.test(trimmed)) return null

  if (LOG_NOUNS.test(trimmed) && !LOG_WINDOW_NOISE.test(trimmed)) {
    return { kind: 'logs', minutes: parseMinutes(trimmed) }
  }
  if (PORT_NOUNS.test(trimmed)) {
    const port = parsePort(trimmed)
    if (port !== null) return { kind: 'ports', port }
  }
  const unit = parseUnit(trimmed)
  if (unit !== null) return { kind: 'units', unit }
  if (TASK_NOUNS.test(trimmed)) return { kind: 'tasks' }
  if (RESOURCE_NOUNS.test(trimmed)) return { kind: 'resources' }
  return null
}

export function matchQuickRequest(text: string): QuickRequestKind | null {
  return parseQuickRequest(text)?.kind ?? null
}

export function formatResources(snapshot: ResourceSnapshot): string | null {
  const parts: string[] = []
  if (snapshot.diskUsedPct !== null) parts.push(`磁盘已用 ${snapshot.diskUsedPct}%`)
  if (snapshot.memAvailablePct !== null) parts.push(`内存可用 ${snapshot.memAvailablePct}%`)
  if (snapshot.load1 !== null) {
    parts.push(`负载 ${snapshot.load1.toFixed(2)}（${snapshot.cpuCores} 核）`)
  }
  if (parts.length === 0) return null
  return parts.join(' · ')
}

export function formatTasks(tasks: TaskLookup, threadId: string): string {
  const live = tasks.listTaskThreads({ threadId, liveOnly: true })
    .map((binding) => tasks.getTask(binding.taskId))
    .filter((task): task is { taskRef: string | null; status: string; intent: string } => (
      task !== null && LIVE_STATUSES.includes(task.status)
    ))
  if (live.length === 0) return '当前没有进行中的任务。'
  const lines = live.map((task) => `${task.taskRef ?? '-'} · ${task.status} · ${clip(task.intent, 40)}`)
  return [`进行中 ${live.length} 个：`, ...lines].join('\n')
}

const UNIT_STATE_LABEL: Record<string, string> = {
  active: '运行中',
  activating: '启动中',
  deactivating: '停止中',
  inactive: '未运行',
  failed: '失败',
}

/** `null` when the probe could not confirm the state — callers fall through. */
export function formatUnitStatus(unit: string, activeState: string | null): string | null {
  if (activeState === null || activeState === '' || activeState === 'unknown') return null
  const label = UNIT_STATE_LABEL[activeState] ?? activeState
  return `服务 ${unit}：${label}（${activeState}）。`
}

/** `null` when `ss` could not be read — never claim a port is closed on a guess. */
export function formatPortStatus(port: number, listening: number[] | null): string | null {
  if (listening === null) return null
  return listening.includes(port)
    ? `端口 ${port}：正在监听。`
    : `端口 ${port}：没有监听。`
}

export function formatLogErrors(minutes: number, count: number | null): string | null {
  if (count === null || !Number.isFinite(count) || count < 0) return null
  return count === 0
    ? `最近 ${minutes} 分钟没有错误日志（journalctl -p err）。`
    : `最近 ${minutes} 分钟错误日志 ${count} 条（journalctl -p err）。`
}

export interface QuickAnswerOptions {
  tasks: TaskLookup
  /**
   * Injected resource probe (svcops `createResourceProbe`). Absent means the
   * resource question is not answered locally — it falls through to the model.
   */
  probe?: (() => Promise<ResourceSnapshot>) | null
  /** Slice S: unit / port / log seams from ⑦. Absent methods fall through. */
  checks?: QuickChecks | null
}

export function createQuickAnswer(options: QuickAnswerOptions): (
  text: string,
  threadId: string,
) => Promise<QuickAnswer | null> {
  const { tasks, probe } = options
  const checks = options.checks ?? null

  return async (text, threadId) => {
    const request = parseQuickRequest(text)
    if (request === null) return null

    if (request.kind === 'tasks') {
      return { kind: request.kind, text: formatTasks(tasks, threadId) }
    }

    if (request.kind === 'resources') {
      if (probe === undefined || probe === null) return null
      let snapshot: ResourceSnapshot
      try {
        snapshot = await probe()
      } catch {
        return null // a broken probe falls through to the model, never to a guess.
      }
      const formatted = formatResources(snapshot)
      if (formatted === null) return null
      return { kind: request.kind, text: formatted }
    }

    if (request.kind === 'units') {
      const read = checks?.unitStatus
      if (read === undefined || read === null) return null
      try {
        const formatted = formatUnitStatus(request.unit, await read(request.unit))
        return formatted === null ? null : { kind: request.kind, text: formatted }
      } catch {
        return null
      }
    }

    if (request.kind === 'ports') {
      const read = checks?.listeningPorts
      if (read === undefined || read === null) return null
      try {
        const formatted = formatPortStatus(request.port, await read())
        return formatted === null ? null : { kind: request.kind, text: formatted }
      } catch {
        return null
      }
    }

    const read = checks?.logErrors
    if (read === undefined || read === null) return null
    try {
      const formatted = formatLogErrors(request.minutes, await read(request.minutes))
      return formatted === null ? null : { kind: request.kind, text: formatted }
    } catch {
      return null
    }
  }
}
