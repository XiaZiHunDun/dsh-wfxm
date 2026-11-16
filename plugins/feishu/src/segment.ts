/**
 * Text segmentation for outbound Feishu messages (docs/14 §五): the channel
 * side splits conservatively at `limit` characters, preferring a newline
 * boundary and never splitting a surrogate pair.
 */

export const FEISHU_TEXT_SEGMENT_LIMIT = 4000

export function segmentText(text: string, limit: number = FEISHU_TEXT_SEGMENT_LIMIT): string[] {
  if (limit <= 0) throw new RangeError('segment limit must be positive')
  if (text.length <= limit) return [text]
  const segments: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    // Never split a surrogate pair.
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
    if (cut <= 0) cut = limit // degenerate: a lone leading surrogate
    segments.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) segments.push(rest)
  return segments
}
