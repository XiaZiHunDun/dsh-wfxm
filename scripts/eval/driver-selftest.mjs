#!/usr/bin/env node
/**
 * 驱动自检：用假 dsh（stub-dsh.mjs）跑两轮，验证
 *   1. `__EVAL_RESULT__` 可解析；
 *   2. 首轮 sessionId 被后续轮沿用（`--session-id` 续接）。
 *
 * 不依赖真实 dsh、模型或网络。
 */

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DIR = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(DIR, "run-task.mjs")
const STUB = join(DIR, "stub-dsh.mjs")
const RESULT_PREFIX = "__EVAL_RESULT__"

function run(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVER], {
      env: { ...process.env, DSH_EVAL_DSH: STUB, DSH_EVAL_PROFILE: "headless" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", () => {
      const line = stdout.split(/\r?\n/).filter((item) => item.startsWith(RESULT_PREFIX)).pop()
      if (!line) {
        reject(new Error(`驱动没有输出 ${RESULT_PREFIX}；stderr=${stderr}`))
        return
      }
      resolve(JSON.parse(line.slice(RESULT_PREFIX.length)))
    })
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`)
  process.exit(1)
}

const result = await run({ turns: ["第一轮", "第二轮"], timeoutMs: 5000 })
if (result.error) fail(`驱动返回 error：${result.error}`)
if (!Array.isArray(result.turns) || result.turns.length !== 2) {
  fail(`期望 2 轮，实际 ${result.turns?.length ?? 0}`)
}
const [first, second] = result.turns
if (!first.sessionId) fail("首轮没有 sessionId")
if (first.sessionId !== second.sessionId) {
  fail(`两轮 sessionId 不一致：${first.sessionId} vs ${second.sessionId}`)
}
if (!second.ndjson.includes("stub reply: 第二轮")) fail("第二轮没有回传 prompt")
if (result.sessionId !== first.sessionId) fail("聚合结果 sessionId 不一致")

process.stdout.write(`PASS 驱动自检：2 轮共用 sessionId=${first.sessionId}\n`)
