import {
  SvcOpsError,
  spawnRunner,
} from './systemd.js'
import type {
  CommandResult,
  CommandRunner,
  ServiceActionResult,
  ServiceInfo,
  ServiceLogs,
  ServiceStatus,
  SvcAction,
  SvcOpsPort,
} from './systemd.js'

export interface DockerAdapterOptions {
  runner?: CommandRunner
  containerPrefix?: string
  timeoutMs?: number
  /** Actions (start/stop/restart) may outlive the query timeout (stop grace period). */
  actionTimeoutMs?: number
}

/** Managed containers only: same prefix rule as systemd units, without the suffix. */
export const DEFAULT_CONTAINER_PREFIX = 'dsh-wfxm-managed-'

/** Consent label: a prefixed container is still rejected unless it carries this label. */
export const MANAGED_LABEL = 'dsh-wfxm.managed'

const MAX_LOG_LINES = 500

const UNSTARTED_TIMESTAMP = '0001-01-01T00:00:00Z'

function containerPattern(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}[a-z0-9][a-z0-9-]{0,63}$`)
}

/** Whether a container name stays inside the managed prefix (same rule as the adapter). */
export function isManagedContainer(name: string, prefix: string = DEFAULT_CONTAINER_PREFIX): boolean {
  return typeof name === 'string' && containerPattern(prefix).test(name)
}

function classifyFailure(stderr: string): SvcOpsError['code'] {
  const text = stderr.toLowerCase()
  if (text.includes('no such container') || text.includes('no such object')) {
    return 'not-found'
  }
  if (text.includes('permission denied') || text.includes('access denied')) {
    return 'not-allowed'
  }
  if (
    text.includes('cannot connect to the docker daemon')
    || text.includes('is the docker daemon running')
    || text.includes('docker daemon is not running')
  ) {
    return 'unavailable'
  }
  return 'upstream'
}

interface DockerState {
  Status?: string
  Running?: boolean
  Pid?: number
  StartedAt?: string
  RestartCount?: number
}

interface DockerInspect {
  Name?: string
  State?: DockerState
  Config?: {
    Image?: string
    Labels?: Record<string, string>
  }
}

interface DockerPsRow {
  Names?: string
  State?: string
  Status?: string
  Image?: string
  Labels?: string
}

function parseInspect(target: string, stdout: string): DockerInspect {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new SvcOpsError('upstream', `cannot parse docker inspect output for ${target}: ${String(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'object' || parsed[0] === null) {
    throw new SvcOpsError('not-found', `container ${target} not found`)
  }
  return parsed[0] as DockerInspect
}

function hasManagedLabel(labels: Record<string, string> | undefined): boolean {
  return labels?.[MANAGED_LABEL] === 'true'
}

function stripSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name
}

export function createDockerAdapter(options: DockerAdapterOptions = {}): SvcOpsPort {
  const runner = options.runner ?? spawnRunner
  const prefix = options.containerPrefix ?? DEFAULT_CONTAINER_PREFIX
  const timeoutMs = options.timeoutMs ?? 10_000
  const actionTimeoutMs = options.actionTimeoutMs ?? 60_000
  const pattern = containerPattern(prefix)

  async function docker(args: string[], allowFailure = false, timeout = timeoutMs): Promise<CommandResult> {
    const result = await runner.run(['docker', ...args], { timeoutMs: timeout })
    if (result.code !== 0 && !allowFailure) {
      throw new SvcOpsError(classifyFailure(result.stderr), result.stderr.trim() || `docker exited ${result.code}`)
    }
    return result
  }

  function validate(name: string): string {
    if (typeof name !== 'string' || !pattern.test(name)) {
      throw new SvcOpsError(
        'not-allowed',
        `container ${JSON.stringify(name)} is outside the managed prefix ${prefix}`,
      )
    }
    return name
  }

  /** Prefix and consent label are both required before reads or actions. */
  async function inspectManaged(name: string): Promise<{ target: string; info: DockerInspect }> {
    const target = validate(name)
    const result = await docker(['inspect', target], true)
    if (result.code !== 0) {
      throw new SvcOpsError(classifyFailure(result.stderr), result.stderr.trim() || `docker exited ${result.code}`)
    }
    const info = parseInspect(target, result.stdout)
    if (!hasManagedLabel(info.Config?.Labels)) {
      throw new SvcOpsError(
        'not-allowed',
        `container ${target} is missing the ${MANAGED_LABEL}=true label`,
      )
    }
    return { target, info }
  }

  return {
    runtime: 'docker',
    async detect() {
      const result = await runner.run(['docker', 'info', '--format', '{{.ServerVersion}}'], { timeoutMs })
      return result.code === 0
    },
    async list() {
      const result = await docker(
        ['ps', '--all', '--filter', `label=${MANAGED_LABEL}=true`, '--format', '{{json .}}'],
        true,
      )
      if (result.code !== 0) {
        throw new SvcOpsError(classifyFailure(result.stderr), result.stderr.trim() || `docker exited ${result.code}`)
      }
      const services: ServiceInfo[] = []
      for (const line of result.stdout.split('\n')) {
        if (line.trim().length === 0) continue
        let row: DockerPsRow
        try {
          row = JSON.parse(line) as DockerPsRow
        } catch {
          continue
        }
        const name = row.Names ?? ''
        const labels = row.Labels ?? ''
        if (!pattern.test(name) || !labels.split(',').includes(`${MANAGED_LABEL}=true`)) continue
        services.push({
          unit: name,
          loadState: 'present',
          activeState: row.State ?? 'unknown',
          subState: row.Status ?? 'unknown',
          description: row.Image ?? '',
        })
      }
      return services
    },
    async status(name) {
      const { target, info } = await inspectManaged(name)
      const state = info.State ?? {}
      const startedAt = state.StartedAt && state.StartedAt !== UNSTARTED_TIMESTAMP ? state.StartedAt : null
      return {
        unit: stripSlash(info.Name ?? target),
        loadState: 'present',
        activeState: state.Status ?? 'unknown',
        subState: state.Status ?? 'unknown',
        description: info.Config?.Image ?? '',
        unitFileState: 'n/a',
        mainPid: typeof state.Pid === 'number' && state.Pid > 0 ? state.Pid : null,
        activeEnterTimestamp: startedAt,
        restarts: typeof state.RestartCount === 'number' ? state.RestartCount : null,
      }
    },
    async logs(name, lines = 100) {
      const { target } = await inspectManaged(name)
      const count = Number.isInteger(lines) ? Math.min(Math.max(lines, 1), MAX_LOG_LINES) : 100
      const result = await docker(['logs', '--tail', String(count), target], true)
      if (result.code !== 0) {
        throw new SvcOpsError(classifyFailure(result.stderr), result.stderr.trim() || `docker exited ${result.code}`)
      }
      const merged = `${result.stdout}\n${result.stderr}`
        .split('\n')
        .filter((line) => line.length > 0)
      return { unit: target, lines: merged.slice(-count) }
    },
    async start(name) {
      const { target } = await inspectManaged(name)
      await docker(['start', target], false, actionTimeoutMs)
      return { unit: target, action: 'start', changed: true }
    },
    async stop(name) {
      const { target } = await inspectManaged(name)
      await docker(['stop', target], false, actionTimeoutMs)
      return { unit: target, action: 'stop', changed: true }
    },
    async restart(name) {
      const { target } = await inspectManaged(name)
      await docker(['restart', target], false, actionTimeoutMs)
      return { unit: target, action: 'restart', changed: true }
    },
  } satisfies SvcOpsPort
}
