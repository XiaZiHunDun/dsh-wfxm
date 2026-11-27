/**
 * `/eval` 命令解析（P2-1）。
 *
 * 只解析，不执行：执行与回执在 host 层（读 `eval/latest.json`）。
 * 仅认整词 `/eval`，避免误伤 `/evaluate` 等普通文本。
 */

export type EvalCommand =
  | { kind: 'status' }
  | { kind: 'findings' }
  | { kind: 'run'; mode: 'l2' | 'real' }
  | { kind: 'flag'; reason: string }
  | { kind: 'promote'; ref: string }
  | { kind: 'fix'; ref: string }
  | { kind: 'refresh'; ref: string }
  | { kind: 'ignore'; ref: string }
  | { kind: 'from-task'; ref: string }
  | { kind: 'help' }
  | { kind: 'unsupported'; detail: string }

export function parseEvalCommand(text: string): EvalCommand | null {
  const trimmed = text.trim()
  const match = /^\/(eval)(?:\s+(.+))?$/i.exec(trimmed)
  if (match === null) return null

  const args = (match[2] ?? '').trim()
  if (args === '' || args.toLowerCase() === 'status') return { kind: 'status' }

  const [sub, ...rest] = args.split(/\s+/)
  switch (sub.toLowerCase()) {
    case 'help':
    case '-h':
    case '--help':
      return { kind: 'help' }
    case 'findings':
      return { kind: 'findings' }
    case 'run': {
      const mode = (rest[0] ?? '').toLowerCase()
      if (mode === 'l2') return { kind: 'run', mode: 'l2' }
      if (mode === 'real') return { kind: 'run', mode: 'real' }
      return { kind: 'unsupported', detail: '/eval run 仅支持 l2 或 real' }
    }
    case 'flag': {
      const reason = rest.join(' ').trim()
      return reason === ''
        ? { kind: 'unsupported', detail: '用法：引用一条消息后发送 /eval flag <原因>' }
        : { kind: 'flag', reason }
    }
    case 'promote':
    case 'fix':
    case 'refresh':
    case 'ignore': {
      const ref = (rest[0] ?? '').trim()
      return ref === ''
        ? { kind: 'unsupported', detail: `用法：/eval ${sub.toLowerCase()} <finding-id>` }
        : { kind: sub.toLowerCase() as 'promote' | 'fix' | 'refresh' | 'ignore', ref }
    }
    case 'from-task': {
      const ref = (rest[0] ?? '').trim()
      return ref === ''
        ? { kind: 'unsupported', detail: '用法：/eval from-task <任务号>' }
        : { kind: 'from-task', ref }
    }
    default:
      return {
        kind: 'unsupported',
        detail: `P2-3/P7 支持 /eval、/eval findings、/eval run l2|real、/eval flag、/eval promote、/eval fix、/eval refresh、/eval ignore、/eval from-task、/eval help；收到 ${rest.length === 0 ? sub : args}`,
      }
  }
}
