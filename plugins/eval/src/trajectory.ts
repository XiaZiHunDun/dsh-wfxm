/**
 * 生产轨迹 → agent-eval 候选（P7-1）。
 *
 * `/eval from-task <task>` 与 `scripts/trace.mjs export` 共用这一段：
 * 只保留工具名/成败、阶段状态与脱敏后的最终摘要，绝不导出用户原话、
 * 工具参数或绝对路径。写盘只落 `<id>.ndjson` 与 `<id>.json` 草稿。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { redactText } from '@dsh-wfxm/redact'

export interface TraceEventLike {
  ts: string
  event: string
  level: string
  phase: string
  status?: string | null
  error?: { code?: string | null; kind?: string | null } | null
  tool?: { name?: string | null; exitCode?: number | null } | null
}

export interface TraceAttemptLike {
  summary?: string | null
}

export interface TrajectoryTaskLike {
  id: string
  taskRef?: string | null
  correlationId?: string | null
}

export interface TrajectoryCandidateInput {
  task: TrajectoryTaskLike
  events: readonly TraceEventLike[]
  attempts?: readonly TraceAttemptLike[]
  /** `<id>.ndjson` 与 `<id>.json` 的落盘目录。 */
  outDir: string
  /** 草稿里的 `runtimeHints.dsh.traceFile` 相对此根计算。 */
  root: string
  label?: string
  /** CLI 默认覆盖；`/eval from-task` 用 `refuse` 避免重复落盘。 */
  onExists?: 'overwrite' | 'refuse'
  /** 只计算不写盘（`trace.mjs export --dry-run`）。 */
  dryRun?: boolean
}

export type TrajectoryCandidate =
  | {
    ok: true
    id: string
    taskRef: string
    tracePath: string
    draftPath: string
    traceFile: string
    display: string
    lines: number
    tools: number
    draft: Record<string, unknown>
  }
  | { ok: false; reason: 'no-events' | 'exists' | 'outside-root'; display?: string }

function hash8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/** 绝对路径与密钥都不离开本机，即使是完整模式。 */
function scrub(text: string): string {
  return redactText(text).value
    .replace(/(?:\/home|\/Users|\/root|\/opt|\/var|\/srv|\/tmp|\/etc)\/[^\s"'`<>，。；：)）\]]+/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s"'`<>]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `attempt.finished` 的失败映射成回放里的 `turn_end`。 */
function statusFor(row: TraceEventLike): Record<string, unknown> | null {
  if (row.event !== 'attempt.finished' || row.status !== 'failed') return null
  return { type: 'status', phase: 'turn_end', reason: { kind: row.error?.kind ?? 'error' } }
}

export function buildExportLines(
  events: readonly TraceEventLike[],
  traceId: string,
  finalText: string,
): string[] {
  const lines = [JSON.stringify({ type: 'session', sessionId: `prod-${hash8(traceId)}` })]
  for (const row of events) {
    if (row.event === 'tool.call' && row.tool?.name != null) {
      lines.push(JSON.stringify({ type: 'tool_call', name: row.tool.name }))
    } else if (row.event === 'tool.result' && row.tool?.name != null) {
      lines.push(JSON.stringify({
        type: 'tool_result',
        name: row.tool.name,
        ok: row.status !== 'failed' && (row.tool.exitCode ?? 0) === 0,
      }))
    } else if (row.event === 'executor.step') {
      lines.push(JSON.stringify({ type: 'status', phase: 'step_end' }))
    } else {
      const status = statusFor(row)
      if (status !== null) {
        lines.push(JSON.stringify(status))
      } else if (row.level === 'error' && row.error?.code != null) {
        // merge/prepare/delivery 失败没有 attempt，但回放仍要能定位停在哪里。
        lines.push(JSON.stringify({
          type: 'status',
          phase: 'error',
          reason: { kind: row.error.code },
        }))
      }
    }
  }
  if (finalText !== '') lines.push(JSON.stringify({ type: 'final', text: finalText }))
  return lines
}

export function buildDraftTask(input: {
  id: string
  task: TrajectoryTaskLike
  tools: readonly string[]
  finalText: string
  traceFile: string
}): Record<string, unknown> {
  const uniqueTools = [...new Set(input.tools)]
  const expect = uniqueTools.length > 0
    ? { requiredTools: uniqueTools }
    : { containsAny: [input.finalText.slice(0, Math.min(12, input.finalText.length))] }
  return {
    id: input.id,
    title: `生产任务轨迹 ${input.task.taskRef ?? input.task.id.slice(0, 8)}`,
    suite: 'dsh-trajectory',
    notes: '由生产轨迹导出的草稿：只保留工具名/成败与脱敏摘要，判据需人工确认。',
    taxonomy: 'online-replay',
    difficulty: 'medium',
    source: 'online-replay',
    split: 'dev',
    kind: 'chat',
    turns: ['（生产任务轨迹回放）'],
    timeoutMs: 30000,
    expect,
    runtimeHints: { dsh: { traceFile: input.traceFile } },
  }
}

/** 把一条生产轨迹写成 agent-eval 的 NDJSON + 草稿任务。 */
export function createTrajectoryCandidate(input: TrajectoryCandidateInput): TrajectoryCandidate {
  const events = [...input.events].sort((a, b) => a.ts.localeCompare(b.ts))
  if (events.length === 0) return { ok: false, reason: 'no-events' }

  const label = (input.label ?? 'prod').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'prod'
  const id = `dsh-${label}-${hash8(input.task.correlationId ?? input.task.id)}`
  const tracePath = join(input.outDir, `${id}.ndjson`)
  const draftPath = join(input.outDir, `${id}.json`)
  const traceFile = relative(input.root, tracePath).split('\\').join('/')
  if (traceFile.startsWith('..')) return { ok: false, reason: 'outside-root' }

  const attempts = input.attempts ?? []
  const rawFinal = [...attempts].reverse().find((attempt) => typeof attempt.summary === 'string' && attempt.summary !== '')?.summary ?? ''
  const finalText = rawFinal === '' ? '' : scrub(rawFinal)
  // 判据只认 tool_call：tool.result 的 name 在遥测里可能是占位值（如 unknown），
  // 拿它当 requiredTools 会让回放必然失败。
  const tools = events.flatMap((row) => (
    row.event === 'tool.call' && row.tool?.name != null && row.tool.name !== 'unknown'
      ? [row.tool.name]
      : []
  ))

  if (input.onExists === 'refuse' && (existsSync(tracePath) || existsSync(draftPath))) {
    return { ok: false, reason: 'exists', display: traceFile }
  }

  const lines = buildExportLines(events, input.task.correlationId ?? input.task.id, finalText)
  const draft = buildDraftTask({
    id,
    task: input.task,
    tools,
    finalText,
    traceFile,
  })

  if (input.dryRun !== true) {
    mkdirSync(input.outDir, { recursive: true })
    writeFileSync(tracePath, `${lines.join('\n')}\n`)
    writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`)
  }
  return {
    ok: true,
    id,
    taskRef: input.task.taskRef ?? input.task.id,
    tracePath,
    draftPath,
    traceFile,
    display: traceFile,
    lines: lines.length,
    tools: tools.length,
    draft,
  }
}
