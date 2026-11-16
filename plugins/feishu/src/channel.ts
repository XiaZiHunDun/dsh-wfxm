/**
 * Feishu long-connection inbound (docs/14 §三/§七): a WSClient subscribes to
 * `im.message.receive_v1`; each event is normalized (see `normalize.ts`) and
 * handed to the injected `onMessage` sink — the host wires that to ①
 * `ingestInbound` (AR33: this plugin never imports the gateway).
 *
 * Reconnect/backoff is the SDK's built-in `autoReconnect`; we only surface
 * lifecycle events through the logger (metadata only, never content) and fail
 * `start()` loudly when the first connect never becomes ready (AR13).
 */

import {
  normalizeFeishuCardActionEvent,
  normalizeFeishuMessageEvent,
  type NormalizedCardAction,
  type NormalizedInbound,
} from './normalize.js'

// -- narrow SDK seam (satisfied by @larksuiteoapi/node-sdk; injected in tests) ------------

export interface FeishuWsClientLike {
  start(options: { eventDispatcher: unknown }): void
  close(): void
}

export interface FeishuEventDispatcherLike {
  register(handles: Record<string, (event: unknown) => Promise<unknown>>): unknown
}

export interface FeishuWsModule {
  WSClient: new (params: Record<string, unknown>) => FeishuWsClientLike
  EventDispatcher: new (params: Record<string, unknown>) => FeishuEventDispatcherLike
  LoggerLevel: Record<string, number>
  Domain: Record<string, string>
}

export interface FeishuChannelLogger {
  debug?(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

/**
 * What a click should tell the user. Feishu requires the `card.action.trigger`
 * callback to answer within a few seconds, otherwise the client shows an error;
 * a toast is the minimal valid answer (docs/14 §六).
 */
export interface CardActionResult {
  ok: boolean
  /** Toast copy; the channel picks a sensible default when omitted. */
  toast?: string
  /**
   * Card to render as part of the callback answer (`{type:'raw', data}`).
   * Feishu applies it atomically with the click; patching later races with
   * the callback and is silently reverted.
   */
  card?: { type: 'raw'; data: Record<string, unknown> }
}

/** The Feishu card-callback response envelope. */
export interface CardActionResponse {
  toast: {
    type: 'success' | 'error' | 'warning' | 'info'
    content: string
  }
  card?: { type: 'raw'; data: Record<string, unknown> }
}

/** Pure mapping used by the WS handler and by tests (no SDK involvement). */
export function toCardActionResponse(result: void | CardActionResult): CardActionResponse {
  if (result === undefined || result === null || typeof result !== 'object' || !('ok' in result)) {
    return { toast: { type: 'success', content: '已处理' } }
  }
  const response: CardActionResponse = {
    toast: {
      type: result.ok ? 'success' : 'warning',
      content: result.toast ?? (result.ok ? '已处理' : '该操作已处理'),
    },
  }
  if (result.card !== undefined) response.card = result.card
  return response
}

export interface FeishuChannelOptions {
  readonly appId: string
  readonly appSecret: string
  readonly domain?: string
  /** Host sink: ① `ingestInbound`. Throwing inside is caught and logged. */
  readonly onMessage: (message: NormalizedInbound) => void | Promise<void>
  /**
   * Host sink for `card.action.trigger` (docs/14 §二). Without it we do not
   * subscribe at all and say so — a silent button is worse than a warning.
   * Returning a result drives the toast the clicker sees (approve / already
   * handled / failed); returning void yields a neutral "已处理".
   */
  readonly onCardAction?: (
    action: NormalizedCardAction,
  ) => void | CardActionResult | Promise<void | CardActionResult>
  readonly logger?: FeishuChannelLogger
  /** Injectable SDK module; defaults to `import('@larksuiteoapi/node-sdk')`. */
  readonly lark?: FeishuWsModule
  /** `start()` fails when the first ready signal takes longer (default 20s). */
  readonly readyTimeoutMs?: number
  readonly now?: () => Date
}

export interface FeishuChannel {
  /** Resolves once the WS reports ready; throws (loudly) on timeout. */
  start(): Promise<void>
  stop(): Promise<void>
  readonly ready: boolean
}

/**
 * Configs store the domain as an enum name ('feishu' / 'lark') or a full URL
 * (see dsh-im's bot registry); the SDK wants `Domain.Feishu` / `Domain.LarkSuite`.
 */
export function resolveLarkDomain(domain: string | null | undefined, sdkDomain: Record<string, string>): string {
  if (domain === null || domain === undefined || domain === '') return sdkDomain.Feishu!
  const lowered = domain.toLowerCase()
  if (lowered === 'feishu') return sdkDomain.Feishu!
  if (lowered === 'lark' || lowered === 'larksuite') return sdkDomain.LarkSuite!
  if (/^https?:\/\//.test(lowered)) return domain
  throw new Error(`feishu channel: unknown domain "${domain}" (want feishu | lark | https://...)`)
}

export function createFeishuChannel(options: FeishuChannelOptions): FeishuChannel {
  let wsClient: FeishuWsClientLike | null = null
  let isReady = false
  let onReady: (() => void) | null = null
  const logger = options.logger

  const handleEvent = async (event: unknown): Promise<void> => {
    const normalized = normalizeFeishuMessageEvent(event, {
      defaultChannelId: options.appId,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    if (normalized === null) {
      logger?.warn('feishu inbound event dropped (malformed or bot-authored)', {
        hasMessage: typeof event === 'object' && event !== null && 'message' in event,
      })
      return
    }
    try {
      await options.onMessage(normalized)
    } catch (error) {
      // A sink failure must never kill the connection or go silent (AR13);
      // ① has already persisted the row before it can throw (inbox-first).
      logger?.error('feishu onMessage sink failed', {
        msgId: normalized.msgId,
        chatId: normalized.chatId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleCardAction = async (event: unknown): Promise<CardActionResponse> => {
    const normalized = normalizeFeishuCardActionEvent(event, {
      defaultChannelId: options.appId,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    if (normalized === null) {
      logger?.warn('feishu card action dropped (malformed)', {
        hasEvent: typeof event === 'object' && event !== null,
      })
      return { toast: { type: 'warning', content: '无法识别的操作' } }
    }
    const sink = options.onCardAction
    if (sink === undefined) return { toast: { type: 'info', content: '已处理' } }
    try {
      const result = await sink(normalized)
      return toCardActionResponse(result)
    } catch (error) {
      logger?.error('feishu onCardAction sink failed', {
        msgId: normalized.msgId,
        error: error instanceof Error ? error.message : String(error),
      })
      return { toast: { type: 'error', content: '处理失败，请稍后重试' } }
    }
  }

  return {
    get ready() {
      return isReady
    },

    async start() {
      if (wsClient !== null) throw new Error('feishu channel already started')
      const lark = options.lark ?? (await import('@larksuiteoapi/node-sdk')) as unknown as FeishuWsModule
      const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.info })
      const handles: Record<string, (event: unknown) => Promise<unknown>> = {
        'im.message.receive_v1': handleEvent,
      }
      if (options.onCardAction !== undefined) {
        handles['card.action.trigger'] = handleCardAction
      } else {
        logger?.warn('feishu card.action.trigger not subscribed (no onCardAction sink)', {
          appId: options.appId,
        })
      }
      await dispatcher.register(handles)

      const readyPromise = new Promise<void>((resolve) => {
        onReady = resolve
      })
      wsClient = new lark.WSClient({
        appId: options.appId,
        appSecret: options.appSecret,
        domain: resolveLarkDomain(options.domain, lark.Domain),
        loggerLevel: lark.LoggerLevel.info,
        autoReconnect: true,
        onReady: () => {
          isReady = true
          logger?.info('feishu long connection ready', { appId: options.appId })
          onReady?.()
        },
        onError: (error: unknown) => {
          logger?.error('feishu long connection error', {
            appId: options.appId,
            error: error instanceof Error ? error.message : String(error),
          })
        },
        onReconnecting: () => {
          isReady = false
          logger?.warn('feishu long connection reconnecting', { appId: options.appId })
        },
        onReconnected: () => {
          isReady = true
          logger?.info('feishu long connection reconnected', { appId: options.appId })
        },
      })
      wsClient.start({ eventDispatcher: dispatcher })

      const timeoutMs = options.readyTimeoutMs ?? 20_000
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        await Promise.race([
          readyPromise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`feishu long connection not ready within ${timeoutMs}ms`)),
              timeoutMs,
            )
          }),
        ])
      } catch (error) {
        wsClient.close()
        wsClient = null
        throw error
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    },

    async stop() {
      if (wsClient === null) return
      const client = wsClient
      wsClient = null
      isReady = false
      client.close()
    },
  }
}
