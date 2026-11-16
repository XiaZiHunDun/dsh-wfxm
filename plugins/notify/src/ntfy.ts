import {
  NotifyError,
  type NotifyLevel,
  type NotifyMessage,
  type NotifyPort,
  type NotifyReceipt,
} from './port.js'

export interface NtfyOptions {
  /** Server base URL; defaults to the public service. */
  url?: string
  topic: string
  token?: string
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_URL = 'https://ntfy.sh'
const DEFAULT_TIMEOUT_MS = 10_000

/** ntfy priority: p0 = urgent(5), p1 = default(3). */
const PRIORITY: Record<NotifyLevel, number> = { p0: 5, p1: 3 }

export function createNtfyNotifier(options: NtfyOptions): NotifyPort {
  const base = (options.url ?? DEFAULT_URL).replace(/\/+$/, '')
  const topic = options.topic.trim()
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    transport: 'ntfy',
    async notify(level, message: NotifyMessage): Promise<NotifyReceipt> {
      if (topic === '') {
        throw new NotifyError('not-configured', 'ntfy topic is empty')
      }
      const payload = {
        topic,
        title: message.title,
        message: message.body,
        priority: PRIORITY[level],
        ...message.tags === undefined ? {} : { tags: message.tags },
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (options.token !== undefined && options.token !== '') {
        headers.Authorization = `Bearer ${options.token}`
      }

      let response: Response
      try {
        response = await doFetch(base, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new NotifyError('unavailable', `ntfy request failed: ${reason}`)
      }

      if (!response.ok) {
        throw new NotifyError('upstream', `ntfy returned HTTP ${response.status}`)
      }

      let id = ''
      try {
        const body = await response.json() as { id?: unknown }
        if (typeof body.id === 'string') id = body.id
      } catch {
        // A 2xx without a JSON body is still a successful delivery.
      }
      return { transport: 'ntfy', id, deliveredAt: new Date().toISOString() }
    },
  }
}

/**
 * Build the notifier from deployment env. No topic means "delivery disabled",
 * which is the default on a machine that has not configured an endpoint.
 */
export function createNtfyFromEnv(env: NodeJS.ProcessEnv = process.env): NotifyPort | undefined {
  const topic = env.DSH_WFXM_NTFY_TOPIC?.trim()
  if (topic === undefined || topic === '') return undefined
  return createNtfyNotifier({
    topic,
    ...env.DSH_WFXM_NTFY_URL === undefined ? {} : { url: env.DSH_WFXM_NTFY_URL },
    ...env.DSH_WFXM_NTFY_TOKEN === undefined ? {} : { token: env.DSH_WFXM_NTFY_TOKEN },
  })
}
