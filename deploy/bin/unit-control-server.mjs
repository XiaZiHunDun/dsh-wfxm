#!/usr/bin/env node
/**
 * Root-side, whitelist-only unit control helper (docs/16 §三).
 *
 * The service runs with `NoNewPrivileges=yes`, so `sudo` can never elevate.
 * Instead this tiny root daemon owns a unix socket (mode 0660, root:dshwfxm) and
 * only forwards `start|stop|restart` for `dsh-wfxm-managed-<name>.service`.
 * Anything else is refused before tiny `systemctl` ever runs.
 *
 * Wire format: one JSON line in, one JSON line out.
 *   {"verb":"restart","unit":"dsh-wfxm-managed-demo.service"}
 *   {"ok":true,"code":"ok","verb":"restart","unit":"...","stdout":"","stderr":""}
 */
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

const SOCKET = process.env.DSH_WFXM_UNIT_SOCKET ?? '/run/dsh-wfxm/unit-control.sock'
const VERBS = new Set(['start', 'stop', 'restart'])
/** Same prefix rule as the sudo wrapper, minus anything that could escape it. */
const UNIT_RE = /^dsh-wfxm-managed-[a-z0-9][a-z0-9.-]*\.service$/
const MAX_REQUEST_BYTES = 4096

function reply(socket, payload, done) {
  if (done.closed) return
  done.closed = true
  socket.end(`${JSON.stringify(payload)}\n`)
}

function run(socket, done, verb, unit) {
  execFile('/bin/systemctl', [verb, unit], { timeout: 30_000 }, (error, stdout, stderr) => {
    reply(socket, {
      ok: error === null,
      code: error === null ? 'ok' : 'failed',
      verb,
      unit,
      stdout: String(stdout ?? '').slice(0, 4000),
      stderr: String(stderr ?? '').slice(0, 4000),
    }, done)
  })
}

const server = createServer((socket) => {
  const done = { closed: false }
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {
    done.closed = true
  })
  socket.on('data', (chunk) => {
    if (done.closed) return
    buffer += chunk
    if (buffer.length > MAX_REQUEST_BYTES) {
      reply(socket, { ok: false, code: 'too-large' }, done)
      return
    }
    const newline = buffer.indexOf('\n')
    if (newline < 0) return

    let message
    try {
      message = JSON.parse(buffer.slice(0, newline))
    } catch {
      reply(socket, { ok: false, code: 'bad-json' }, done)
      return
    }
    const verb = typeof message?.verb === 'string' ? message.verb : ''
    const unit = typeof message?.unit === 'string' ? message.unit : ''
    if (!VERBS.has(verb)) {
      reply(socket, { ok: false, code: 'bad-verb' }, done)
      return
    }
    if (!UNIT_RE.test(unit) || unit.includes('..')) {
      reply(socket, { ok: false, code: 'bad-unit' }, done)
      return
    }
    run(socket, done, verb, unit)
  })
})

server.on('error', (error) => {
  console.error(`[unit-control] ${error.message}`)
  process.exit(1)
})

server.listen(SOCKET, () => {
  try {
    // The directory comes from systemd's RuntimeDirectory (root:dshwfxm 0750).
    execFileSync('/bin/chown', ['root:dshwfxm', SOCKET])
    execFileSync('/bin/chmod', ['0660', SOCKET])
  } catch (error) {
    console.error(`[unit-control] cannot secure ${SOCKET}: ${error.message}`)
    process.exit(1)
  }
  console.log(`[unit-control] listening on ${SOCKET}`)
})
