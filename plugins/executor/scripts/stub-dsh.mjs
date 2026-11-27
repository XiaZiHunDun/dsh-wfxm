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
      // Slice BK (I5): two steps so the executor must sum, not overwrite.
      emit({ type: 'status', phase: 'step_end', turn: 1, usage: { inputTokens: 1000, outputTokens: 200 } })
      emit({ type: 'status', phase: 'step_end', turn: 2, usage: { inputTokens: 2000, outputTokens: 400 } })
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({ type: 'final', text: 'stub completed the task' })
      break
    case 'env-echo':
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({
        type: 'final',
        text: `task=${process.env.DSH_WFXM_TASK_ID ?? ''} cp=${process.env.DSH_WFXM_CHECKPOINT_ID ?? ''} attempt=${process.env.DSH_WFXM_ATTEMPT ?? ''} project=${process.env.DSH_WFXM_PROJECT_ID ?? 'none'} approved=${process.env.DSH_WFXM_APPROVED_LEVEL ?? 'none'} node_env=${process.env.NODE_ENV ?? 'unset'}`,
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
    case 'null-json':
      // Valid JSON that is not an event shape: must be ignored, not thrown on.
      process.stdout.write('null\n42\n["not","an","event"]\n')
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({ type: 'final', text: 'survived null noise' })
      break
    case 'utf8-split': {
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      // Split the final event in the middle of a multibyte character and write
      // the halves in two separate chunks.
      const payload = Buffer.from(JSON.stringify({ type: 'final', text: '中文回执：完成' }))
      const cut = payload.indexOf(Buffer.from('中')) + 1
      process.stdout.write(payload.subarray(0, cut))
      setTimeout(() => {
        process.stdout.write(payload.subarray(cut))
        process.stdout.write('\n')
      }, 30)
      break
    }
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
