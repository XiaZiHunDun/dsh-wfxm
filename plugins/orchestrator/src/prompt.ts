/**
 * Prompt for the front-desk decision run (docs/17 §二 `orchestrator`).
 *
 * The model sees one message plus the *minimum* context needed to classify it:
 * the project name (already resolved by ①) and the live task on this thread.
 * It never sees tools, history or the repository — the front stage decides what
 * a turn is, nothing else (AR25 / #11).
 *
 * The output contract lives here and is validated by `decision.ts`; the model
 * never gets to invent a new shape.
 */

export interface ConversationTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface DecisionContextInput {
  /** Plain text body of the inbound message. */
  text: string
  /** Project resolved by ① for this chat, if any. */
  projectName?: string | null
  /** Live task subscribed on the same thread (status in ⑤'s live set). */
  liveTask?: { id: string; status: string; intent: string } | null
  /**
   * Recent turns of this thread, oldest first (① `threadHistory`). This is what
   * makes a follow-up ("那它现在呢？", "改成只统计 /var") decidable; it is not
   * the full transcript, only the last few clipped turns.
   */
  history?: readonly ConversationTurn[]
}

const MAX_CONTEXT_INTENT = 120
const MAX_HISTORY_TURNS = 8
const MAX_HISTORY_CHARS = 220

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

export function buildDecisionPrompt(context: DecisionContextInput): string {
  const project = context.projectName === null || context.projectName === undefined || context.projectName.trim() === ''
    ? '（无）'
    : clip(context.projectName, 60)
  const live = context.liveTask === null || context.liveTask === undefined
    ? '（无）'
    : `${context.liveTask.status} / ${clip(context.liveTask.intent, MAX_CONTEXT_INTENT)}`
  const history = (context.history ?? [])
    .filter((turn) => turn.text.trim() !== '')
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${clip(turn.text, MAX_HISTORY_CHARS)}`)

  return [
    '你是个人运维助手的前台。你只做一件事：判断这条消息该怎么处理。你不执行任何工作，不编造任何结果。',
    '',
    `项目：${project}`,
    `同线程进行中的任务：${live}`,
    ...history.length === 0 ? [] : ['', '最近对话（旧→新）：', ...history],
    '',
    '消息：',
    '"""',
    context.text.trim(),
    '"""',
    '',
    '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。三选一：',
    '{"action":"reply","text":"给用户看的话"}',
    '{"action":"task","intent":"交给执行者的一句话任务","risk":"R0"}',
    '{"action":"queue","text":"补充给进行中任务的指令"}',
    '',
    '规则：',
    '1. 寒暄、致谢、澄清、追问，或仅凭上文就能回答 → reply。',
    '2. 需要真实世界的数据或任何副作用（查状态、读文件、改动、上网、定时） → task，不要自己回答。',
    '3. 只有当上面列了进行中的任务、且这条消息是对它的补充或修正 → queue，不要另开任务。',
    '4. 不确定用户要做什么 → 用 reply 问一句，不要猜。',
    '5. risk 只有 R0（纯只读查询）和 R1（默认）；不要输出 R2 或 R3。',
    '6. text / intent 用用户的语言，简短、可直接展示给用户。',
    '7. 指代（「它」「刚才那个」「那个服务」）优先从「最近对话」解析；仍不清楚就问，不要猜。',
    // Slice AS (A8): attachment lines carry local paths; dropping them in the
    // summary would leave the executor without the file.
    '8. 消息里带「本地路径：<path>」的附件行时，intent 必须原样保留这些路径（含文件名），不要改写、不要省略。',
    '9. 只有附件、没有文字要求时，intent 写「查看/处理附件 <path>」，不要猜测用户意图。',
  ].join('\n')
}
