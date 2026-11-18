#!/usr/bin/env node
/**
 * Fake `dsh --profile headless --json` for the hermetic executor tests.
 * Behaviour is selected with STUB_MODE; the prompt arrives on stdin and every
 * branch emits the same NDJSON event shapes the real binary does.
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const mode = process.env.STUB_MODE ?? 'ok'
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  emit({ type: 'session', sessionId: 'stub-session-1', cwd: process.cwd() })
  emit({ type: 'status', phase: 'turn_start', turn: 1 })
  switch (mode) {
    case 'ok':
      writeFileSync(process.env.STUB_OUTFILE, `stub wrote: ${input.trim()}\n`)
      emit({ type: 'text', text: 'file written' })
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({ type: 'final', text: 'stub completed the task' })
      break
    case 'env-echo':
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({
        type: 'final',
        text: `task=${process.env.DSH_WFXM_TASK_ID ?? ''} cp=${process.env.DSH_WFXM_CHECKPOINT_ID ?? ''} attempt=${process.env.DSH_WFXM_ATTEMPT ?? ''} approved=${process.env.DSH_WFXM_APPROVED_LEVEL ?? 'none'}`,
      })
      break
    case 'attach': {
      // Slice AS: produced files + the marker lines the executor must strip.
      const names = (process.env.STUB_ATTACH ?? 'report.txt').split(',')
      for (const name of names) writeFileSync(name, `artifact ${name}\n`)
      if (process.env.STUB_ATTACH_DIR === '1') mkdirSync('sub', { recursive: true })
      if (process.env.STUB_ATTACH_BIG === '1') {
        writeFileSync('big.bin', Buffer.alloc(20 * 1024 * 1024 + 1))
      }
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({ type: 'final', text: process.env.STUB_ATTACH_FINAL ?? names.map((name) => `[[ATTACH]] ${name}`).join('\n') })
      break
    }
    case 'need-input':
      writeFileSync(process.env.STUB_OUTFILE, `stub read: ${input.trim()}\n`)
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({ type: 'final', text: '[[NEED_INPUT]] 目标目录是哪个？' })
      break
    case 'fail-exit':
      process.stderr.write('boom: the change is impossible\n')
      process.exit(3)
      break
    case 'rate-limit':
      process.stderr.write('Error: 429 Too Many Requests: rate limit reached\n')
      process.exit(1)
      break
    case 'run-error':
      emit({
        type: 'status',
        phase: 'turn_end',
        turn: 1,
        reason: {
          kind: 'error',
          error: { code: 'MISSING_CREDENTIAL', message: 'no API key for provider route "deepseek-official"' },
        },
      })
      emit({ type: 'final', text: '' })
      break
    case 'garbage':
      process.stdout.write('this is not json\n{"broken"\n')
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({ type: 'final', text: 'recovered fine' })
      break
    case 'no-final':
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      break
    case 'sleep':
      // Stay alive well past any test timeout; killed children never get here.
      setTimeout(() => {
        emit({ type: 'final', text: 'late' })
      }, 60_000)
      break
    default:
      process.stderr.write(`unknown mode ${mode}\n`)
      process.exit(64)
  }
})
