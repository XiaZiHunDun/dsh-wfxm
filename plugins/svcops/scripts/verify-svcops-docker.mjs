import {
  DEFAULT_CONTAINER_PREFIX,
  MANAGED_LABEL,
  SvcOpsError,
  createDockerAdapter,
  isManagedContainer,
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

const result = (code, stdout = '', stderr = '') => ({ code, stdout, stderr })

function makeRunner(handler) {
  const calls = []
  return {
    calls,
    async run(argv, options) {
      calls.push({ argv, options })
      return handler(argv)
    },
  }
}

const CONTAINER = 'dsh-wfxm-managed-api'
const inspectJson = (name, labels) => JSON.stringify([{
  Name: `/${name}`,
  State: {
    Status: 'running',
    Running: true,
    Pid: 4321,
    StartedAt: '2026-11-04T10:00:00.000000000Z',
    RestartCount: 2,
  },
  Config: { Image: 'dsh-wfxm-api:latest', Labels: labels },
}])

await check('isManagedContainer 只放行托管前缀', () => Promise.resolve(
  isManagedContainer(`${DEFAULT_CONTAINER_PREFIX}api`)
  && !isManagedContainer('smoke-redis')
  && !isManagedContainer(`${DEFAULT_CONTAINER_PREFIX}api.service`)
  && !isManagedContainer('../../evil')))

await check('detect：守护进程可用', async () => {
  const runner = makeRunner(() => result(0, '27.0.0\n'))
  const adapter = createDockerAdapter({ runner })
  return await adapter.detect() === true
})

await check('detect：守护进程不可用', async () => {
  const runner = makeRunner(() => result(1, '', 'Cannot connect to the Docker daemon'))
  const adapter = createDockerAdapter({ runner })
  return await adapter.detect() === false
})

await check('list 解析 JSON 并过滤前缀/标签', async () => {
  const managed = JSON.stringify({
    Names: CONTAINER,
    State: 'running',
    Status: 'Up 2 months',
    Image: 'dsh-wfxm-api:latest',
    Labels: `${MANAGED_LABEL}=true,owner=wfxm`,
  })
  const noLabel = JSON.stringify({
    Names: CONTAINER,
    State: 'running',
    Status: 'Up 2 months',
    Image: 'dsh-wfxm-api:latest',
    Labels: 'owner=wfxm',
  })
  const outside = JSON.stringify({
    Names: 'smoke-redis',
    State: 'running',
    Status: 'Up 2 months',
    Image: 'redis:7',
    Labels: `${MANAGED_LABEL}=true`,
  })
  const runner = makeRunner(() => result(0, `${managed}\n${noLabel}\n${outside}\n`))
  const adapter = createDockerAdapter({ runner })
  const services = await adapter.list()
  return services.length === 1
    && services[0].unit === CONTAINER
    && services[0].activeState === 'running'
    && runner.calls[0].argv.join(' ').includes(`label=${MANAGED_LABEL}=true`)
})

await check('status 读取带标签容器', async () => {
  const runner = makeRunner(() => result(0, inspectJson(CONTAINER, { [MANAGED_LABEL]: 'true' })))
  const adapter = createDockerAdapter({ runner })
  const status = await adapter.status(CONTAINER)
  return status.unit === CONTAINER
    && status.activeState === 'running'
    && status.mainPid === 4321
    && status.restarts === 2
    && status.unitFileState === 'n/a'
})

await check('status 拒绝缺少同意标签的容器', async () => {
  const runner = makeRunner(() => result(0, inspectJson(CONTAINER, { owner: 'wfxm' })))
  const adapter = createDockerAdapter({ runner })
  let rejected = false
  try {
    await adapter.status(CONTAINER)
  } catch (error) {
    rejected = error instanceof SvcOpsError && error.code === 'not-allowed'
  }
  return rejected
})

await check('status 映射不存在的容器为 not-found', async () => {
  const runner = makeRunner(() => result(1, '', 'Error: No such object: dsh-wfxm-managed-api'))
  const adapter = createDockerAdapter({ runner })
  let code = ''
  try {
    await adapter.status(CONTAINER)
  } catch (error) {
    code = error instanceof SvcOpsError ? error.code : 'other'
  }
  return code === 'not-found'
})

await check('logs 合并 stdout/stderr 并夹住行数', async () => {
  const runner = makeRunner((argv) => {
    if (argv[1] === 'inspect') {
      return result(0, inspectJson(CONTAINER, { [MANAGED_LABEL]: 'true' }))
    }
    return result(0, 'out-line\n', 'err-line\n')
  })
  const adapter = createDockerAdapter({ runner })
  const logs = await adapter.logs(CONTAINER, 5000)
  const logsCall = runner.calls.at(-1).argv.join(' ')
  return logs.lines.length === 2
    && logs.lines[0] === 'out-line'
    && logs.lines[1] === 'err-line'
    && logsCall.includes('--tail 500')
})

await check('start/stop/restart 先验标签再执行', async () => {
  const actions = []
  const runner = makeRunner((argv) => {
    if (argv[1] === 'inspect') {
      return result(0, inspectJson(CONTAINER, { [MANAGED_LABEL]: 'true' }))
    }
    actions.push(argv[1])
    return result(0, `${CONTAINER}\n`)
  })
  const adapter = createDockerAdapter({ runner })
  const started = await adapter.start(CONTAINER)
  const stopped = await adapter.stop(CONTAINER)
  const restarted = await adapter.restart(CONTAINER)
  const actionTimeouts = runner.calls
    .filter((call) => ['start', 'stop', 'restart'].includes(call.argv[1]))
    .map((call) => call.options.timeoutMs)
  return started.changed && stopped.changed && restarted.changed
    && actions.join(',') === 'start,stop,restart'
    && actionTimeouts.every((timeout) => timeout === 60_000)
})

await check('写动作在无标签时不触达 docker start', async () => {
  const runner = makeRunner(() => result(0, inspectJson(CONTAINER, { owner: 'wfxm' })))
  const adapter = createDockerAdapter({ runner })
  let rejected = false
  try {
    await adapter.start(CONTAINER)
  } catch (error) {
    rejected = error instanceof SvcOpsError && error.code === 'not-allowed'
  }
  return rejected && !runner.calls.some((call) => call.argv[1] === 'start')
})

await check('前缀注入在 inspect 前拒绝', async () => {
  const runner = makeRunner(() => result(0, '[]'))
  const adapter = createDockerAdapter({ runner })
  let rejected = false
  try {
    await adapter.stop('../../evil')
  } catch (error) {
    rejected = error instanceof SvcOpsError && error.code === 'not-allowed'
  }
  return rejected && runner.calls.length === 0
})

await check('守护进程不可用映射 unavailable', async () => {
  const runner = makeRunner(() => result(1, '', 'Cannot connect to the Docker daemon'))
  const adapter = createDockerAdapter({ runner })
  let code = ''
  try {
    await adapter.list()
  } catch (error) {
    code = error instanceof SvcOpsError ? error.code : 'other'
  }
  return code === 'unavailable'
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
