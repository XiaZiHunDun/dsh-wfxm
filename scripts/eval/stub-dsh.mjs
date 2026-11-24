#!/usr/bin/env node
/**
 * 假 dsh：只服务驱动自检（`pnpm eval:driver:selftest`），不参与 L2 判分。
 *
 * 支持与真实 dsh headless 相同的最小 argv：
 *   --profile <p> --json [--session-id <id>] -
 * 输出最小 NDJSON：session / tool_call / tool_result / status / final / text。
 */

const args = process.argv.slice(2)

function argValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const profile = argValue("--profile") ?? "headless"
const explicitSession = argValue("--session-id")

function readStdin() {
  return new Promise((resolve) => {
    let raw = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      raw += chunk
    })
    process.stdin.on("end", () => resolve(raw))
  })
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

const prompt = (await readStdin()).trim()
const sessionId = explicitSession ?? `stub-${process.pid}`
const reply = `stub reply: ${prompt}`

emit({ type: "session", sessionId, profile })
emit({ type: "tool_call", path: "svc_list", input: {} })
emit({ type: "tool_result", name: "svc_list", status: "completed", ok: true })
emit({
  type: "status",
  phase: "step_end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
})
emit({ type: "text", text: reply })
emit({ type: "final", text: reply })
emit({ type: "status", phase: "turn_end", status: "completed" })
