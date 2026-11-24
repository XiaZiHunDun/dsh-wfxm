/**
 * `/eval` 命令解析（P2-1）。
 *
 * 只解析，不执行：执行与回执在 host 层（读 `eval/latest.json`）。
 * 仅认整词 `/eval`，避免误伤 `/evaluate` 等普通文本。
 */

export type EvalCommand =
  | { kind: 'status' }
  | { kind: 'findings' }
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
    default:
      return {
        kind: 'unsupported',
        detail: `P2-1 仅支持 /eval、/eval findings、/eval help；收到 ${rest.length === 0 ? sub : args}`,
      }
  }
}
