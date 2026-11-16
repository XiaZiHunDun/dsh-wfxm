#!/usr/bin/env node
/**
 * Real Feishu long-connection smoke (manual; NOT part of verify).
 *
 *   node plugins/feishu/scripts/feishu-smoke.mjs
 *
 * Resolves the bot credential from ~/.dsh/integrations/dsh-feishu/config.json +
 * ~/.dsh/.credentials.yaml, connects, waits up to 30s for one real message,
 * replies "pong" through the transport, then exits. Logs metadata only.
 */

import { randomUUID } from 'node:crypto'
import {
  createFeishuChannel,
  createFeishuTransport,
  createLarkClient,
  loadFeishuCredentials,
} from '../lib/index.js'

const logger = {
  info: (message, meta) => console.log(`[info] ${message}`, meta ?? ''),
  warn: (message, meta) => console.log(`[warn] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[error] ${message}`, meta ?? ''),
}

const credentials = loadFeishuCredentials()
logger.info('credentials resolved', { appId: credentials.appId, domain: credentials.domain ?? 'default' })

const client = await createLarkClient(credentials)
const transport = createFeishuTransport({ client, logger })

let replied = false
const channel = createFeishuChannel({
  appId: credentials.appId,
  appSecret: credentials.appSecret,
  ...(credentials.domain === null ? {} : { domain: credentials.domain }),
  logger,
  onMessage: async (message) => {
    logger.info('inbound message', {
      msgId: message.msgId,
      chatId: message.chatId,
      messageType: message.messageType,
      replyTo: message.replyToMsgId,
    })
    if (replied) return
    replied = true
    const ack = await transport.send({
      id: randomUUID(),
      topic: 'say',
      payload: { text: 'pong (dsh-wfxm feishu smoke)' },
      attempts: 1,
      taskId: null,
      threadId: null,
      replyToMsgId: message.externalMsgId,
    })
    logger.info('reply sent', { externalMsgId: ack.externalMsgId })
  },
  logger,
})

await channel.start()
logger.info('ready — send the bot a message within 30s')

await new Promise((resolve) => setTimeout(resolve, 30_000))
await channel.stop()
logger.info('done', { replied })
process.exit(0)
