/**
 * J6 部署级检索自检（Slice AW）。
 *
 * 固定检查：headless profile 是否真的挂载 web_search / web_fetch 插件与 provider
 * 配置——"工具在文档里 ✅"不等于"这台机器装了"。真机检查是 opt-in：
 * `--live` 或 `DSH_WFXM_SEARCH_LIVE=1`，默认不把网络依赖带进 CI。
 *
 * 运行：node scripts/verify-search.mjs [--live]
 */

import { spawnSync } from 'node:child_process'

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

const profile = process.env.DSH_WFXM_SEARCH_PROFILE ?? 'headless'
const dumped = spawnSync('dsh', ['--profile', profile, '--dump-config'], {
  encoding: 'utf8',
  timeout: 60_000,
})
const config = dumped.stdout ?? ''
const live = process.argv.includes('--live') || process.env.DSH_WFXM_SEARCH_LIVE === '1'

console.log(`profile=${profile} · dump ${dumped.status === 0 ? 'ok' : `failed (${dumped.stderr?.trim() || dumped.status})`}`)

await check('the headless profile mounts the web-search plugin', async () =>
  dumped.status === 0 && config.includes('@deepseek-ai/dsh-web-search-deepseek'))

await check('the headless profile mounts the web-fetch plugin', async () =>
  dumped.status === 0 && config.includes('@deepseek-ai/dsh-web-fetch-http'))

await check('search/fetch providers and timeout are configured', async () => {
  const provider = /searchProvider:\s*(\S+)/.exec(config)
  const fetchProvider = /fetchProvider:\s*(\S+)/.exec(config)
  const timeout = /searchTimeoutMs:\s*(\d+)/.exec(config)
  return dumped.status === 0
    && provider !== null && provider[1] !== ''
    && fetchProvider !== null && fetchProvider[1] !== ''
    && timeout !== null && Number(timeout[1]) > 0
})

if (live) {
  await check('a live run returns a real source URL through web_search', async () => {
    const run = spawnSync(
      'dsh',
      ['--profile', profile, '--json'],
      {
        input: '请用 web_search 搜索“DeepSeek 官网”，只回复你找到的第一个结果标题和链接。',
        encoding: 'utf8',
        timeout: 180_000,
        env: process.env,
      },
    )
    if (run.status !== 0) {
      console.log(`      live run exited ${run.status}: ${(run.stderr ?? '').slice(0, 300)}`)
      return false
    }
    const events = run.stdout.split('\n').filter((line) => line.trim() !== '')
    let finalText = ''
    for (const line of events) {
      try {
        const event = JSON.parse(line)
        if (event.type === 'final' && typeof event.text === 'string') finalText = event.text
      } catch {
        // NDJSON 之外的行（诊断）忽略。
      }
    }
    const ok = /https?:\/\/\S+/.test(finalText)
    if (!ok) console.log(`      final: ${finalText.slice(0, 300)}`)
    return ok
  })
} else {
  console.log('SKIP  live retrieval (use --live or DSH_WFXM_SEARCH_LIVE=1)')
}

console.log(`\n${pass} passed · ${fail} failed${live ? '' : ' · 1 skipped (live)'}`)
if (fail > 0) process.exit(1)
