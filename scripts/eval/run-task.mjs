#!/usr/bin/env node
/**
 * dsh 评测的薄驱动：只负责「把 prompt 交给真实 dsh，把原始 NDJSON 带回来」。
 *
 * 判定、trace 构造、指纹都在 agent-eval 侧；这里不解析判据，避免两套逻辑漂移。
 *
 * stdin payload：
 *   { id, turns: [string], timeoutMs?, runtimeHints: { dsh: { profile?, cwd?, env? } } }
 * stdout：最后一行 `__EVAL_RESULT__{ ndjson, stderr, exitCode, durationMs, sessionId? }`
 *
 * 环境变量：
 *   DSH_EVAL_DSH        dsh 可执行文件（默认 dsh）
 *   DSH_EVAL_PROFILE    默认 headless
 *   DSH_EVAL_CWD        默认当前目录
 */

import { spawn } from "node:child_process"

const RESULT_PREFIX = "__EVAL_RESULT__"

function env(name, fallback) {
  const value = process.env[name]
  return value === undefined || value === "" ? fallback : value
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      raw += chunk
    })
    process.stdin.on("end", () => resolve(raw))
    process.stdin.on("error", reject)
  })
}

function emit(result) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
}

async function main() {
  let payload
  try {
    payload = JSON.parse(await readStdin())
  } catch (err) {
    emit({ error: `payload 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` })
    return
  }

  const turns = Array.isArray(payload.turns) ? payload.turns : []
  if (turns.length !== 1) {
    emit({ error: `unsupported:multi-turn（当前驱动只支持单轮，收到 ${turns.length} 轮）` })
    return
  }

  const hints = payload.runtimeHints?.dsh ?? {}
  const profile = hints.profile ?? env("DSH_EVAL_PROFILE", "headless")
  const bin = env("DSH_EVAL_DSH", "dsh")
  const cwd = hints.cwd ?? env("DSH_EVAL_CWD", process.cwd())
  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : 180_000

  const began = Date.now()
  const child = spawn(bin, ["--profile", profile, "--json", "-"], {
    cwd,
    env: { ...process.env, ...(hints.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let ndjson = ""
  let stderr = ""
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    child.kill("SIGKILL")
    emit({
      error: `dsh 超时（${timeoutMs}ms）`,
      ndjson,
      stderr,
      durationMs: Date.now() - began,
    })
  }, timeoutMs)

  child.stdout.on("data", (chunk) => {
    ndjson += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  child.on("error", (err) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    emit({
      error: `无法启动 dsh（${bin}）：${err.message}`,
      stderr,
      durationMs: Date.now() - began,
    })
  })

  child.on("close", (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    let sessionId
    for (const line of ndjson.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line)
        if (event?.type === "session" && typeof event.sessionId === "string") {
          sessionId = event.sessionId
        }
      } catch {
        // 非 JSON 行忽略；由 agent-eval 侧统一过滤。
      }
    }
    emit({
      ndjson,
      stderr,
      exitCode: code,
      durationMs: Date.now() - began,
      ...(sessionId ? { sessionId } : {}),
    })
  })

  child.stdin.write(turns[0])
  child.stdin.end()
}

main()
