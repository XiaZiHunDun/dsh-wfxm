/**
 * Picks how a decision turn is answered. Two interchangeable shapes behind one
 * interface so wiring (dev scripts, host assembly) never has to branch:
 *
 * - `sdk` (default): one resident `dsh --profile sdk` child, reused across
 *   turns. The profile mount is paid once, then each turn is just the model
 *   call (~1s instead of ~3.6s).
 * - `headless`: the slice-D path, one cold `dsh --profile headless` per turn.
 *   Kept as an escape hatch and for A/B measurement.
 */

import type { DecisionRunner } from './runner.js'
import { createDshDecisionRunner, type DshDecisionRunnerOptions } from './runner.js'
import {
  createDshSdkTurn,
  createSdkDecisionRunner,
  type DshSdkTurnOptions,
} from './sdk-runner.js'

export type DecisionRunnerKind = 'sdk' | 'headless'

/** A decision runner with an explicit lifecycle. */
export interface DecisionRunnerHandle extends DecisionRunner {
  /** Pay the boot cost now instead of on the first message. */
  warm(): Promise<void>
  /** Reap whatever the runner holds. Later turns reject (sdk) or no-op (headless). */
  close(): Promise<void>
}

export interface CreateDecisionRunnerOptions {
  kind?: DecisionRunnerKind | string | null
  timeoutMs?: number
  logger?: { warn?(message: string): void } | null
  /** Extra options for the resident runtime. */
  sdk?: DshSdkTurnOptions
  /** Extra options for the cold per-turn runtime. */
  headless?: DshDecisionRunnerOptions
}

export const DEFAULT_DECISION_RUNNER: DecisionRunnerKind = 'sdk'

export function createDecisionRunner(
  options: CreateDecisionRunnerOptions = {},
): DecisionRunnerHandle {
  const kind = options.kind ?? DEFAULT_DECISION_RUNNER
  if (kind !== 'sdk' && kind !== 'headless') {
    throw new Error(`unknown decision runner "${String(kind)}" (expected sdk or headless)`)
  }

  if (kind === 'headless') {
    const decide = createDshDecisionRunner({
      ...options.headless,
      ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    })
    return Object.assign(decide, {
      warm: async (): Promise<void> => undefined,
      close: async (): Promise<void> => undefined,
    })
  }

  return createSdkDecisionRunner({
    createTurn: () => createDshSdkTurn(options.sdk ?? {}),
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ...options.logger === undefined ? {} : { logger: options.logger },
  })
}
