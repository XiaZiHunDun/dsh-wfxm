/**
 * A8 voice transcription — OpenAI-compatible `/audio/transcriptions` client.
 *
 * Scope: turn a Feishu audio attachment into text *before* it reaches the
 * gateway. The provider is deliberately generic (OpenAI, Groq, SiliconFlow,
 * a local whisper server, …) so no vendor SDK or credential shape leaks into
 * the channel. If no endpoint/key is configured the caller keeps today's
 * "转写未启用" note (fail soft, AR13).
 *
 * Security: the audio bytes only go to the configured endpoint; errors carry
 * status + a short body excerpt, never the API key or file contents.
 */

import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AudioTranscriptInput {
  /** Local staged file path. */
  readonly path: string
  /** Original attachment name (used for the upload filename only). */
  readonly name: string
  readonly durationMs?: number | null
}

export interface AudioTranscript {
  readonly text: string
}

export type AudioTranscriber = (input: AudioTranscriptInput) => Promise<AudioTranscript>

export interface OpenAiTranscriberOptions {
  /** Base URL including `/v1`, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string
  readonly apiKey: string
  readonly model?: string
  readonly language?: string
  readonly timeoutMs?: number
  readonly maxBytes?: number
  /** Test seam; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_MODEL = 'whisper-1'
const DEFAULT_LANGUAGE = 'zh'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

const MIME: Record<string, string> = {
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
}

function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** ASCII-only upload filename; the MIME part carries the real type. */
function uploadName(path: string): string {
  const ext = extname(path).toLowerCase().replace(/[^a-z0-9.]/g, '')
  return `audio${ext === '' ? '.bin' : ext}`
}

function multipartBody(
  fields: Record<string, string>,
  file: { name: string; mime: string; bytes: Buffer },
  boundary: string,
): Buffer {
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ))
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
    + `Content-Type: ${file.mime}\r\n\r\n`,
  ))
  chunks.push(file.bytes)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

/**
 * Create a transcriber bound to one endpoint. Throws only for programmer
 * errors (empty baseUrl/key); runtime/network errors reject per call so the
 * channel can mark a single attachment as failed.
 */
export function createOpenAiTranscriber(options: OpenAiTranscriberOptions): AudioTranscriber {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '')
  const apiKey = options.apiKey.trim()
  if (baseUrl === '' || apiKey === '') {
    throw new Error('ASR baseUrl/apiKey 不能为空')
  }
  const model = options.model?.trim() || DEFAULT_MODEL
  const language = options.language?.trim() || DEFAULT_LANGUAGE
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const fetchImpl = options.fetchImpl ?? fetch

  return async (input) => {
    const size = statSync(input.path).size
    if (size > maxBytes) {
      throw new Error(`语音文件 ${size} 字节，超过上限 ${maxBytes}`)
    }
    const bytes = readFileSync(input.path)
    const boundary = `----dshwfxm-${randomUUID().replace(/-/g, '')}`
    const body = multipartBody(
      { model, language, response_format: 'json' },
      { name: uploadName(input.path), mime: mimeOf(input.path), bytes },
      boundary,
    )
    const response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`ASR ${response.status}: ${text.slice(0, 200)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('ASR 响应不是 JSON')
    }
    if (
      typeof parsed !== 'object' || parsed === null
      || typeof (parsed as Record<string, unknown>).text !== 'string'
    ) {
      throw new Error('ASR 响应缺少 text')
    }
    return { text: (parsed as { text: string }).text.trim() }
  }
}
