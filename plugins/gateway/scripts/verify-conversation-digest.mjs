/**
 * Conversation digest (gateway/digest.ts): counts only, grouped by thread,
 * no message body, no model. The daily patrol owns delivery; this script only
 * proves the pure summary.
 */

import assert from 'node:assert/strict'

const { summarizeConversationDigest } = await import('../lib/index.js')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`PASS  ${name}`)
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Local 10:00 on 11-11 (Asia/Shanghai), window = the previous 24h.
const to = new Date('2026-11-11T02:00:00.000Z')
const from = new Date(to.getTime() - 24 * 3_600_000)
const window = { from, to }

function message(overrides) {
  return {
    threadId: 'thr_1',
    chatId: 'oc_123456',
    kind: 'message',
    status: 'done',
    receivedAt: '2026-11-11T01:00:00.000Z',
    ...overrides,
  }
}

check('empty window returns null', () => {
  const digest = summarizeConversationDigest({ threads: [], messages: [], tasks: [], window })
  assert.equal(digest, null)
})

check('one conversation: header counts and the per-thread bullet', () => {
  const digest = summarizeConversationDigest({
    threads: [{ threadId: 'thr_1', chatId: 'oc_123456', kind: 'root', topicId: null }],
    messages: [message(), message({ receivedAt: '2026-11-11T01:30:00.000Z' })],
    tasks: [{ taskId: 'task_1', threadId: 'thr_1', createdAt: '2026-11-11T01:05:00.000Z' }],
    window,
  })
  assert.equal(digest.conversations, 1)
  assert.equal(digest.messages, 2)
  assert.equal(digest.tasks, 1)
  assert.equal(digest.text.split('\n')[0], '会话日报 11-11：会话 1 · 消息 2 · 新任务 1')
  assert.match(digest.lines[0], /^· 会话 123456 · 消息 2 · 新任务 1 · 最后 \d{2}:\d{2}$/)
})

check('a topic thread is labelled by its topic id', () => {
  const digest = summarizeConversationDigest({
    threads: [{ threadId: 'thr_topic', chatId: 'oc_123456', kind: 'topic', topicId: 'omt_topic1' }],
    messages: [message({ threadId: 'thr_topic' })],
    tasks: [],
    window,
  })
  assert.match(digest.lines[0], /^· 话题 topic1 · 消息 1 · 最后 /)
})

check('messages without a thread id fall back to the chat id', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [message({ threadId: null, chatId: 'oc_abcdef' })],
    tasks: [],
    window,
  })
  assert.equal(digest.conversations, 1)
  assert.match(digest.lines[0], /^· 会话 abcdef · 消息 1/)
})

check('task intents become the conversation subject, capped at three', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [message()],
    tasks: ['a', 'b', 'c', 'd'].map((id, index) => ({
      taskId: `task_${id}`,
      threadId: 'thr_1',
      createdAt: `2026-11-11T01:0${index}:00.000Z`,
      intent: `任务${id}`,
    })),
    window,
  })
  assert.match(digest.lines[0], /新任务 4：任务a；任务b；任务c/)
  assert.doesNotMatch(digest.lines[0], /任务d/)
})

check('a long intent is flattened and truncated', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [message()],
    tasks: [{
      taskId: 'task_long',
      threadId: 'thr_1',
      createdAt: '2026-11-11T01:00:00.000Z',
      intent: `第一行\n${'很长的意图'.repeat(10)}`,
    }],
    window,
  })
  assert.match(digest.lines[0], /新任务 1：第一行 很长的意图/)
  assert.match(digest.lines[0], /…/)
})

check('two threads in one chat are disambiguated by the thread suffix', () => {
  const digest = summarizeConversationDigest({
    threads: [{ threadId: 'thr_1', chatId: 'oc_123456', kind: 'root', topicId: null }],
    messages: [message(), message({ threadId: null })],
    tasks: [],
    window,
  })
  assert.equal(digest.conversations, 2)
  const labels = digest.lines.map((line) => line.split(' · ')[0])
  assert.equal(labels.length, 2)
  assert.notEqual(labels[0], labels[1])
  assert.ok(labels.some((label) => label.includes('/')))
})

check('card actions and control rows are not conversation messages', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [
      message(),
      message({ kind: 'card_action', status: 'done' }),
      message({ kind: 'control', status: 'done' }),
    ],
    tasks: [],
    window,
  })
  assert.equal(digest.messages, 1)
})

check('failed messages are called out beside the count', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [message(), message({ status: 'failed' })],
    tasks: [],
    window,
  })
  assert.equal(digest.messages, 2)
  assert.match(digest.lines[0], /消息 2（失败 1）/)
})

check('a task outside the window is ignored and a task counts once per thread', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [message()],
    tasks: [
      { taskId: 'task_1', threadId: 'thr_1', createdAt: '2026-11-10T23:00:00.000Z' },
      { taskId: 'task_1', threadId: 'thr_1', createdAt: '2026-11-10T23:00:00.000Z' },
      { taskId: 'task_old', threadId: 'thr_1', createdAt: '2026-11-09T23:00:00.000Z' },
    ],
    window,
  })
  assert.equal(digest.tasks, 1)
  assert.match(digest.lines[0], /新任务 1/)
})

check('a thread with a new task but no message still appears', () => {
  const digest = summarizeConversationDigest({
    threads: [{ threadId: 'thr_1', chatId: 'oc_123456', kind: 'root', topicId: null }],
    messages: [],
    tasks: [{ taskId: 'task_1', threadId: 'thr_1', createdAt: '2026-11-11T01:00:00.000Z' }],
    window,
  })
  assert.equal(digest.messages, 0)
  assert.equal(digest.text.split('\n')[0], '会话日报 11-11：会话 1 · 消息 0 · 新任务 1')
  assert.match(digest.lines[0], /^· 会话 123456 · 消息 0 · 新任务 1/)
})

check('future messages and tasks are dropped', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [message({ receivedAt: '2026-11-11T02:00:00.001Z' })],
    tasks: [{ taskId: 'task_1', threadId: 'thr_1', createdAt: '2026-11-11T03:00:00.000Z' }],
    window,
  })
  assert.equal(digest, null)
})

check('window bounds are inclusive on both ends', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [
      message({ receivedAt: from.toISOString() }),
      message({ receivedAt: to.toISOString() }),
    ],
    tasks: [],
    window,
  })
  assert.equal(digest.messages, 2)
})

check('rows without a thread or chat id are not a conversation', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [message({ threadId: null, chatId: null })],
    tasks: [],
    window,
  })
  assert.equal(digest, null)
})

check('maxLines keeps the most recently active conversations', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [
      message({ threadId: 'thr_old', chatId: 'oc_old001', receivedAt: '2026-11-10T10:00:00.000Z' }),
      message({ threadId: 'thr_new', chatId: 'oc_new002', receivedAt: '2026-11-11T01:00:00.000Z' }),
    ],
    tasks: [],
    window: { ...window, maxLines: 1 },
  })
  assert.equal(digest.conversations, 2)
  assert.equal(digest.lines.length, 1)
  assert.match(digest.lines[0], /new002/)
})

check('maxLines 0 keeps the header only', () => {
  const digest = summarizeConversationDigest({
    threads: [],
    messages: [message()],
    tasks: [],
    window: { ...window, maxLines: 0 },
  })
  assert.equal(digest.lines.length, 0)
  assert.equal(digest.text, '会话日报 11-11：会话 1 · 消息 1')
})

check('a custom title replaces the daily header without changing counts', () => {
  const digest = summarizeConversationDigest({
    threads: [{ threadId: 'thr_1', chatId: 'oc_123456', kind: 'root', topicId: null }],
    messages: [message()],
    tasks: [],
    window: { ...window, title: '会话（近 7 天）' },
  })
  assert.equal(digest.text.split('\n')[0], '会话（近 7 天）：会话 1 · 消息 1')
  assert.doesNotMatch(digest.text, /会话日报/)
})

console.log(`\nconversation-digest: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
