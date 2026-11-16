/**
 * dsh seam for the front desk: one tool-less model turn per inbound message.
 *
 * `dsh --profile headless --patch <frontdesk> --json -` with the prompt on
 * stdin. The patch overlay (`assets/frontdesk.patch.yml`) strips every
 * model-facing tool, and `DSH_PERMISSION_MODE=read-only` is the second layer of
 * the same guarantee: even a misbehaving turn cannot change the host (AR25 / #11).
 *
 * Failures are thrown, not papered over — the foreground decides whether to
 * degrade to the rule path and records why (AR13).
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export type DecisionRunner = (prompt: string) => Promise<string>

export interface DshDecisionRunnerOptions {
  /** dsh binary; default `dsh` (resolved through the child's PATH). */
  dshBin?: string
  /** dsh profile; default `headless`. */
  profile?: string
  /** Overlay that removes the tool face; defaults to the shipped asset. */
  patchPath?: string
  /** Hard wall-clock limit for one decision turn. */
  timeoutMs?: number
  /** Grace between SIGTERM and SIGKILL. */
  killGraceMs?: number
  /** Where the child runs; defaults to the OS temp directory. */
  cwd?: string
  /** Extra env merged over `process.env` (the permission mode wins). */
  env?: Record<string, string>
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_KILL_GRACE_MS = 3_000

/** Path of the shipped tool-less overlay (`assets/frontdesk.patch.yml`). */
export function defaultPatchPath(): string {
  return fileURLToPath(new URL('../assets/frontdesk.patch.yml', import.meta.url))
}

function tail(text: string, max = 400): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

interface RunEvent {
  type?: unknown
  phase?: unknown
  reason?: { kind?: unknown; error?: { code?: unknown; message?: unknown } }
  text?: unknown
}

export function createDshDecisionRunner(options: DshDecisionRunnerOptions = {}): DecisionRunner {
  const dshBin = options.dshBin ?? 'dsh'
  const profile = options.profile ?? 'headless'
  const patchPath = options.patchPath ?? defaultPatchPath()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const cwd = options.cwd ?? (process.env.TMPDIR ?? '/tmp')

  return function decide(prompt) {
    return new Promise<string>((resolve, reject) => {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...(options.env ?? {}),
        DSH_PERMISSION_MODE: 'read-only',
      }

      let child
      try {
        child = spawn(
          dshBin,
          ['--profile', profile, '--patch', patchPath, '--json', '-'],
          { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
        )
      } catch (error) {
        reject(new Error(`spawn ${dshBin} threw: ${error instanceof Error ? error.message : String(error)}`))
        return
      }

      let finalText: string | null = null
      const textParts: string[] = []
      let runError: string | null = null
      let stderrText = ''
      let lineBuffer = ''
      let timedOut = false
      let spawnError: NodeJS.ErrnoException | null = null
      let settled = false
      let killTimer: NodeJS.Timeout | null = null

      const handleLine = (line: string): void => {
        const trimmed = line.trim()
        if (trimmed === '') return
        let event: RunEvent
        try {
          event = JSON.parse(trimmed) as RunEvent
        } catch {
          return // non-JSON noise on stdout is tolerated.
        }
        if (event.type === 'text' && typeof event.text === 'string') {
          textParts.push(event.text)
        } else if (event.type === 'final' && typeof event.text === 'string') {
          finalText = event.text
        } else if (
          event.type === 'status'
          && event.phase === 'turn_end'
          && event.reason?.kind === 'error'
        ) {
          const code = typeof event.reason.error?.code === 'string' ? event.reason.error.code : 'unknown'
          const message = typeof event.reason.error?.message === 'string' ? event.reason.error.message : 'run failed'
          runError = `${code}: ${message}`
        }
      }

      const timer = setTimeout(() => {
        timedOut = true
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGTERM')
          killTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
          }, killGraceMs)
          killTimer.unref?.()
        }
      }, timeoutMs)
      timer.unref?.()

      child.stdout?.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString('utf8')
        let index = lineBuffer.indexOf('\n')
        while (index >= 0) {
          handleLine(lineBuffer.slice(0, index))
          lineBuffer = lineBuffer.slice(index + 1)
          index = lineBuffer.indexOf('\n')
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8')
        if (stderrText.length > 32_000) stderrText = stderrText.slice(-32_000)
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        spawnError = error
      })
      child.stdin?.on('error', () => {
        // EPIPE: the child died before reading the prompt; `close` settles it.
      })
      child.stdin?.write(`${prompt}\n`)
      child.stdin?.end()

      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer !== null) clearTimeout(killTimer)
        if (lineBuffer.trim().length > 0) handleLine(lineBuffer)

        if (spawnError !== null) {
          reject(new Error(
            spawnError.code === 'ENOENT'
              ? `dsh binary not found: ${dshBin}`
              : `spawn ${dshBin} failed: ${spawnError.message}`,
          ))
          return
        }
        if (timedOut) {
          reject(new Error(`front-desk decision timed out after ${timeoutMs}ms`))
          return
        }
        if (runError !== null) {
          reject(new Error(`dsh run error ${runError}`))
          return
        }
        if (code !== 0) {
          reject(new Error(
            `dsh exited ${signal === null ? `code ${code}` : `signal ${signal}`}: ${tail(stderrText) || '(no stderr)'}`,
          ))
          return
        }
        const text = finalText ?? (textParts.length > 0 ? textParts.join('') : '')
        if (text.trim() === '') {
          reject(new Error('front-desk decision returned no text'))
          return
        }
        resolve(text)
      })
    })
  }
}
