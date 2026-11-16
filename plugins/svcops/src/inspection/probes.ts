/**
 * Host probes for the minimal inspection checklist.
 * Every probe is fail-soft: an unavailable or unreadable source yields null and
 * the item is reported as `skipped` instead of faking a healthy value.
 */

import { readFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import type { CommandRunner } from '../systemd.js'
import { DEFAULT_THRESHOLDS, type HostMetrics } from './checklist.js'

export interface HostProbeOptions {
  runner: CommandRunner
  /** Ports that must be listening; empty means "report only". */
  expectedPorts?: number[]
  logWindowMinutes?: number
  timeoutMs?: number
}

async function run(runner: CommandRunner, argv: string[], timeoutMs: number): Promise<string | null> {
  try {
    const result = await runner.run(argv, { timeoutMs })
    return result.code === 0 ? result.stdout : null
  } catch {
    return null
  }
}

export async function probeDisk(runner: CommandRunner, timeoutMs = 5_000): Promise<number | null> {
  const out = await run(runner, ['df', '-P', '-k', '/'], timeoutMs)
  if (out === null) return null
  const lines = out.trim().split('\n').filter((line) => line.trim().length > 0)
  const fields = lines.at(-1)?.trim().split(/\s+/)
  const pct = fields?.[4]?.replace('%', '')
  const value = Number(pct)
  return Number.isFinite(value) ? value : null
}

export async function probeMemory(): Promise<number | null> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8')
    const total = Number(/^MemTotal:\s+(\d+) kB/m.exec(text)?.[1])
    const available = Number(/^MemAvailable:\s+(\d+) kB/m.exec(text)?.[1])
    if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) return null
    return Math.round((available / total) * 1000) / 10
  } catch {
    return null
  }
}

export async function probeLoad1(): Promise<number | null> {
  try {
    const text = await readFile('/proc/loadavg', 'utf8')
    const value = Number(text.trim().split(/\s+/)[0])
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export async function probeFailedUnits(
  runner: CommandRunner,
  timeoutMs = 5_000,
): Promise<string[] | null> {
  const out = await run(
    runner,
    ['systemctl', '--failed', '--no-legend', '--plain', '--no-pager'],
    timeoutMs,
  )
  if (out === null) return null
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => unit.length > 0 && unit.includes('.'))
}

export async function probeListeningPorts(
  runner: CommandRunner,
  timeoutMs = 5_000,
): Promise<number[] | null> {
  const out = await run(runner, ['ss', '-ltnH'], timeoutMs)
  if (out === null) return null
  const ports = new Set<number>()
  for (const line of out.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const local = fields[3]
    if (!local) continue
    const port = Number(local.slice(local.lastIndexOf(':') + 1))
    if (Number.isInteger(port) && port > 0) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

export async function probeLogErrors(
  runner: CommandRunner,
  minutes: number,
  timeoutMs = 8_000,
): Promise<number | null> {
  const out = await run(
    runner,
    ['journalctl', '-p', 'err', '--since', `-${minutes} min`, '--no-pager', '-q'],
    timeoutMs,
  )
  if (out === null) return null
  return out.split('\n').filter((line) => line.trim().length > 0).length
}

export async function collectHostMetrics(options: HostProbeOptions): Promise<HostMetrics> {
  const { runner } = options
  const timeoutMs = options.timeoutMs ?? 5_000
  const window = options.logWindowMinutes ?? DEFAULT_THRESHOLDS.logWindowMinutes
  const [diskUsedPct, memAvailablePct, load1, failedUnits, listeningPorts, logErrors] =
    await Promise.all([
      probeDisk(runner, timeoutMs),
      probeMemory(),
      probeLoad1(),
      probeFailedUnits(runner, timeoutMs),
      probeListeningPorts(runner, timeoutMs),
      probeLogErrors(runner, window, timeoutMs),
    ])

  return {
    diskUsedPct,
    memAvailablePct,
    cpuCores: Math.max(cpus().length, 1),
    load1,
    failedUnits,
    listeningPorts,
    logErrors,
  }
}
