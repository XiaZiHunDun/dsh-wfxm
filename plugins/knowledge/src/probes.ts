/**
 * Built-in read-only probes for the fact gate.
 *
 * Only probes that need no host runtime beyond `node:fs` live here. Service /
 * unit / port probes belong to module ⑦ (svcops) and will be wired in through
 * the same `FactProbe` seam; until then those predicates stay `unverified`.
 */

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { FactProbe } from './verify.js'

/**
 * `path` probe: existence only. Absolute paths only, so a fact cannot be used
 * to enumerate relative locations or read file content (19 §七).
 */
export function createPathProbe(): FactProbe {
  return (probe, expected) => {
    if (probe !== 'path') return { status: 'unavailable' }
    if (expected === null || !isAbsolute(expected)) return { status: 'unavailable' }
    try {
      const exists = existsSync(expected)
      return { status: exists ? 'match' : 'mismatch', observed: `${expected} ${exists ? 'exists' : 'missing'}` }
    } catch {
      return { status: 'unavailable' }
    }
  }
}
