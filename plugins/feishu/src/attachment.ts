/**
 * Inbound attachment staging (Slice AS · A8).
 *
 * Normalization is pure and only knows keys (`image_key` / `file_key`); this
 * module downloads each resource through `im.v1.messageResource.get` into
 * `<dir>/<msgId>/<n>-<safe name>` and appends one plain-text line per file to
 * the message body. Keeping the local path in the text means every existing
 * pathway (triage, dedupe, rule foreground, decision prompt, supplements)
 * works unchanged — the executor just reads the file by path.
 *
 * A failed download never drops the message (AR13): the attachment is marked
 * `failed`, the body says so, and the rest of the message is processed.
 */

import { mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { InboundAttachment, Json } from './normalize.js'

/** Narrow seam over the lark resource API; satisfied by `client.im.v1.messageResource`. */
export interface FeishuResourceApi {
  get(input: {
    path: { message_id: string; file_key: string }
    params: { type: 'image' | 'file' }
  }): Promise<{ writeFile(path: string): Promise<void> }>
}

export interface AttachmentStagingOptions {
  /** Root directory; one sub-directory per inbound message id. */
  readonly dir: string
  readonly resource: FeishuResourceApi
  /** File name length cap; defaults to 80 characters. */
  readonly maxNameChars?: number
}

export interface AttachmentLogger {
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface StagedAttachment {
  readonly kind: InboundAttachment['kind']
  readonly key: string
  readonly name: string
  readonly path: string | null
  readonly status: 'staged' | 'failed'
}

const DEFAULT_EXT: Record<InboundAttachment['kind'], string> = {
  image: '.png',
  file: '.bin',
  audio: '.opus',
  video: '.mp4',
}

const DEFAULT_NAME: Record<InboundAttachment['kind'], string> = {
  image: 'image',
  file: 'file',
  audio: 'voice',
  video: 'video',
}

/** Basename only, no control characters, no traversal, bounded length. */
export function safeAttachmentName(
  name: string | null,
  kind: InboundAttachment['kind'],
  index: number,
  maxChars = 80,
): string {
  const base = basename((name ?? '').replace(/[\u0000-\u001f]/g, '').trim())
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  const fallback = `${DEFAULT_NAME[kind]}-${index + 1}`
  const leaf = cleaned === '' ? fallback : cleaned.slice(0, Math.max(1, maxChars))
  // Generic files keep whatever extension they had (a missing one is legal);
  // images/audio/video get one so `read_image`/players can sniff them.
  return extname(leaf) !== '' || kind === 'file' ? leaf : `${leaf}${DEFAULT_EXT[kind]}`
}

/** Message ids are opaque; keep them filesystem-safe and single-level. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'message'
}

function noteOf(item: StagedAttachment, sizeBytes: number | null): string {
  if (item.status === 'failed') return `[附件] ${item.key} 下载失败，请重新发送`
  switch (item.kind) {
    case 'image':
      return `[图片附件] ${item.name}，本地路径：${item.path}（可用 read_image 查看）`
    case 'file':
      return `[文件附件] ${item.name}（${sizeBytes ?? 0} 字节），本地路径：${item.path}`
    case 'audio':
      return `[语音附件] 本地路径：${item.path}（本机未启用语音转写，请补充文字说明要办的事）`
    case 'video':
      return `[视频附件] ${item.name}，本地路径：${item.path}`
  }
}

function attachmentsOf(content: Json): InboundAttachment[] {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return []
  const raw = (content as Record<string, unknown>).attachments
  if (!Array.isArray(raw)) return []
  const parsed: InboundAttachment[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (
      (record.kind === 'image' || record.kind === 'file' || record.kind === 'audio' || record.kind === 'video')
      && typeof record.key === 'string' && record.key !== ''
    ) {
      parsed.push({
        kind: record.kind,
        key: record.key,
        name: typeof record.name === 'string' ? record.name : null,
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : null,
        durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
      })
    }
  }
  return parsed
}

/**
 * Download every attachment and rewrite `content.text` with the local paths.
 * Returns the content unchanged when the message has no attachment metadata.
 */
export async function stageAttachments(input: {
  content: Json
  externalMsgId: string
  options: AttachmentStagingOptions
  logger?: AttachmentLogger | null
}): Promise<Json> {
  const source = attachmentsOf(input.content)
  if (source.length === 0) return input.content
  const content = input.content as Record<string, Json>
  const caption = typeof content.text === 'string' ? content.text.trim() : ''

  const targetDir = join(input.options.dir, safeSegment(input.externalMsgId))
  let dirReady = true
  try {
    mkdirSync(targetDir, { recursive: true })
  } catch (error) {
    dirReady = false
    input.logger?.warn('feishu attachment directory unavailable', {
      msgId: input.externalMsgId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const staged: StagedAttachment[] = []
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index]!
    const name = safeAttachmentName(item.name, item.kind, index, input.options.maxNameChars)
    const path = join(targetDir, `${String(index + 1).padStart(2, '0')}-${name}`)
    if (!dirReady) {
      staged.push({ kind: item.kind, key: item.key, name, path: null, status: 'failed' })
      continue
    }
    try {
      const resource = await input.options.resource.get({
        path: { message_id: input.externalMsgId, file_key: item.key },
        params: { type: item.kind === 'image' ? 'image' : 'file' },
      })
      await resource.writeFile(path)
      staged.push({ kind: item.kind, key: item.key, name, path, status: 'staged' })
    } catch (error) {
      input.logger?.warn('feishu attachment download failed', {
        msgId: input.externalMsgId,
        kind: item.kind,
        error: error instanceof Error ? error.message : String(error),
      })
      staged.push({ kind: item.kind, key: item.key, name, path: null, status: 'failed' })
    }
  }

  const notes = staged.map((item, index) => noteOf(item, source[index]?.sizeBytes ?? null))
  const text = [caption, ...notes].filter((line) => line !== '').join('\n')
  return {
    ...content,
    ...(text === '' ? {} : { text }),
    attachments: staged as unknown as Json,
  }
}
