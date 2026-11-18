/**
 * Resident front-desk runtime (slice F): one long-lived `dsh --profile sdk`
 * child that answers every decision turn over stdio JSON-RPC, instead of one
 * cold `dsh --profile headless` process per message.
 *
 * Why this exists: a fresh headless process spends ~2.3s before the model is
 * even asked (profile mount), on top of ~1.1s of generation. Keeping the
 * process alive removes the mount cost from every turn after the first, and —
 * because the profile, patch, provider, model and tool list stay fixed — keeps
 * the provider's cacheable prefix stable.
 *
 * Guarantees kept by construction, same as the headless runner:
 *
 * - **#11 the front stage never executes**: the child boots with
 *   `assets/frontdesk.sdk.patch.yml`, which disables every model-facing tool,
 *   plus `DSH_PERMISSION_MODE=read-only` as the second layer.
 * - **No silent recovery**: the SDK cannot cancel a running turn, so a timeout
 *   or transport failure *discards* the child (and the poisoned session) and
 *   the next turn starts a clean one. The failure is still thrown, so the
 *   foreground degrades to the rule path with a visible reason (AR13).
 */

import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { DecisionRunner } from './runner.js'

/** One resident runtime that answers turns until it is closed. */
export interface ResidentTurn {
  /** Boot (or reuse) the runtime. Idempotent. */
  start(): Promise<void>
  /** Send one prompt and resolve with the model's text for that turn. */
  ask(prompt: string, sessionKey?: string): Promise<string>
  /** Reap the runtime. Terminal for this instance. */
  close(): Promise<void>
}

/** A decision runner that owns a resident runtime. */
export interface SdkDecisionRunner extends DecisionRunner {
  /** Boot the runtime ahead of the first message; failures are the caller's to report. */
  warm(): Promise<void>
  /** Reap the runtime; later turns reject. */
  close(): Promise<void>
}

export interface SdkDecisionRunnerOptions {
  /** Builds the runtime; called again after any failure discards one. */
  createTurn: () => ResidentTurn
  /** Wall-clock limit for one decision turn. */
  timeoutMs?: number
  logger?: { warn?(message: string): void } | null
}

export interface DshSdkTurnOptions {
  /** dsh binary; the SDK client resolves its own same-version copy when omitted. */
  dshBin?: string
  /** Named profile serving the SDK protocol. */
  profile?: string
  /** Overlays applied to that profile; defaults to the shipped tool-less asset. */
  patches?: string[]
  /** Explicit harness home for the child. */
  dshHome?: string
  /** Workspace cwd recorded on the session; defaults to the OS temp directory. */
  cwd?: string
  provider?: string
  model?: string
  maxTokens?: number
  initializeTimeoutMs?: number
  /** Extra env merged over the parent environment (the permission mode wins). */
  env?: Record<string, string>
}

export const DEFAULT_SDK_PROFILE = 'sdk'
export const DEFAULT_SDK_TIMEOUT_MS = 60_000

/** Path of the shipped tool-less overlay for the `sdk` profile. */
export function defaultSdkPatchPath(): string {
  return fileURLToPath(new URL('../assets/frontdesk.sdk.patch.yml', import.meta.url))
}

/** The slice of `HarnessSession` this module uses, kept structural on purpose. */
interface HarnessSessionLike {
  run(input: string): Promise<{ finalResponse: string }>
}

export function createDshSdkTurn(options: DshSdkTurnOptions = {}): ResidentTurn {
  const profile = options.profile ?? DEFAULT_SDK_PROFILE
  const patches = options.patches ?? [defaultSdkPatchPath()]

  let harness: DeepSeekHarness | null = null
  // One session per thread id: the runtime is shared (warm), the conversation
  // is not. A chat must never see another chat's turns.
  const sessions = new Map<string, HarnessSessionLike>()

  return {
    async start() {
      if (harness !== null) return
      const created = new DeepSeekHarness({
        ...options.dshBin === undefined ? {} : { dshBin: options.dshBin },
        profile,
        patches,
        ...options.dshHome === undefined ? {} : { dshHome: options.dshHome },
        cwd: options.cwd ?? tmpdir(),
        ...options.provider === undefined ? {} : { provider: options.provider },
        ...options.model === undefined ? {} : { model: options.model },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.initializeTimeoutMs === undefined
          ? {}
          : { initializeTimeoutMs: options.initializeTimeoutMs },
        // `env` replaces the parent environment wholesale, so spread it ourselves.
        env: {
          ...(process.env as Record<string, string>),
          ...(options.env ?? {}),
          DSH_PERMISSION_MODE: 'read-only',
        },
      })
      await created.start()
      harness = created
    },

    async ask(prompt, sessionKey) {
      if (harness === null) throw new Error('front-desk SDK runtime is not started')
      const key = sessionKey ?? ''
      let session = sessions.get(key)
      if (session === undefined) {
        session = harness.session(key === '' ? undefined : key) as unknown as HarnessSessionLike
        sessions.set(key, session)
      }
      const result = await session.run(prompt)
      return result.finalResponse
    },

    async close() {
      const current = harness
      harness = null
      sessions.clear()
      if (current !== null) await current.close()
    },
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`front-desk decision timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export function createSdkDecisionRunner(options: SdkDecisionRunnerOptions): SdkDecisionRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SDK_TIMEOUT_MS
  const logger = options.logger ?? null

  let turn: ResidentTurn | null = null
  let closed = false
  /** Serialises turns: one runtime, one in-flight decision. */
  let tail: Promise<unknown> = Promise.resolve()

  async function ensureTurn(): Promise<ResidentTurn> {
    if (closed) throw new Error('front-desk SDK runner is closed')
    if (turn === null) {
      const created = options.createTurn()
      await created.start()
      turn = created
    }
    return turn
  }

  async function discard(reason: string): Promise<void> {
    const current = turn
    turn = null
    if (current === null) return
    logger?.warn?.(`front-desk runtime discarded: ${reason}`)
    try {
      await current.close()
    } catch (error) {
      logger?.warn?.(
        `front-desk runtime close failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async function ask(prompt: string, sessionKey?: string): Promise<string> {
    const active = await ensureTurn()
    try {
      const text = await withTimeout(active.ask(prompt, sessionKey), timeoutMs)
      if (text.trim() === '') throw new Error('front-desk decision returned no text')
      return text
    } catch (error) {
      // A failed or timed-out turn cannot be cancelled, so the session is
      // poisoned: drop the child and let the next message boot a clean one.
      await discard(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  const decide = ((prompt: string, sessionKey?: string): Promise<string> => {
    const run = tail.then(() => ask(prompt, sessionKey), () => ask(prompt, sessionKey))
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }) as SdkDecisionRunner

  decide.warm = async (): Promise<void> => {
    await ensureTurn()
  }

  decide.close = async (): Promise<void> => {
    closed = true
    await discard('closed')
  }

  return decide
}
