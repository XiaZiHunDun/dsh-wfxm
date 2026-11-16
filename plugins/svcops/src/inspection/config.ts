/**
 * Inspection configuration from the environment (docs/08 决策 #6: minimal set
 * by default, owner may tune later).
 *
 * Invalid input never changes safety silently: every rejected value is skipped,
 * kept at its default, and reported as a warning for the caller to log.
 */

import { DEFAULT_THRESHOLDS, type InspectionThresholds } from './checklist.js'

export interface InspectionConfig {
  thresholds: InspectionThresholds
  expectedPorts: number[]
}

export interface InspectionConfigResult extends InspectionConfig {
  warnings: string[]
}

const BOUNDS: Record<keyof InspectionThresholds, { min: number; max: number }> = {
  diskWarnPct: { min: 0, max: 100 },
  diskFailPct: { min: 0, max: 100 },
  memWarnAvailPct: { min: 0, max: 100 },
  memFailAvailPct: { min: 0, max: 100 },
  loadWarnPerCore: { min: 0, max: 1000 },
  loadFailPerCore: { min: 0, max: 1000 },
  logErrWarn: { min: 0, max: 1_000_000_000 },
  logErrFail: { min: 0, max: 1_000_000_000 },
  logWindowMinutes: { min: 1, max: 1440 },
}

export function parseExpectedPorts(raw: string | undefined, warnings: string[]): number[] {
  if (raw === undefined || raw.trim() === '') return []
  const ports = new Set<number>()
  for (const token of raw.split(/[\s,]+/)) {
    if (token === '') continue
    const port = Number(token)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      warnings.push(`expected port ${JSON.stringify(token)} is not an integer in 1-65535; ignored`)
      continue
    }
    ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

export function parseThresholds(raw: string | undefined, warnings: string[]): InspectionThresholds {
  const merged: InspectionThresholds = { ...DEFAULT_THRESHOLDS }
  if (raw === undefined || raw.trim() === '') return merged

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warnings.push('DSH_WFXM_INSPECT_THRESHOLDS is not valid JSON; using defaults')
    return merged
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnings.push('DSH_WFXM_INSPECT_THRESHOLDS must be a JSON object; using defaults')
    return merged
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in BOUNDS)) {
      warnings.push(`unknown threshold ${JSON.stringify(key)}; ignored`)
      continue
    }
    const field = key as keyof InspectionThresholds
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      warnings.push(`threshold ${key} must be a finite number; ignored`)
      continue
    }
    const { min, max } = BOUNDS[field]
    if (value < min || value > max) {
      warnings.push(`threshold ${key}=${value} is outside ${min}-${max}; ignored`)
      continue
    }
    merged[field] = value
  }

  const revert = (first: keyof InspectionThresholds, second: keyof InspectionThresholds, why: string): void => {
    warnings.push(`${why}; reverting ${first}/${second} to defaults`)
    merged[first] = DEFAULT_THRESHOLDS[first]
    merged[second] = DEFAULT_THRESHOLDS[second]
  }
  if (merged.diskWarnPct >= merged.diskFailPct) {
    revert('diskWarnPct', 'diskFailPct', 'diskWarnPct must be below diskFailPct')
  }
  if (merged.memWarnAvailPct <= merged.memFailAvailPct) {
    revert('memWarnAvailPct', 'memFailAvailPct', 'memWarnAvailPct must stay above memFailAvailPct')
  }
  if (merged.loadWarnPerCore >= merged.loadFailPerCore) {
    revert('loadWarnPerCore', 'loadFailPerCore', 'loadWarnPerCore must be below loadFailPerCore')
  }
  if (merged.logErrWarn >= merged.logErrFail) {
    revert('logErrWarn', 'logErrFail', 'logErrWarn must be below logErrFail')
  }
  return merged
}

export function readInspectionConfig(env: NodeJS.ProcessEnv = process.env): InspectionConfigResult {
  const warnings: string[] = []
  return {
    thresholds: parseThresholds(env.DSH_WFXM_INSPECT_THRESHOLDS, warnings),
    expectedPorts: parseExpectedPorts(env.DSH_WFXM_EXPECTED_PORTS, warnings),
    warnings,
  }
}
