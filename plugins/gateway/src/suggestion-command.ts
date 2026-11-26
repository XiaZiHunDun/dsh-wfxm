/**
 * P7-3：日报建议的采纳/忽略命令。
 *
 * 只认整句 `做 #ref` / `忽略 #ref`（ref 为稳定 id、唯一前缀或最新日报序号），
 * 避免把普通对话里的“做…”误判成命令。
 */

export type SuggestionCommand = {
  kind: 'accept' | 'ignore'
  ref: string
}

const ACCEPT_RE = /^(?:做|采纳|执行)\s*#\s*([A-Za-z0-9_-]+)$/i
const IGNORE_RE = /^(?:忽略|不做|跳过)\s*#\s*([A-Za-z0-9_-]+)$/i

export function parseSuggestionCommand(text: string): SuggestionCommand | null {
  const trimmed = text.trim()
  const accept = ACCEPT_RE.exec(trimmed)
  if (accept !== null) return { kind: 'accept', ref: accept[1] }
  const ignore = IGNORE_RE.exec(trimmed)
  if (ignore !== null) return { kind: 'ignore', ref: ignore[1] }
  return null
}
