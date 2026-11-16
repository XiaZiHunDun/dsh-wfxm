#!/usr/bin/env node
/**
 * Client for the root-side unit control helper (docs/16 §三). Same argv shape as
 * the old sudo wrapper, so `DSH_WFXM_UNIT_CONTROL` can just point here:
 *
 *   dsh-wfxm-unit-client <start|stop|restart> <unit>
 *
 * It never elevates: the socket is 0660 root:dshwfxm, the whitelist lives in the
 * helper, and stdout/stderr are forwarded so svcops keeps its current parsing.
 */
import { connect } from 'node:net'

const SOCKET = process.env.DSH_WFXM_UNIT_SOCKET ?? '/run/dsh-wfxm/unit-control.sock'
const [verb, unit] = process.argv.slice(2)

if (!verb || !unit) {
  console.error('usage: dsh-wfxm-unit-client <start|stop|restart> <unit>')
  process.exit(64)
}

const socket = connect(SOCKET)
let buffer = ''
let finished = false

function finish(code) {
  if (finished) return
  finished = true
  socket.destroy()
  process.exit(code)
}

socket.setEncoding('utf8')
socket.on('connect', () => socket.write(`${JSON.stringify({ verb, unit })}\n`))
socket.on('data', (chunk) => {
  buffer += chunk
  const newline = buffer.indexOf('\n')
  if (newline < 0) return

  let result
  try {
    result = JSON.parse(buffer.slice(0, newline))
  } catch {
    console.error('unit-control: malformed reply')
    finish(1)
    return
  }
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (!result.ok) console.error(`unit-control: ${result.code} (${verb} ${unit})`)
  finish(result.ok ? 0 : 1)
})
socket.on('error', (error) => {
  console.error(`unit-control: ${error.message}`)
  finish(1)
})
