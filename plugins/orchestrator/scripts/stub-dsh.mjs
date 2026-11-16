#!/usr/bin/env node
/**
 * Fake `dsh` for the front-desk tests: same argv shape, same NDJSON output,
 * no model, no network. Behaviour is chosen with STUB_DSH_MODE:
 *
 * - `json`   (default): print one `text` + one `final` event with STUB_DSH_TEXT.
 * - `sleep`:  wait STUB_DSH_SLEEP_MS, then behave like `json` (timeout tests).
 * - `error`:  end the turn with an error reason and exit 0 (dsh does this too).
 * - `crash`:  write STUB_DSH_STDERR to stderr and exit 3.
 *
 * When STUB_DSH_RECORD points at a file, the argv and the permission-mode env
 * are written there so the runner test can assert the exact invocation.
 */

import { writeFileSync } from 'node:fs'

const mode = process.env.STUB_DSH_MODE ?? 'json'
const text = process.env.STUB_DSH_TEXT ?? '{"action":"reply","text":"stub"}'

const record = process.env.STUB_DSH_RECORD
if (record !== undefined && record !== '') {
  writeFileSync(record, JSON.stringify({
    argv: process.argv.slice(2),
    permissionMode: process.env.DSH_PERMISSION_MODE ?? null,
  }), 'utf8')
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', async () => {
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

  if (mode === 'sleep') {
    const ms = Number(process.env.STUB_DSH_SLEEP_MS ?? '5000')
    await new Promise((resolve) => setTimeout(resolve, ms))
  }
  if (mode === 'crash') {
    process.stderr.write(process.env.STUB_DSH_STDERR ?? 'stub crash')
    process.exit(3)
  }

  emit({ type: 'session', sessionId: 'session-stub' })
  emit({ type: 'status', phase: 'turn_start', turn: 1 })
  if (mode === 'error') {
    emit({
      type: 'status',
      phase: 'turn_end',
      turn: 1,
      reason: { kind: 'error', error: { code: 'STUB_ERROR', message: 'stub run error' } },
    })
    process.exit(0)
  }
  emit({ type: 'text', text })
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
  emit({ type: 'final', text })
  // Echo the prompt back when asked, so tests can assert what the model saw.
  if (process.env.STUB_DSH_ECHO_PROMPT === '1') {
    writeFileSync(`${record ?? '/tmp/stub-dsh'}.prompt`, input, 'utf8')
  }
  process.exit(0)
})
