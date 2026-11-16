import { spawn } from 'node:child_process'

export type SvcAction = 'start' | 'stop' | 'restart'
export type SvcRisk = 'R0' | 'R3'

export type SvcOpsErrorCode =
  | 'invalid'
  | 'not-allowed'
  | 'not-found'
  | 'unavailable'
  | 'upstream'

export class SvcOpsError extends Error {
  constructor(
    readonly code: SvcOpsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SvcOpsError'
  }
}

export interface ServiceInfo {
  unit: string
  loadState: string
  activeState: string
  subState: string
  description: string
}

export interface ServiceStatus extends ServiceInfo {
  unitFileState: string
  mainPid: number | null
  activeEnterTimestamp: string | null
  restarts: number | null
}

export interface ServiceLogs {
  unit: string
  lines: string[]
}

export interface ServiceActionResult {
  unit: string
  action: SvcAction
  changed: boolean
}

export interface SvcOpsPort {
  readonly runtime: 'systemd' | 'docker'
  detect(): Promise<boolean>
  list(): Promise<ServiceInfo[]>
  status(unit: string): Promise<ServiceStatus>
  logs(unit: string, lines?: number): Promise<ServiceLogs>
  start(unit: string): Promise<ServiceActionResult>
  stop(unit: string): Promise<ServiceActionResult>
  restart(unit: string): Promise<ServiceActionResult>
}

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(argv: string[], options?: { timeoutMs?: number }): Promise<CommandResult>
}

export interface SystemdAdapterOptions {
  runner?: CommandRunner
  unitPrefix?: string
  timeoutMs?: number
  /** Actions (start/stop/restart) may legitimately outlive the 10s query timeout. */
  actionTimeoutMs?: number
  /**
   * Command prefix for write actions. Production passes the sudo wrapper
   * (`sudo -n /usr/local/sbin/dsh-wfxm-unit-control`) because polkit 0.105
   * cannot express a per-unit allow rule; the wrapper re-checks the prefix.
   */
  controlCommand?: string[]
}

/** Managed units only: never let a caller address `ssh.service` or an instance. */
export const DEFAULT_UNIT_PREFIX = 'dsh-wfxm-managed-'

const MAX_LOG_LINES = 500

export const spawnRunner: CommandRunner = {
  run(argv, options = {}) {
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeoutMs ?? 10_000,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', (error) => {
        resolve({ code: null, stdout, stderr: error.message })
      })
      child.on('close', (code) => {
        resolve({ code, stdout, stderr })
      })
    })
  },
}

function unitPattern(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}[a-z0-9][a-z0-9-]{0,60}\\.service$`)
}

/** Whether a unit name stays inside the managed prefix (same rule as the adapter). */
export function isManagedUnit(unit: string, prefix: string = DEFAULT_UNIT_PREFIX): boolean {
  return typeof unit === 'string' && unitPattern(prefix).test(unit)
}

function classifyFailure(stderr: string): SvcOpsErrorCode {
  const text = stderr.toLowerCase()
  if (text.includes('not found') || text.includes('could not be found') || text.includes('no such')) {
    return 'not-found'
  }
  if (text.includes('access denied') || text.includes('permission') || text.includes('authentication')) {
    return 'not-allowed'
  }
  if (text.includes('not been booted') || text.includes('not running') || text.includes('offline')) {
    return 'unavailable'
  }
  return 'upstream'
}

function parseUnitLine(line: string): ServiceInfo | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 4) return null
  const [unit, loadState, activeState, subState] = parts
  if (!unit.endsWith('.service')) return null
  return {
    unit,
    loadState,
    activeState,
    subState,
    description: parts.slice(4).join(' '),
  }
}

function parseProperties(stdout: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    result[line.slice(0, index)] = line.slice(index + 1).trim()
  }
  return result
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function createSystemdAdapter(options: SystemdAdapterOptions = {}): SvcOpsPort {
  const runner = options.runner ?? spawnRunner
  const prefix = options.unitPrefix ?? DEFAULT_UNIT_PREFIX
  const timeoutMs = options.timeoutMs ?? 10_000
  const actionTimeoutMs = options.actionTimeoutMs ?? 60_000
  const pattern = unitPattern(prefix)
  const control = options.controlCommand ?? ['systemctl']

  async function systemctl(args: string[], allowFailure = false, timeout = timeoutMs): Promise<CommandResult> {
    const result = await runner.run(['systemctl', ...args], { timeoutMs: timeout })
    if (result.code !== 0 && !allowFailure) {
      throw new SvcOpsError(classifyFailure(result.stderr), result.stderr.trim() || `systemctl exited ${result.code}`)
    }
    return result
  }

  /** Write actions go through the configured control prefix (sudo wrapper in production). */
  async function controlUnit(action: SvcAction, unit: string): Promise<void> {
    const result = await runner.run([...control, action, unit], { timeoutMs: actionTimeoutMs })
    if (result.code !== 0) {
      throw new SvcOpsError(
        classifyFailure(result.stderr),
        result.stderr.trim() || `${control.join(' ')} ${action} exited ${result.code}`,
      )
    }
  }

  function validate(unit: string): string {
    if (typeof unit !== 'string' || !pattern.test(unit)) {
      throw new SvcOpsError(
        'not-allowed',
        `unit ${JSON.stringify(unit)} is outside the managed prefix ${prefix}`,
      )
    }
    return unit
  }

  async function requireUnit(unit: string): Promise<void> {
    const status = await systemctl(['is-active', unit], true)
    if (status.code !== 0 && /not found|could not be found|no such/i.test(status.stderr)) {
      throw new SvcOpsError('not-found', status.stderr.trim())
    }
  }

  return {
    runtime: 'systemd',
    async detect() {
      const result = await runner.run(['systemctl', '--version'], { timeoutMs })
      return result.code === 0
    },
    async list() {
      const result = await systemctl(['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain'], true)
      if (result.code !== 0 && /not been booted|not running/i.test(result.stderr)) {
        throw new SvcOpsError('unavailable', result.stderr.trim())
      }
      if (result.code !== 0) {
        throw new SvcOpsError(classifyFailure(result.stderr), result.stderr.trim())
      }
      return result.stdout
        .split('\n')
        .map(parseUnitLine)
        .filter((info): info is ServiceInfo => info !== null && pattern.test(info.unit))
    },
    async status(unit) {
      const target = validate(unit)
      await requireUnit(target)
      const result = await systemctl([
        'show',
        target,
        '--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,Description,UnitFileState,MainPID,ActiveEnterTimestamp,NRestarts',
      ])
      const props = parseProperties(result.stdout)
      if (props.LoadState === 'not-found') {
        throw new SvcOpsError('not-found', `unit ${target} not found`)
      }
      return {
        unit: props.Id ?? target,
        loadState: props.LoadState ?? 'unknown',
        activeState: props.ActiveState ?? 'unknown',
        subState: props.SubState ?? 'unknown',
        description: props.Description ?? '',
        unitFileState: props.UnitFileState ?? 'unknown',
        mainPid: toNumber(props.MainPID),
        activeEnterTimestamp: props.ActiveEnterTimestamp || null,
        restarts: toNumber(props.NRestarts),
      }
    },
    async logs(unit, lines = 100) {
      const target = validate(unit)
      const count = Number.isInteger(lines) ? Math.min(Math.max(lines, 1), MAX_LOG_LINES) : 100
      const result = await runner.run(
        ['journalctl', '-u', target, '-n', String(count), '--no-pager', '-o', 'short-iso'],
        { timeoutMs },
      )
      if (result.code !== 0) {
        throw new SvcOpsError(classifyFailure(result.stderr), result.stderr.trim())
      }
      return {
        unit: target,
        lines: result.stdout.split('\n').filter((line) => line.length > 0),
      }
    },
    async start(unit) {
      const target = validate(unit)
      await controlUnit('start', target)
      return { unit: target, action: 'start', changed: true }
    },
    async stop(unit) {
      const target = validate(unit)
      await controlUnit('stop', target)
      return { unit: target, action: 'stop', changed: true }
    },
    async restart(unit) {
      const target = validate(unit)
      await controlUnit('restart', target)
      return { unit: target, action: 'restart', changed: true }
    },
  }
}
