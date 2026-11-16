/**
 * dsh plugin seam (docs/14 §八 profile): this bundle is a *transport* plugin —
 * it registers no tools, creates no sessions and no approvals. The real wiring
 * (`onMessage` → ① `ingestInbound`, transport → ① dispatcher) is host
 * composition; `createFeishuRuntime` is the factory the composition root uses.
 */

import { createFeishuChannel, type CardActionResult, type FeishuChannel, type FeishuChannelLogger } from './channel.js'
import { loadFeishuCredentials, type FeishuCredentials } from './credentials.js'
import type { NormalizedCardAction, NormalizedInbound } from './normalize.js'
import { createFeishuTransport, createLarkClient, type TransportShape } from './transport.js'

export const name = 'dsh-wfxm-feishu'
export const inject: readonly string[] = []

export interface FeishuRuntimeOptions {
  readonly credentials: FeishuCredentials
  /** Host sink: ① `ingestInbound` — required; a missing sink refuses to start. */
  readonly onMessage: (message: NormalizedInbound) => void | Promise<void>
  /** Host sink for `card.action.trigger` (approval buttons); optional. */
  readonly onCardAction?: (
    action: NormalizedCardAction,
  ) => void | CardActionResult | Promise<void | CardActionResult>
  /** Host-composed thread → chat lookup (① `threads` row), optional. */
  readonly resolveChatId?: (threadId: string) => string | null | Promise<string | null>
  readonly logger?: FeishuChannelLogger
}

export interface FeishuRuntime {
  readonly channel: FeishuChannel
  readonly transport: TransportShape
}

export async function createFeishuRuntime(options: FeishuRuntimeOptions): Promise<FeishuRuntime> {
  const client = await createLarkClient({
    appId: options.credentials.appId,
    appSecret: options.credentials.appSecret,
    ...(options.credentials.domain === null ? {} : { domain: options.credentials.domain }),
  })
  return {
    channel: createFeishuChannel({
      appId: options.credentials.appId,
      appSecret: options.credentials.appSecret,
      ...(options.credentials.domain === null ? {} : { domain: options.credentials.domain }),
      onMessage: options.onMessage,
      ...(options.onCardAction === undefined ? {} : { onCardAction: options.onCardAction }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    transport: createFeishuTransport({
      client,
      ...(options.resolveChatId === undefined ? {} : { resolveChatId: options.resolveChatId }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
  }
}

interface PluginContext {
  logger?: {
    info(message: string): void
    warn(message: string): void
  }
}

/**
 * Mount hook. The composition root that owns the ① store is not built yet in
 * this slice, so mounting only verifies the bundle shape; starting the channel
 * without an ingest sink would drop messages silently (AR13), which is why
 * `apply` refuses to start anything on its own.
 */
export function apply(ctx: PluginContext): void {
  ctx.logger?.info(`${name}: loaded (transport profile; channel/transport wiring is host composition)`)
}
