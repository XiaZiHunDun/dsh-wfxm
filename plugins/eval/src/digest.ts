/**
 * 测评明细的脱敏摘要（P2-2）。
 *
 * 库里只存 `sha256` 与脱敏后的截断文本：原文可能引用轨迹/日志，
 * 既不可追溯又可能带密钥，所以落库前统一走 `@dsh-wfxm/redact`。
 */

import { createHash } from 'node:crypto'
import { redactText } from '@dsh-wfxm/redact'

const DEFAULT_MAX_CHARS = 200

export function digestText(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  const redacted = redactText(text).value
  const hash = createHash('sha256').update(redacted).digest('hex')
  const flat = redacted.replace(/\s+/g, ' ').trim()
  const summary = flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
  return summary === '' ? `sha256:${hash}` : `sha256:${hash} ${summary}`
}
