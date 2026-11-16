/**
 * Read-only resource probe for the front desk's instant answers (slice E).
 *
 * These three are the cheap ones: `df` on `/`, `/proc/meminfo`, `/proc/loadavg`.
 * No journalctl, no unit enumeration — that is the inspection checklist's job.
 * Every value is fail-soft (null), so a caller must not print a guess for a
 * probe that could not run.
 */

import { cpus } from 'node:os'
import type { CommandRunner } from '../systemd.js'
import { probeDisk, probeLoad1, probeMemory } from './probes.js'

export interface ResourceSnapshot {
  /** Root filesystem used %, or null when `df` could not run. */
  diskUsedPct: number | null
  /** Available memory %, or null when `/proc/meminfo` is unreadable. */
  memAvailablePct: number | null
  /** 1-minute load average, or null when `/proc/loadavg` is unreadable. */
  load1: number | null
  cpuCores: number
}

export interface ResourceProbeOptions {
  runner: CommandRunner
  timeoutMs?: number
}

export function createResourceProbe(options: ResourceProbeOptions): () => Promise<ResourceSnapshot> {
  const timeoutMs = options.timeoutMs ?? 3_000
  return async () => {
    const [diskUsedPct, memAvailablePct, load1] = await Promise.all([
      probeDisk(options.runner, timeoutMs),
      probeMemory(),
      probeLoad1(),
    ])
    return {
      diskUsedPct,
      memAvailablePct,
      load1,
      cpuCores: Math.max(cpus().length, 1),
    }
  }
}
