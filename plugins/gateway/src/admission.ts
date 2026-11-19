/**
 * H2 入站准入（渠道级，先于任何路由/模型）。
 *
 * 这里只做三件确定性的事，全部在内存里完成，不碰存储、不调模型：
 * - 渠道 allowlist（未配置 = 全部放行，保持向后兼容）
 * - 每个主体的固定窗口限流（actor 或未配对的外部身份）
 * - 单条消息内容上限
 *
 * 拒绝不抛错：① 会照常落下 inbox 行与 route_decision（audit），再静默返回。
 */

export type AdmissionRejectCode = 'channel-not-allowed' | 'rate-limited' | 'content-too-large'

export interface AdmissionDecision {
  admit: boolean
  code?: AdmissionRejectCode
  reason?: string
}

export interface AdmissionCheckInput {
  channelId: string
  /** actorId when paired, otherwise the channel identity; never empty. */
  subject: string
  content: unknown
  now?: Date
}

export interface AdmissionPort {
  check(input: AdmissionCheckInput): AdmissionDecision
}

export interface AdmissionPolicy {
  /** Empty / omitted = every channel is allowed. */
  allowedChannels?: readonly string[]
  /** Omitted / null = no rate limit. */
  rateLimit?: { max: number; windowMs: number } | null
  /** JSON byte-ish length cap for one inbound payload; defaults to 64 KiB. */
  maxContentChars?: number
}

export const DEFAULT_MAX_CONTENT_CHARS = 65_536

const ALLOW: AdmissionDecision = { admit: true }

export interface AdmissionOptions {
  now?: () => Date
  /** Bound the limiter map in long-running processes; defaults to 10k subjects. */
  maxSubjects?: number
}

/**
 * Parse `DSH_WFXM_ADMISSION_*` from the environment. Invalid values throw:
 * admission is a gate, so a typo must fail the service at boot, not fail open.
 */
export function parseAdmissionEnv(env: Record<string, string | undefined>): AdmissionPolicy {
  const channelsRaw = env.DSH_WFXM_ADMISSION_CHANNELS?.trim()
  const allowedChannels = channelsRaw === undefined || channelsRaw === ''
    ? undefined
    : channelsRaw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)

  const rateRaw = env.DSH_WFXM_ADMISSION_RATE?.trim()
  let rateLimit: AdmissionPolicy['rateLimit']
  if (rateRaw !== undefined && rateRaw !== '') {
    const match = /^(\d+)\/(\d+)$/.exec(rateRaw)
    if (match === null) {
      throw new Error(`DSH_WFXM_ADMISSION_RATE must look like "30/60000", got: ${rateRaw}`)
    }
    const max = Number(match[1])
    const windowMs = Number(match[2])
    if (!Number.isInteger(max) || max < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error(`DSH_WFXM_ADMISSION_RATE must be positive integers, got: ${rateRaw}`)
    }
    rateLimit = { max, windowMs }
  }

  const maxRaw = env.DSH_WFXM_ADMISSION_MAX_CHARS?.trim()
  let maxContentChars: number | undefined
  if (maxRaw !== undefined && maxRaw !== '') {
    const parsed = Number(maxRaw)
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`DSH_WFXM_ADMISSION_MAX_CHARS must be a positive integer, got: ${maxRaw}`)
    }
    maxContentChars = parsed
  }

  return {
    ...allowedChannels === undefined ? {} : { allowedChannels },
    ...rateLimit === undefined ? {} : { rateLimit },
    ...maxContentChars === undefined ? {} : { maxContentChars },
  }
}

export function createAdmission(policy: AdmissionPolicy, options: AdmissionOptions = {}): AdmissionPort {
  const now = options.now ?? (() => new Date())
  const maxSubjects = options.maxSubjects ?? 10_000
  const allowed = policy.allowedChannels === undefined || policy.allowedChannels.length === 0
    ? null
    : new Set(policy.allowedChannels)
  const rate = policy.rateLimit ?? null
  const maxChars = policy.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS
  const buckets = new Map<string, number[]>()

  function measure(content: unknown): number {
    try {
      const serialized = JSON.stringify(content)
      return serialized === undefined ? 0 : serialized.length
    } catch {
      // Non-serializable content is a caller bug; treat it as oversized so the
      // gate stays closed rather than crashing ingest.
      return Number.POSITIVE_INFINITY
    }
  }

  function prune(at: number): void {
    if (buckets.size <= maxSubjects) return
    for (const [key, stamps] of buckets) {
      if (stamps.length === 0 || at - stamps[stamps.length - 1]! >= (rate?.windowMs ?? 1)) {
        buckets.delete(key)
      }
      if (buckets.size <= maxSubjects) return
    }
  }

  return {
    check(input) {
      if (allowed !== null && !allowed.has(input.channelId)) {
        return {
          admit: false,
          code: 'channel-not-allowed',
          reason: `channel "${input.channelId}" is not in the admission allowlist`,
        }
      }

      const size = measure(input.content)
      if (size > maxChars) {
        return {
          admit: false,
          code: 'content-too-large',
          reason: `inbound content is ${size} chars, over the ${maxChars} limit`,
        }
      }

      if (rate === null) return ALLOW

      const at = (input.now ?? now()).getTime()
      const key = `${input.channelId}:${input.subject}`
      const stamps = (buckets.get(key) ?? []).filter((stamp) => at - stamp < rate.windowMs)
      if (stamps.length >= rate.max) {
        buckets.set(key, stamps)
        return {
          admit: false,
          code: 'rate-limited',
          reason: `more than ${rate.max} inbound messages per ${rate.windowMs}ms from ${input.subject}`,
        }
      }
      stamps.push(at)
      buckets.set(key, stamps)
      prune(at)
      return ALLOW
    },
  }
}
