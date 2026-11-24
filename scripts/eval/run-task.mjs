#!/usr/bin/env node
/**
 * dsh 评测的薄驱动：只负责「把 prompt 交给真实 dsh，把原始 NDJSON 带回来」。
 *
 * 判定、trace 构造、指纹都在 agent-eval 侧；这里不解析判据，避免两套逻辑漂移。
 *
 * stdin payload：
 *   { id, turns: [string], timeoutMs?, runtimeHints: { dsh: { profile?, cwd?, env? } } }
 * stdout：最后一行 `__EVAL_RESULT__{ turns:[{ndjson, sessionId?}], ndjson, stderr, exitCode, durationMs, sessionId? }`
 *
 * 多轮：首轮拿 `session` 事件里的 sessionId，后续轮用 `--session-id` 续接同一会话。
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

function sessionIdFrom(ndjson) {
  for (const line of ndjson.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line)
      if (event?.type === "session" && typeof event.sessionId === "string") {
        return event.sessionId
      }
    } catch {
      // 非 JSON 行忽略。
    }
  }
  return undefined
}

/** 跑一轮；sessionId 存在时续接已有会话。 */
function runTurn({ bin, profile, cwd, env: extraEnv, prompt, sessionId, timeoutMs }) {
  return new Promise((resolve) => {
    const args = ["--profile", profile, "--json"]
    if (sessionId) args.push("--session-id", sessionId)
    args.push("-")

    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let ndjson = ""
    let stderr = ""
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ndjson, stderr, ...result })
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ error: `dsh 超时（${timeoutMs}ms）`, exitCode: null })
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      ndjson += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (err) => {
      finish({ error: `无法启动 dsh（${bin}）：${err.message}`, exitCode: null })
    })
    child.on("close", (code) => {
      finish({ exitCode: code, sessionId: sessionIdFrom(ndjson) })
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
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
  if (turns.length === 0) {
    emit({ error: "payload.turns 为空" })
    return
  }

  const hints = payload.runtimeHints?.dsh ?? {}
  const profile = hints.profile ?? env("DSH_EVAL_PROFILE", "headless")
  const bin = env("DSH_EVAL_DSH", "dsh")
  const cwd = hints.cwd ?? env("DSH_EVAL_CWD", process.cwd())
  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : 180_000

  const began = Date.now()
  const results = []
  let sessionId
  let lastExitCode = 0
  let lastStderr = ""

  for (const prompt of turns) {
    const turn = await runTurn({
      bin,
      profile,
      cwd,
      env: hints.env ?? {},
      prompt,
      ...(sessionId ? { sessionId } : {}),
      timeoutMs,
    })
    results.push({ ndjson: turn.ndjson, ...(turn.sessionId ? { sessionId: turn.sessionId } : {}) })
    if (turn.error) {
      emit({
        error: turn.error,
        turns: results,
        ndjson: results.map((item) => item.ndjson).join(""),
        stderr: turn.stderr,
        durationMs: Date.now() - began,
      })
      return
    }
    // 首轮或使用显式 sessionId 时，后续轮续接。
    sessionId = turn.sessionId ?? sessionId
    lastExitCode = turn.exitCode ?? 0
    lastStderr = turn.stderr
    if (!sessionId) {
      emit({
        error: "dsh 未返回 sessionId，无法续接多轮",
        turns: results,
        ndjson: results.map((item) => item.ndjson).join(""),
        stderr: turn.stderr,
        durationMs: Date.now() - began,
      })
      return
    }
  }

  emit({
    turns: results,
    ndjson: results.map((item) => item.ndjson).join(""),
    stderr: lastStderr,
    exitCode: lastExitCode,
    durationMs: Date.now() - began,
    sessionId,
  })
}

main()
