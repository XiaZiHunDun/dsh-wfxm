/**
 * 启动序列（docs/16 §四）：八步，第一步失败就拒绝启动。
 *
 * 这里只有"顺序 + 失败语义 + 日志 + 单实例锁 + readiness"，业务装配留在
 * `scripts/serve.mjs`。拆出来的原因只有一个：`verify-serve.mjs` 要能逐条把
 * 某一步弄坏，并断言进程**拒绝启动**，而不是检查一个永远为真的常量。
 *
 * 退出码约定（systemd `Restart=on-failure` 会据此重试）：
 *   0  正常停止
 *   1  配置 / 自检失败（重试无意义，需人介入）
 *   3  已有实例在跑（不是故障，不重试）
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const EXIT_STARTUP_FAILED = 1
export const EXIT_ALREADY_RUNNING = 3

export class StartupError extends Error {
  constructor(step, stepName, message, options) {
    super(message, options)
    this.name = 'StartupError'
    this.step = step
    this.stepName = stepName
  }
}

export class AlreadyRunningError extends Error {
  constructor(lockPath, holder) {
    super(
      `another instance is running (pid ${holder?.pid ?? 'unknown'}, lock ${lockPath}); ` +
        'stop it first or remove a stale lock',
    )
    this.name = 'AlreadyRunningError'
    this.lockPath = lockPath
    this.holder = holder
  }
}

/** Steps 2–8 of docs/16 §四 (step 1 is config, validated before they run). */
export const STARTUP_STEPS = Object.freeze([
  'storage',
  'modules',
  'profile',
  'ports',
  'recovery',
  'channel',
  'readiness',
])

/** Core module APIs the composition root cannot start without. */
export const REQUIRED_MODULES = Object.freeze([
  'createMemoryStore',
  'createReminderStore',
  'createSnapshotStore',
  'createApprovalStore',
  'createGrantStore',
  'createWfxmHost',
  'createDshExecutor',
  'createDecisionRunner',
  'createResourceProbe',
])

function fail(step, stepName, message) {
  throw new StartupError(step, stepName, message)
}

function readString(env, key, fallback) {
  const value = env[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function readInt(env, key, fallback, problems, range) {
  const raw = readString(env, key, null)
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) {
    problems.push(`${key} must be an integer (got ${JSON.stringify(raw)})`)
    return fallback
  }
  const value = Number(raw)
  if (value < range[0] || value > range[1]) {
    problems.push(`${key} must be within ${range[0]}..${range[1]} (got ${value})`)
    return fallback
  }
  return value
}

function readEnum(env, key, fallback, allowed, problems) {
  const raw = readString(env, key, null)
  if (raw === null) return fallback
  if (!allowed.includes(raw)) {
    problems.push(`${key} must be one of ${allowed.join('|')} (got ${JSON.stringify(raw)})`)
    return fallback
  }
  return raw
}

/** `0|false|off|no` (any case) turns a flag off; empty/absent keeps the default. */
function readFlag(env, key, fallback) {
  const raw = readString(env, key, null)
  if (raw === null) return fallback
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase())
}

/** Comma-separated minutes (1..1440), deduplicated and ascending (Slice R). */
function readMinuteList(env, key, fallback, problems) {
  const raw = readString(env, key, null)
  if (raw === null) return fallback
  const parts = raw.split(',').map((part) => part.trim())
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) {
    problems.push(`${key} must be comma-separated minutes (got ${JSON.stringify(raw)})`)
    return fallback
  }
  const values = []
  for (const part of parts) {
    const value = Number(part)
    if (value < 1 || value > 1440) {
      problems.push(`${key} minutes must be within 1..1440 (got ${value})`)
      return fallback
    }
    if (!values.includes(value)) values.push(value)
  }
  return values.sort((a, b) => a - b)
}

/**
 * Step 1 of the sequence: parse + validate, never guess a bad value.
 *
 * Paths default under `DSH_WFXM_DATA_DIR` (docs/16 §一) so a local run only
 * needs one override: `DSH_WFXM_DATA_DIR=.wfxm/serve`.
 */
export function parseServeConfig(env = process.env) {
  const problems = []
  const dataDir = resolve(readString(env, 'DSH_WFXM_DATA_DIR', '/var/lib/dsh-wfxm'))
  const config = {
    dataDir,
    dbPath: resolve(readString(env, 'DSH_WFXM_DB', join(dataDir, 'ops.sqlite'))),
    workdir: resolve(readString(env, 'DSH_WFXM_WORKDIR', join(dataDir, 'workspace'))),
    snapshotDir: resolve(readString(env, 'DSH_WFXM_SNAPSHOT_DIR', join(dataDir, 'snapshots'))),
    // Slice AS (A8/A4): inbound attachments and over-long receipts both land
    // under the data directory, never inside the workspace or git.
    attachmentDir: resolve(readString(env, 'DSH_WFXM_ATTACHMENT_DIR', join(dataDir, 'attachments'))),
    outboxFilesDir: resolve(readString(env, 'DSH_WFXM_OUTBOX_FILES', join(dataDir, 'outbox-files'))),
    spillChars: readInt(env, 'DSH_WFXM_SPILL_CHARS', 600, problems, [0, 100_000]),
    readinessPath: resolve(readString(env, 'DSH_WFXM_READINESS', join(dataDir, 'readiness'))),
    lockPath: resolve(readString(env, 'DSH_WFXM_LOCK', join(dataDir, 'serve.lock'))),
    channel: readEnum(env, 'DSH_WFXM_CHANNEL', 'feishu', ['feishu', 'loopback'], problems),
    foreground: readEnum(env, 'DSH_WFXM_FOREGROUND', 'orchestrator', ['orchestrator', 'rule'], problems),
    decideRunner: readEnum(env, 'DSH_WFXM_DECIDE_RUNNER', 'sdk', ['sdk', 'headless'], problems),
    dshBin: readString(env, 'DSH_WFXM_DSH_BIN', 'dsh'),
    // Credentials normally live under `$HOME/.dsh`; the unit sets ProtectHome=yes
    // (docs/16 §三), so production points these at /etc/dsh-wfxm/credentials.
    feishuConfigPath: readString(env, 'DSH_WFXM_FEISHU_CONFIG', null),
    credentialsPath: readString(env, 'DSH_WFXM_CREDENTIALS', null),
    executorTimeoutMs: readInt(env, 'DSH_WFXM_EXECUTOR_TIMEOUT_MS', 600_000, problems, [1_000, 3_600_000]),
    decideTimeoutMs: readInt(env, 'DSH_WFXM_DECIDE_TIMEOUT_MS', 60_000, problems, [1_000, 300_000]),
    workerIntervalMs: readInt(env, 'DSH_WFXM_WORKER_INTERVAL_MS', 1_000, problems, [100, 60_000]),
    pumpIntervalMs: readInt(env, 'DSH_WFXM_PUMP_INTERVAL_MS', 1_000, problems, [100, 60_000]),
    // Slice O: one bounded model turn for the daily conversation digest.
    // Default on; `DSH_WFXM_SEMANTIC_DIGEST=0` keeps the deterministic digest only.
    semanticDigest: readFlag(env, 'DSH_WFXM_SEMANTIC_DIGEST', true),
    // Slice R: long-task notices (2m / 10m milestones, 15m silence by default).
    taskProgress: readFlag(env, 'DSH_WFXM_TASK_PROGRESS', true),
    taskMilestonesMin: readMinuteList(env, 'DSH_WFXM_TASK_MILESTONES', [2, 10], problems),
    taskStallMinutes: readInt(env, 'DSH_WFXM_TASK_STALL_MINUTES', 15, problems, [0, 1440]),
    // Slice AO.1: identical plain-text message in one thread inside this window
    // is ignored instead of being steered into the live task. `0` disables.
    duplicateWindowSeconds: readInt(env, 'DSH_WFXM_DUPLICATE_WINDOW_SECONDS', 60, problems, [0, 3600]),
    // B3 v2: pause a stalled task and kill its child. Default on; `0`/`false`
    // leaves the v1 behaviour (notify only).
    watchdogPause: readFlag(env, 'DSH_WFXM_WATCHDOG_PAUSE', true),
    // Slice U: B4-b worktree isolation. Off by default (15 §10.8); the fields
    // and resolver exist either way, but no worktree is created until enabled.
    worktreeIsolation: readFlag(env, 'DSH_WFXM_WORKTREE_ISOLATION', false),
    // Slice Y: acquire plan-declared resource leases. Off by default; tasks
    // without the flag behave exactly as before.
    resourceLocks: readFlag(env, 'DSH_WFXM_RESOURCE_LOCKS', false),
  }
  // Slice BI (A8): optional OpenAI-compatible ASR. The key is a *file path*
  // (docs/16 §二: secrets never go in env), readable by the service user.
  // Base URL and key file or neither; absent keeps the "转写未启用" note.
  const asrBaseUrl = readString(env, 'DSH_WFXM_ASR_BASE_URL', null)
  const asrKeyFile = readString(env, 'DSH_WFXM_ASR_API_KEY_FILE', null)
  let asrApiKey = null
  if (asrKeyFile !== null) {
    try {
      asrApiKey = readFileSync(asrKeyFile, 'utf8').trim()
      if (asrApiKey === '') problems.push('DSH_WFXM_ASR_API_KEY_FILE is empty')
    } catch (error) {
      problems.push(`DSH_WFXM_ASR_API_KEY_FILE unreadable: ${error.message}`)
    }
  }
  if ((asrBaseUrl === null) !== (asrApiKey === null)) {
    problems.push('DSH_WFXM_ASR_BASE_URL and DSH_WFXM_ASR_API_KEY_FILE must be set together')
  }
  config.asr = asrBaseUrl === null || asrApiKey === null
    ? null
    : {
        baseUrl: asrBaseUrl,
        apiKey: asrApiKey,
        model: readString(env, 'DSH_WFXM_ASR_MODEL', 'whisper-1'),
        language: readString(env, 'DSH_WFXM_ASR_LANGUAGE', 'zh'),
        timeoutMs: readInt(env, 'DSH_WFXM_ASR_TIMEOUT_MS', 30_000, problems, [1_000, 120_000]),
        maxBytes: readInt(env, 'DSH_WFXM_ASR_MAX_BYTES', 10 * 1024 * 1024, problems, [1_024, 100 * 1024 * 1024]),
      }
  if (problems.length > 0) fail(1, 'config', problems.join('; '))
  return config
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still "alive".
    return error?.code === 'EPERM'
  }
}

function readLock(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
    return {
      pid: Number.isInteger(parsed?.pid) ? parsed.pid : null,
      startedAt: typeof parsed?.startedAt === 'string' ? parsed.startedAt : null,
    }
  } catch {
    return null
  }
}

/**
 * Single instance (docs/16 §五): `O_EXCL` create, stale lock reclaimed only
 * when the recorded pid is gone. A live holder is a refusal, never a takeover.
 */
export function acquireInstanceLock(lockPath, options = {}) {
  const now = options.now ?? (() => new Date())
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: now().toISOString() })}\n`
  mkdirSync(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, payload)
      } finally {
        closeSync(fd)
      }
      return {
        path: lockPath,
        release() {
          rmSync(lockPath, { force: true })
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const holder = readLock(lockPath)
      if (holder !== null && isProcessAlive(holder.pid)) {
        throw new AlreadyRunningError(lockPath, holder)
      }
      // Stale: the recorded process is gone (kill -9, power loss). Reclaim once.
      rmSync(lockPath, { force: true })
    }
  }
  throw new AlreadyRunningError(lockPath, readLock(lockPath))
}

/** Run the plan in order; the first failure is fatal and carries its step. */
export async function runStartup(plan, options = {}) {
  const log = options.logger ?? ((line) => console.log(line))
  const total = options.total ?? plan.length
  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index]
    const id = step.id ?? index + 1
    const startedAt = Date.now()
    try {
      await step.run()
    } catch (error) {
      if (error instanceof StartupError) throw error
      throw new StartupError(
        id,
        step.name,
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
    }
    log(`[startup] ${id}/${total} ${step.name} ok (${Date.now() - startedAt}ms)`)
  }
}

export function writeReadiness(path, payload) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ ...payload, at: new Date().toISOString() })}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function removeReadiness(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    // Best effort: a half-created parent must not block lock release/exit.
  }
}

/**
 * Step 3: every module the host composes must actually be there. dsh silently
 * skips a whole bundle on a peer mismatch (AGENTS.md §3), and a missing module
 * in a release would otherwise surface as a `undefined is not a function` deep
 * inside the first message instead of a refused start.
 */
export function assertModules(modules, required = REQUIRED_MODULES) {
  const missing = required.filter((key) => typeof modules?.[key] !== 'function')
  if (missing.length > 0) {
    fail(3, 'modules', `missing module API: ${missing.join(', ')}`)
  }
  return required.length
}

/**
 * Step 4: the front desk must stay tool-less (AR25 / #11). The overlay, not the
 * model's goodwill, is what guarantees it — so an enabled `tool-*` (or the
 * `plan-mode` plugin, which registers `exit_plan_mode`) refuses the start.
 */
export function assertZeroToolAsset(assetPath) {
  let text
  try {
    text = readFileSync(assetPath, 'utf8')
  } catch (error) {
    fail(4, 'profile', `cannot read ${assetPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const blocks = text
    .split(/^-\s+/m)
    .map((block) => block.split(/^-/m)[0])
    .filter((block) => /(^|\n)\s*id:\s*\S+/.test(block))
  const toolBlocks = blocks.filter((block) => {
    const id = /(^|\n)\s*id:\s*(\S+)/.exec(block)?.[2] ?? ''
    return id.startsWith('tool-') || id === 'plan-mode'
  })
  if (toolBlocks.length === 0) {
    fail(4, 'profile', `no tool entries found in ${assetPath}; the file is not the zero-tool overlay`)
  }
  const offenders = toolBlocks
    .filter((block) => !/(^|\n)\s*disabled:\s*true\s*($|\n)/.test(block))
    .map((block) => /(^|\n)\s*id:\s*(\S+)/.exec(block)?.[2] ?? '?')
  if (offenders.length > 0) {
    fail(4, 'profile', `tools left enabled in ${assetPath}: ${offenders.join(', ')}`)
  }
  return toolBlocks.length
}
