#!/usr/bin/env node
/**
 * Mint a one-time pairing code (docs/14 §四).
 *
 * Usage:
 *   node plugins/gateway/scripts/pairing-mint.mjs <ops.sqlite> <actorId> [channelId] [ttlMs]
 *
 * Prints the code once, to the owner. Only its sha256 hash is persisted; the
 * code expires (default 5 min) and is consumed by the first `/bind <code>`
 * arriving on the channel (or any channel when channelId is omitted).
 */

import { createGatewayStore } from '../lib/index.js'

const [, , dbPath, actorId, channelId, ttlArg] = process.argv

if (dbPath === undefined || actorId === undefined) {
  console.error('usage: pairing-mint.mjs <ops.sqlite> <actorId> [channelId] [ttlMs]')
  process.exit(2)
}

const store = createGatewayStore(dbPath)
try {
  const minted = store.mintPairingCode({
    actorId,
    ...(channelId === undefined ? {} : { channelId }),
    ...(ttlArg === undefined ? {} : { ttlMs: Number(ttlArg) }),
  })
  console.log(`pairing code (expires ${minted.expiresAt}): ${minted.code}`)
  console.log(`send "/bind ${minted.code}" to the bot to bind this identity to actor ${actorId}`)
} finally {
  store.close()
}
