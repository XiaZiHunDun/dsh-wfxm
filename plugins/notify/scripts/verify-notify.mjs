import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  NotifyError,
  createNtfyFromEnv,
  createNtfyNotifier,
  withQuietWindow,
} from '../lib/index.js'

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    const ok = await fn()
    if (ok) {
      pass++
      console.log(`PASS  ${name}`)
    } else {
      fail++
      console.log(`FAIL  ${name}`)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const received = []
let status = 200
const server = createServer(async (req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  for await (const chunk of req) raw += chunk
  received.push({ method: req.method, url: req.url, headers: req.headers, body: raw })
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ id: 'ntfy-test-1' }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = server.address().port
const url = `http://127.0.0.1:${port}`

const notifier = createNtfyNotifier({ url, topic: 'dsh-wfxm-test' })

await check('p0 -> urgent priority and JSON publish', async () => {
  received.length = 0
  const receipt = await notifier.notify('p0', {
    title: '[P0] 巡检告警 @ host-a',
    body: '根分区使用率: 95%',
    tags: ['rotating_light'],
    key: 'default-min-safe:host-a',
  })
  const sent = received.at(-1)
  const payload = JSON.parse(sent.body)
  return sent.method === 'POST'
    && sent.headers['content-type'] === 'application/json'
    && payload.topic === 'dsh-wfxm-test'
    && payload.title === '[P0] 巡检告警 @ host-a'
    && payload.message === '根分区使用率: 95%'
    && payload.priority === 5
    && payload.tags[0] === 'rotating_light'
    && receipt.transport === 'ntfy'
    && receipt.id === 'ntfy-test-1'
    && typeof receipt.deliveredAt === 'string'
})

await check('p1 -> default priority', async () => {
  received.length = 0
  await notifier.notify('p1', { title: 'digest', body: 'ok 2 / warn 1' })
  const payload = JSON.parse(received.at(-1).body)
  return payload.priority === 3 && payload.tags === undefined && payload.topic === 'dsh-wfxm-test'
})

await check('source key is not leaked as a transport-specific field', async () => {
  received.length = 0
  await notifier.notify('p0', { title: 't', body: 'b', key: 'k' })
  return !received.at(-1).body.includes('"key"')
})

await check('token becomes a bearer authorization header', async () => {
  received.length = 0
  const authed = createNtfyNotifier({ url, topic: 'dsh-wfxm-test', token: 'tk-123' })
  await authed.notify('p0', { title: 't', body: 'b' })
  return received.at(-1).headers.authorization === 'Bearer tk-123'
})

await check('no token -> no authorization header', async () => {
  received.length = 0
  await notifier.notify('p0', { title: 't', body: 'b' })
  return received.at(-1).headers.authorization === undefined
})

await check('HTTP error -> upstream', async () => {
  status = 500
  let code = ''
  try {
    await notifier.notify('p0', { title: 't', body: 'b' })
  } catch (error) {
    code = error instanceof NotifyError ? error.code : 'not-notify-error'
  }
  status = 200
  return code === 'upstream'
})

await check('unreachable endpoint -> unavailable', async () => {
  const dead = createNtfyNotifier({ url: 'http://127.0.0.1:1', topic: 'x', timeoutMs: 2_000 })
  let code = ''
  try {
    await dead.notify('p0', { title: 't', body: 'b' })
  } catch (error) {
    code = error instanceof NotifyError ? error.code : 'not-notify-error'
  }
  return code === 'unavailable'
})

await check('empty topic -> not-configured without any request', async () => {
  received.length = 0
  const blank = createNtfyNotifier({ url, topic: '  ' })
  let code = ''
  try {
    await blank.notify('p0', { title: 't', body: 'b' })
  } catch (error) {
    code = error instanceof NotifyError ? error.code : 'not-notify-error'
  }
  return code === 'not-configured' && received.length === 0
})

await check('createNtfyFromEnv is disabled without a topic', () => {
  return createNtfyFromEnv({}) === undefined
    && createNtfyFromEnv({ DSH_WFXM_NTFY_TOPIC: '  ' }) === undefined
})

await check('createNtfyFromEnv builds an ntfy port from env', () => {
  const fromEnv = createNtfyFromEnv({
    DSH_WFXM_NTFY_TOPIC: 'dsh-wfxm-test',
    DSH_WFXM_NTFY_URL: url,
    DSH_WFXM_NTFY_TOKEN: 'tk-env',
  })
  return fromEnv?.transport === 'ntfy'
})

await check('base url with trailing slash is normalized', async () => {
  received.length = 0
  const slashed = createNtfyNotifier({ url: `${url}///`, topic: 'dsh-wfxm-test' })
  await slashed.notify('p0', { title: 't', body: 'b' })
  return received.at(-1).url === '/'
})

await check('quiet window suppresses a repeated key', async () => {
  received.length = 0
  let now = 1_000_000
  const port = withQuietWindow(notifier, { windowMs: 60_000, now: () => now })
  const first = await port.notify('p0', { title: 't', body: 'b', key: 'host-a' })
  now += 30_000
  const second = await port.notify('p0', { title: 't', body: 'b', key: 'host-a' })
  return received.length === 1
    && first.suppressed === undefined
    && second.suppressed === true
    && second.id === ''
})

await check('quiet window re-opens after the window elapses', async () => {
  received.length = 0
  let now = 2_000_000
  const port = withQuietWindow(notifier, { windowMs: 60_000, now: () => now })
  await port.notify('p0', { title: 't', body: 'b', key: 'host-b' })
  now += 60_000
  const later = await port.notify('p0', { title: 't', body: 'b', key: 'host-b' })
  return received.length === 2 && later.suppressed === undefined && later.id === 'ntfy-test-1'
})

await check('quiet window keeps distinct keys and keyless messages apart', async () => {
  received.length = 0
  const port = withQuietWindow(notifier, { windowMs: 60_000 })
  await port.notify('p0', { title: 't', body: 'b', key: 'host-c' })
  await port.notify('p0', { title: 't', body: 'b', key: 'host-d' })
  await port.notify('p0', { title: 't', body: 'b' })
  await port.notify('p0', { title: 't', body: 'b' })
  return received.length === 4
})

await check('failed delivery does not open the quiet window', async () => {
  let attempts = 0
  const flaky = {
    transport: 'fake',
    async notify() {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return { transport: 'fake', id: 'ok', deliveredAt: '2026-11-06T10:00:00.000Z' }
    },
  }
  const port = withQuietWindow(flaky, { windowMs: 60_000, now: () => 3_000_000 })
  let firstThrew = false
  try {
    await port.notify('p0', { title: 't', body: 'b', key: 'host-e' })
  } catch {
    firstThrew = true
  }
  const retry = await port.notify('p0', { title: 't', body: 'b', key: 'host-e' })
  return firstThrew && attempts === 2 && retry.id === 'ok'
})

await check('windowMs 0 disables suppression', async () => {
  received.length = 0
  const port = withQuietWindow(notifier, { windowMs: 0 })
  await port.notify('p0', { title: 't', body: 'b', key: 'host-f' })
  await port.notify('p0', { title: 't', body: 'b', key: 'host-f' })
  return received.length === 2
})

server.close()

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
