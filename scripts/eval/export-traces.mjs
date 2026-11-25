#!/usr/bin/env node
/**
 * P2-5：把线上 dsh 会话日志导出为可回放的脱敏轨迹。
 *
 *   node scripts/eval/export-traces.mjs [--source <sessions 目录|文件>] [--out <目录>]
 *                                       [--repo-root <目录>] [--label <名字>] [--limit N]
 *                                       [--since <ISO 时间>] [--dry-run]
 *
 * - 输入：dsh 的 `session.v4.jsonl.zstd`（或未压缩的 `.jsonl`），默认 `~/.dsh/sessions`。
 * - 输出：`eval/trajectory/<id>.ndjson` + 同 id 的草稿任务 JSON；该目录被 `.gitignore`
 *   忽略，**生产轨迹只留在本机，不进公共仓**。
 * - 只保留外部可观察行为：工具名、成功/失败、步骤数、脱敏后的最终回复；不保留
 *   system/reasoning、工具参数与工具输出、用户原话、绝对路径。
 * - 生成的判据只是草稿（工具集合），需人工确认后再作为回归标准；不自动改
 *   `agent-eval/tasks/`，也不自动提交。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

import { redactText } from '../../plugins/redact/lib/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const source = resolve(option('source', process.env.DSH_SESSIONS_DIR ?? join(homedir(), '.dsh', 'sessions')))
const outDir = resolve(option('out', join(repoRoot, 'eval', 'trajectory')))
const traceRoot = resolve(option('repo-root', repoRoot))
const label = (option('label', 'prod') ?? 'prod').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'prod'
const limit = Math.max(1, Number(option('limit', '20')) || 20)
const since = option('since', null) === null ? null : Date.parse(option('since'))
const dryRun = args.includes('--dry-run')

/** 绝对路径与 Windows 路径都替换成占位符，避免把机器布局带进轨迹。 */
const PATH_PATTERNS = [
  /(?:\/home|\/Users|\/root|\/opt|\/var|\/srv|\/tmp|\/etc)\/[^\s"'`<>，。；：)）\]]+/g,
  /[A-Za-z]:\\[^\s"'`<>]+/g,
]

function scrub(text) {
  let value = redactText(text).value
  for (const pattern of PATH_PATTERNS) value = value.replace(pattern, '<path>')
  return value.replace(/\s+/g, ' ').trim()
}

function hash8(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/** 找到所有会话日志文件；`--source` 也可以直接指向单个文件。 */
function discover() {
  if (!existsSync(source)) return []
  if (statSync(source).isFile()) return [source]
  const files = []
  for (const project of readdirSync(source, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(source, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const file = join(projectDir, session.name, name)
        if (existsSync(file)) files.push(file)
      }
    }
  }
  return files
}

function readSession(file) {
  const raw = readFileSync(file)
  const text = file.endsWith('.zstd') ? decompressFrames(raw).toString('utf8') : raw.toString('utf8')
  const events = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 会话日志偶尔有非 JSON 行，跳过即可。
    }
  }
  return events
}

/** dsh 会话日志是逐帧追加的 zstd；Node 默认只解第一帧，这里按魔数逐帧拼接。 */
function decompressFrames(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; i + MAGIC.length <= buffer.length; i += 1) {
    if (buffer.subarray(i, i + MAGIC.length).equals(MAGIC)) starts.push(i)
  }
  if (starts.length === 0 || starts[0] !== 0) return zstdDecompressSync(buffer)

  const chunks = []
  let index = 0
  while (index < starts.length) {
    let next = -1
    for (let candidate = index + 1; candidate <= starts.length; candidate += 1) {
      const end = candidate < starts.length ? starts[candidate] : buffer.length
      try {
        chunks.push(zstdDecompressSync(buffer.subarray(starts[index], end)))
        next = candidate
        break
      } catch {
        // 魔数可能出现在压缩数据内部；继续向下合并，直到整帧解压成功。
      }
    }
    if (next === -1) throw new Error('无法解压 zstd 会话日志（帧边界不完整）')
    index = next
  }
  return Buffer.concat(chunks)
}

/**
 * 会话事件 → 按 turn 分组的回放事件。
 * `parseDshNdjson` 只认 tool_call / tool_result / status / final，这里提前裁剪掉
 * 一切可能带原文的字段。
 */
function convert(events) {
  let sessionId = null
  const turns = []
  let current = null
  const callNames = new Map()

  for (const event of events) {
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'session') {
      sessionId = typeof data.id === 'string' ? data.id : typeof event.id === 'string' ? event.id : null
      continue
    }
    if (type === 'turn/start') {
      current = { tools: [], records: [], reply: '' }
      turns.push(current)
      continue
    }
    if (current === null) continue

    if (type === 'tool/call') {
      const name = data.name
      if (typeof name !== 'string' || name === '') continue
      callNames.set(data.callId, name)
      current.tools.push(name)
      current.records.push({ type: 'tool_call', name })
      continue
    }
    if (type === 'tool/result') {
      const callId = data.toolCallId ?? data.message?.toolCallId
      const name = callNames.get(callId)
      if (typeof name !== 'string') continue
      current.records.push({ type: 'tool_result', name, ok: data.message?.isError !== true })
      continue
    }
    if (type === 'step/end') {
      current.records.push({ type: 'status', phase: 'step_end' })
      continue
    }
    if (type === 'assistant/message') {
      const content = Array.isArray(data.message?.content) ? data.message.content : []
      const text = content
        .filter((item) => item?.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n')
      if (text !== '') current.reply = text
      continue
    }
    if (type === 'turn/end') {
      const kind = data.reason?.kind
      if (typeof kind === 'string' && kind !== 'completed') {
        current.records.push({ type: 'status', phase: 'turn_end', reason: { kind } })
      }
      current = null
    }
  }

  return { sessionId, turns }
}

function writeTrace(file, sessionId, turn) {
  const lines = [
    JSON.stringify({ type: 'session', sessionId: `prod-${hash8(sessionId ?? file)}` }),
    ...turn.records.map((record) => JSON.stringify(record)),
  ]
  const reply = scrub(turn.reply)
  if (reply !== '') lines.push(JSON.stringify({ type: 'final', text: reply }))
  writeFileSync(file, `${lines.join('\n')}\n`)
  return reply
}

function buildTask({ id, title, tools, reply, traceFile }) {
  const uniqueTools = [...new Set(tools)]
  const expect = uniqueTools.length > 0
    ? { requiredTools: uniqueTools }
    // 没有工具时用回复片段证明回放确实走到了最终回复；人工确认后应替换成真正的判据。
    : { containsAny: [reply.slice(0, Math.min(12, reply.length))] }
  return {
    id,
    title,
    suite: 'dsh-trajectory',
    notes: '由 scripts/eval/export-traces.mjs 自动导出的生产轨迹草稿：只保留工具名/成败与脱敏回复，判据需人工确认。',
    taxonomy: 'online-replay',
    difficulty: 'medium',
    source: 'online-replay',
    split: 'dev',
    kind: 'chat',
    turns: ['（生产轨迹回放）'],
    timeoutMs: 30000,
    expect,
    runtimeHints: { dsh: { traceFile } },
  }
}

const files = discover()
  .map((file) => ({ file, at: statSync(file).mtimeMs }))
  .filter((entry) => since === null || Number.isNaN(since) || entry.at >= since)
  .sort((a, b) => b.at - a.at)

if (files.length === 0) {
  console.warn(`export-traces: 没有找到会话日志（${source}）`)
  process.exit(0)
}

if (!dryRun) mkdirSync(outDir, { recursive: true })

let written = 0
let skipped = 0
for (const { file, at } of files) {
  if (written >= limit) break
  let events
  try {
    events = readSession(file)
  } catch (error) {
    console.warn(`export-traces: 跳过无法解压/解析的会话 ${file}（${error instanceof Error ? error.message : String(error)}）`)
    skipped += 1
    continue
  }
  const { sessionId, turns } = convert(events)
  const date = new Date(at).toISOString().slice(0, 10)
  for (const [index, turn] of turns.entries()) {
    if (written >= limit) break
    if (turn.records.length === 0) {
      skipped += 1
      continue
    }
    const id = `dsh-${label}-${hash8(`${sessionId ?? file}:${index}`)}`
    const tracePath = join(outDir, `${id}.ndjson`)
    const traceFile = relative(traceRoot, tracePath).split('\\').join('/')
    if (traceFile.startsWith('..')) {
      console.error(`export-traces: 输出目录必须在 --repo-root 内（当前 ${traceFile}）`)
      process.exit(1)
    }
    const reply = dryRun ? scrub(turn.reply) : writeTrace(tracePath, sessionId ?? file, turn)
    const task = buildTask({
      id,
      title: `生产轨迹回放 ${date} #${index + 1}`,
      tools: turn.tools,
      reply,
      traceFile,
    })
    if (!dryRun) writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(task, null, 2)}\n`)
    written += 1
    console.log(`export-traces: ${dryRun ? '[dry-run] ' : ''}${id} → ${traceFile}`)
  }
}

console.log(`export-traces: 写入 ${written} 条轨迹，跳过 ${skipped} 条（来源 ${source}，输出 ${outDir}）`)
