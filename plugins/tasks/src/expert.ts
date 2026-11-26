/**
 * Slice CH (O1): the only explicit expert directive we accept.
 *
 * The front desk never guesses an expert from natural language; a task is
 * routed explicitly only when the message starts with a literal
 * `/expert <name>` command. The name is ASCII (registry keys), the rest is the
 * real intent so risk planning sees the request without the command noise.
 */

export const EXPERT_USAGE = '用法：/expert <专家> <任务内容>'

export interface ExpertDirective {
  /** Explicit expert name, or null when the text is not a directive. */
  expert: string | null
  /** The task body with the command prefix removed (trimmed). */
  intent: string
  /** Name present but no body: the front desk replies with `EXPERT_USAGE`. */
  usage: boolean
}

const BARE = /^\s*\/expert\s*$/i
const WITH_NAME = /^\s*\/expert\s+([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?\s*$/i

export function parseExpertDirective(text: string): ExpertDirective {
  const raw = typeof text === 'string' ? text : ''
  if (BARE.test(raw)) return { expert: null, intent: '', usage: true }
  const match = WITH_NAME.exec(raw)
  if (match === null) return { expert: null, intent: raw, usage: false }
  const intent = (match[2] ?? '').trim()
  return { expert: match[1]!, intent, usage: intent === '' }
}
