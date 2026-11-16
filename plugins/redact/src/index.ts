/**
 * Outbound redaction (A5 / D19-2).
 *
 * Pure functions, no I/O, no config. The same code is mounted at four exits:
 * pino logs, ④ audit before insert, ① channel outbound, ⑥ memory before write.
 *
 * Mask format keeps a short prefix plus the original length so operators can
 * still tell "what kind of secret and roughly how long" without the value:
 *   `AKIA…[redacted:aws-access-key:20]`
 * Short secrets (length < 12) keep no prefix at all.
 */

export type RedactKind =
  | 'private-key'
  | 'aws-access-key'
  | 'api-key'
  | 'jwt'
  | 'github-token'
  | 'slack-token'
  | 'bearer'
  | 'url-password'
  | 'assigned-secret'

export interface RedactHit {
  kind: RedactKind
  /** Length of the original secret. The value itself is never retained. */
  length: number
}

export interface RedactResult<T> {
  value: T
  hits: RedactHit[]
}

export const REDACT_MARKER = '[redacted:'

const PREFIX_LEN = 4
const MIN_PREFIX_LEN = 12

const PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const GITHUB_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g
const GITHUB_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g
const SLACK_TOKEN = /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g
const API_KEY = /\bsk-[A-Za-z0-9_-]{20,}\b/g
const BEARER = /\bBearer(\s+)([A-Za-z0-9._~+/=-]{10,})/g
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]+)(@)/gi
const ASSIGNED_SECRET =
  /\b([A-Za-z0-9_.-]{0,40}(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?[A-Za-z0-9_.-]{0,20})(["']?)\s*([:=])(\s*)("[^"]*"|'[^']*'|[^\s,;}"']+)/gi

/** Placeholder used while masking so later rules never re-match a mask literal. */
const SENTINEL = /\u0000(\d+)\u0000/g
const SENTINEL_ONLY = /^\u0000\d+\u0000$/
/** An existing mask from an earlier pass; protected up front so redaction is idempotent. */
const EXISTING_MASK = /[A-Za-z0-9_.+/-]{0,8}…\[redacted:[a-z-]+:\d+\]/g

function mask(secret: string, kind: RedactKind, keepPrefix = true): string {
  const prefix = keepPrefix && secret.length >= MIN_PREFIX_LEN ? secret.slice(0, PREFIX_LEN) : ''
  return `${prefix}…${REDACT_MARKER}${kind}:${secret.length}]`
}

function applyAll(input: string, hits: RedactHit[]): string {
  const stash: string[] = []
  const hold = (masked: string): string => {
    stash.push(masked)
    return `\u0000${stash.length - 1}\u0000`
  }
  const keep = (kind: RedactKind, secret: string, keepPrefix = true): string => {
    hits.push({ kind, length: secret.length })
    return hold(mask(secret, kind, keepPrefix))
  }

  let out = input

  // Protect masks from earlier passes (idempotency): a mask literal contains
  // words like `url-password`, which the assigned-secret rule would otherwise eat.
  out = out.replace(EXISTING_MASK, (match) => hold(match))

  // Private key blocks go first: their base64 body would otherwise trip other rules.
  out = out.replace(PRIVATE_KEY, (match) => keep('private-key', match, false))

  out = out.replace(AWS_ACCESS_KEY, (match) => keep('aws-access-key', match))
  out = out.replace(JWT, (match) => keep('jwt', match))
  out = out.replace(GITHUB_TOKEN, (match) => keep('github-token', match))
  out = out.replace(GITHUB_PAT, (match) => keep('github-token', match))
  out = out.replace(SLACK_TOKEN, (match) => keep('slack-token', match))
  out = out.replace(API_KEY, (match) => keep('api-key', match))

  out = out.replace(BEARER, (match, sep: string, token: string) => {
    if (token.includes(REDACT_MARKER) || SENTINEL_ONLY.test(token)) return match
    return `Bearer${sep}${keep('bearer', token)}`
  })

  out = out.replace(URL_PASSWORD, (match, head: string, password: string, tail: string) => {
    if (password.includes(REDACT_MARKER) || SENTINEL_ONLY.test(password)) return match
    return `${head}${keep('url-password', password)}${tail}`
  })

  out = out.replace(
    ASSIGNED_SECRET,
    (
      match,
      name: string,
      keyQuote: string,
      sep: string,
      spaces: string,
      raw: string,
    ) => {
      const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : ''
      const secret = quote === '' ? raw : raw.slice(1, -1)
      if (secret === '' || SENTINEL_ONLY.test(secret)) return match
      return `${name}${keyQuote}${sep}${spaces}${quote}${keep('assigned-secret', secret)}${quote}`
    },
  )

  return out.replace(SENTINEL, (_match, index: string) => stash[Number(index)])
}

/** Redact a single string (message body, command text, log line). */
export function redactText(input: string): RedactResult<string> {
  const hits: RedactHit[] = []
  return { value: applyAll(input, hits), hits }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Redact every string inside a plain object / array, preserving shape and
 * non-string leaves. Cycles are short-circuited, not cloned.
 */
export function redactDeep<T>(input: T): RedactResult<T> {
  const hits: RedactHit[] = []
  const seen = new WeakSet<object>()

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return applyAll(value, hits)
    if (Array.isArray(value)) {
      if (seen.has(value)) return value
      seen.add(value)
      return value.map(walk)
    }
    if (value !== null && typeof value === 'object' && isPlainObject(value)) {
      if (seen.has(value)) return value
      seen.add(value)
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) out[key] = walk(item)
      return out
    }
    return value
  }

  return { value: walk(input) as T, hits }
}

/** Errors carry secrets in `message` / `stack`; log mount points use this. */
export function redactError(error: unknown): RedactResult<{
  name?: string
  message: string
  stack?: string
}> {
  const hits: RedactHit[] = []
  if (!(error instanceof Error)) {
    return { value: { message: applyAll(String(error), hits) }, hits }
  }
  const value: { name?: string; message: string; stack?: string } = {
    name: error.name,
    message: applyAll(error.message, hits),
  }
  if (error.stack !== undefined) value.stack = applyAll(error.stack, hits)
  return { value, hits }
}
