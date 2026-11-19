/**
 * Production entry (docs/16): one long-running process, no browser, no human.
 *
 *   node scripts/serve.mjs            # start (Feishu long connection + worker + outbox)
 *   node scripts/serve.mjs --check    # run all eight startup steps, then exit 0
 *
 * Composition only — the same modules the dev harnesses use, wired once:
 *   ① ingest → orchestrator foreground → ⑤ worker → executor → Verifier
 *   → receipt → ① outbox → Feishu transport → chat
 *
 * Environment (all optional outside systemd):
 *   DSH_WFXM_DATA_DIR   default /var/lib/dsh-wfxm
 *   DSH_WFXM_DB / _WORKDIR / _SNAPSHOT_DIR / _READINESS / _LOCK
 *   DSH_WFXM_CHANNEL    feishu | loopback (drills only; loopback has no inbound)
 *   DSH_WFXM_FOREGROUND orchestrator | rule        (default orchestrator)
 *   DSH_WFXM_DECIDE_RUNNER sdk | headless, DSH_WFXM_DECIDE_TIMEOUT_MS
 *   DSH_WFXM_DSH_BIN    default dsh
 *   DSH_WFXM_FEISHU_CONFIG / _CREDENTIALS  default $HOME/.dsh paths
 *
 * Exit codes: 0 normal stop, 1 startup/self-check failure, 3 already running.
 */

import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createDshExecutor } from '@dsh-wfxm/executor'
import { createChangeStore } from '@dsh-wfxm/changes'
import {
  buildApprovalConfirmCard,
  buildApprovalResultCard,
  createFeishuChannel,
  createFeishuTransport,
  createLarkClient,
  createOpenAiTranscriber,
  loadFeishuCredentials,
} from '@dsh-wfxm/feishu'
import { createApprovalStore, createGrantStore, loadPolicy } from '@dsh-wfxm/governance'
import {
  createAdmission,
  inboundText,
  parseAdmissionEnv,
  redactedText,
  summarizeConversationDigest,
} from '@dsh-wfxm/gateway'
import { createWfxmHost, createRuleForeground } from '@dsh-wfxm/host'
import { parseDigestEnv } from '@dsh-wfxm/mail'
import { createMemoryStore, createProjectLookupPort } from '@dsh-wfxm/knowledge'
import { createReminderPort, createReminderStore } from '@dsh-wfxm/reminder'
import {
  createDecisionRunner,
  createOrchestratorForeground,
  summarizeConversationSemantics,
} from '@dsh-wfxm/orchestrator'
import {
  createPreimageRollbackPort,
  createSnapshotPort,
  createSnapshotStore,
  restoreWorkspace,
} from '@dsh-wfxm/snapshot'
import {
  createInspectionPatrol,
  createResourceProbe,
  createSystemdAdapter,
  probeListeningPorts,
  probeLogErrors,
  readInspectionConfig,
  readPatrolConfig,
  spawnRunner,
} from '@dsh-wfxm/svcops'
import { createIsolationResolver, summarizeTaskDigest } from '@dsh-wfxm/tasks'
import {
  AlreadyRunningError,
  EXIT_ALREADY_RUNNING,
  EXIT_STARTUP_FAILED,
  StartupError,
  acquireInstanceLock,
  assertModules,
  assertZeroToolAsset,
  parseServeConfig,
  removeReadiness,
  runStartup,
  writeReadiness,
} from './lib/startup.mjs'

// better-sqlite3 / dsh both break when Trae injects an old libstdc++ path.
delete process.env.LD_LIBRARY_PATH

const checkOnly = process.argv.includes('--check')

function log(step, detail) {
  const text = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`[${new Date().toISOString()}] ${step}${text}`)
}

/**
 * `systemctl show -p ActiveEnterTimestamp` prints `Fri 2026-11-13 16:41:14 CST`.
 * systemd 249 has no `--timestamp=unix`, so strip the weekday/zone and parse the
 * local wall clock (same host, same zone as the task's `startedAt` comparison).
 */
function systemdStampMs(value) {
  if (typeof value !== 'string') return null
  const match = /^[A-Za-z]{3}\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(value.trim())
  if (match === null) return null
  const parsed = Date.parse(`${match[1]}T${match[2]}`)
  return Number.isNaN(parsed) ? null : parsed
}

function resolveExecutable(bin) {
  const candidates = bin.includes('/')
    ? [bin]
    : (process.env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, bin))
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {
      // keep looking
    }
  }
  return null
}

async function main() {
  let config
  try {
    config = parseServeConfig()
  } catch (error) {
    fail(error)
    return
  }

  let lock
  try {
    lock = acquireInstanceLock(config.lockPath)
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      log('serve:already-running', error.message)
      process.exit(EXIT_ALREADY_RUNNING)
    }
    fail(error)
    return
  }
  log('[startup] 1/8 config ok')
  log('config', { dataDir: config.dataDir, db: config.dbPath, channel: config.channel, foreground: config.foreground })

  // Filled in by the startup steps, closed by `shutdown`.
  let stores = null
  let host = null
  let channel = null
  let decideRunner = null
  let transport = null
  let patrol = null
  let stopping = false
  let seq = 0

  // The dispatcher only pumps after `host.start()`, which runs after step 7, so
  // forwarding is never observed before the real transport exists.
  const forwardedTransport = {
    async send(item) {
      if (transport === null) throw new Error('transport-not-started')
      return transport.send(item)
    },
  }

  const plan = [
    {
      id: 2,
      name: 'storage',
      run() {
        mkdirSync(config.dataDir, { recursive: true })
        mkdirSync(config.workdir, { recursive: true })
        mkdirSync(config.snapshotDir, { recursive: true })
        mkdirSync(config.attachmentDir, { recursive: true })
        mkdirSync(config.outboxFilesDir, { recursive: true })
        const approvals = createApprovalStore(config.dbPath)
        try {
          stores = {
            approvals,
            grants: createGrantStore(config.dbPath),
            memory: createMemoryStore(config.dbPath),
            snapshot: createSnapshotStore(config.dbPath),
            // Slice AT (J5): 提醒与任务同库不同表；本模块是 reminders 的唯一写者。
            reminders: createReminderStore(config.dbPath),
            // Slice AV: 变更台账；⑦ 是 changes 的唯一写者。
            changes: createChangeStore(config.dbPath),
          }
        } catch (error) {
          approvals.close()
          throw error
        }
        log('storage', { db: config.dbPath })
      },
    },
    {
      id: 3,
      name: 'modules',
      run() {
        assertModules({
          createMemoryStore,
          createReminderStore,
          createChangeStore,
          createSnapshotStore,
          createApprovalStore,
          createGrantStore,
          createWfxmHost,
          createDshExecutor,
          createDecisionRunner,
          createResourceProbe,
        })
        // AR6: every project lives under one root in v1; ⑥'s `projects.root_path`
        // is the seam where per-project roots land later.
        const snapshotPort = createSnapshotPort({
          store: stores.snapshot,
          snapshotDir: config.snapshotDir,
          resolveRoot: () => config.workdir,
        })
        const projectPort = createProjectLookupPort(stores.memory)
        // B4-b: per-task workdir. `stores.tasks` is assigned when the host is
        // built below, so resolve it lazily; no task => the legacy shared root.
        let isolation = null
        const workdirResolver = async (task) => {
          const record = stores.tasks?.getTask(task.id) ?? null
          if (record === null) return config.workdir
          const project = record.projectId === null ? null : stores.memory.getProject(record.projectId)
          if (project === null) return config.workdir
          isolation ??= createIsolationResolver({
            tasks: stores.tasks,
            logger: {
              info: (message) => log('isolation', message),
              warn: (message) => log('isolation:warn', message),
            },
          })
          return isolation(record, project, config.workdir)
        }
        const executor = createDshExecutor({
          dshBin: config.dshBin,
          env: { ...process.env },
          defaultWorkdir: config.workdir,
          workdirResolver: config.worktreeIsolation ? workdirResolver : undefined,
          timeoutMs: config.executorTimeoutMs,
          // One attempt = one checkpoint, so ④ pre-images and ⑤ rollback share
          // the same step id (13 §3.4 步级回滚).
          checkpoints: {
            beginCheckpoint: (input) => stores.tasks.beginCheckpoint(input),
            closeCheckpoint: (id, status) => stores.tasks.closeCheckpoint(id, status),
          },
        })
        const systemd = createSystemdAdapter({ runner: spawnRunner })
        // Slice AZ (AR37): the policy version in force at boot. Wake
        // re-verification rejects grants issued under a different version.
        const policyVersion = loadPolicy()?.version ?? null
        log('policy', { version: policyVersion })
        // H2: fail the service at boot on a malformed admission config rather
        // than silently running without a gate.
        const admission = createAdmission(parseAdmissionEnv(process.env))
        log('admission', {
          channels: process.env.DSH_WFXM_ADMISSION_CHANNELS ?? 'all',
          rate: process.env.DSH_WFXM_ADMISSION_RATE ?? 'off',
        })
        // Slice BD (J2): 每日摘要；配置非法在启动期就失败，不静默降级为“没开”。
        const mailDigest = parseDigestEnv(process.env, {
          statePath: join(dirname(config.dbPath), 'mail-digest-state.json'),
        })
        log('digest', mailDigest === null
          ? { at: 'off' }
          : { at: mailDigest.at, channel: mailDigest.channelId, chat: mailDigest.chatId ?? 'latest' })
        // Slice S: deterministic read-only checks for the front desk's quick answers.
        const quickLogWindowMinutes = readInspectionConfig(process.env).thresholds.logWindowMinutes
        host = createWfxmHost({
          dbPath: config.dbPath,
          executor,
          transport: forwardedTransport,
          duplicateWindowMs: config.duplicateWindowSeconds * 1000,
          snapshot: snapshotPort,
          project: projectPort,
          rollback: createPreimageRollbackPort(stores.snapshot),
          approvals: stores.approvals,
          grants: stores.grants,
          policyVersion,
          admission,
          mailDigest,
          reminders: stores.reminders,
          changes: stores.changes,
          // Startup recovery restores a `dir:` workspace snapshot before the
          // worker may re-queue anything (Slice AV).
          restoreWorkspace: (snapshotId) => {
            const snapshot = stores.snapshot.getSnapshot(snapshotId)
            if (snapshot === null) throw new Error(`snapshot ${snapshotId} not found`)
            restoreWorkspace({ root: config.workdir, locator: snapshot.locator })
          },
          // H4: same file governance treats as its kill switch; the file (not
          // memory) is the source of truth so a restart keeps the stop state.
          // Never inside the release: releases are immutable and owned by the
          // deploy user, while the service runs as dshwfxm.
          haltFile: process.env.DSH_WFXM_HALT_FILE
            ?? join(process.env.DSH_WFXM_DATA_DIR ?? fileURLToPath(new URL('..', import.meta.url)), 'KILL'),
          worker: {
            resourceLocks: config.resourceLocks,            verify: {
              cwd: config.workdir,
              // R3 服务起停模板断言 `service_active` 的只读探针。适配器只认
              // 托管前缀；非托管 unit / 探测失败一律 'unknown' → 断言 skipped
              // → 完成被拒（fail-closed，不把探测不到当成健康）。
              serviceStatus: async (unit) => {
                try {
                  const status = await systemd.status(unit)
                  return status.activeState === 'active' ? 'active' : 'inactive'
                } catch {
                  return 'unknown'
                }
              },
              // `unit_restarted` 的只读探针：拿 ActiveEnterTimestamp 与任务 startedAt 比，
              // 没有它「重启失败但服务本来就在跑」也会被判 pass（2026-11-13 实测）。
              unitState: async (unit) => {
                try {
                  const status = await systemd.status(unit)
                  return {
                    activeState: status.activeState === 'active' ? 'active' : 'inactive',
                    activeEnteredAtMs: systemdStampMs(status.activeEnterTimestamp),
                  }
                } catch {
                  return { activeState: 'unknown', activeEnteredAtMs: null }
                }
              },
            },
          },
          foregroundFactory: ({ tasks }) => {
            if (config.foreground === 'rule') return createRuleForeground({ tasks })
            const runner = createDecisionRunner({
              kind: config.decideRunner,
              timeoutMs: config.decideTimeoutMs,
              logger: { warn: (message) => log('front:warn', message) },
            })
            decideRunner = runner
            void runner
              .warm()
              .then(() => log('front:warm', config.decideRunner))
              .catch((error) => log('front:warn', `warm failed: ${error instanceof Error ? error.message : String(error)}`))
            return createOrchestratorForeground({
              tasks,
              decide: runner,
              probe: createResourceProbe({ runner: spawnRunner }),
              checks: {
                unitStatus: async (unit) => {
                  try {
                    return (await systemd.status(unit)).activeState
                  } catch {
                    return null
                  }
                },
                listeningPorts: () => probeListeningPorts(spawnRunner),
                logErrors: (minutes) => probeLogErrors(spawnRunner, minutes ?? quickLogWindowMinutes),
              },
              fallback: createRuleForeground({ tasks }),
              // Slice AT (J5): 前台只能写提醒表，不执行任何外部动作。
              reminders: createReminderPort(stores.reminders),
              logger: { warn: (message) => log('front:warn', message) },
            })
          },
          pumpIntervalMs: config.pumpIntervalMs,
          // Slice AS (A4): receipts over `spillChars` become Markdown files in
          // `outbox-files/`; 0 disables spilling.
          spill: config.spillChars === 0
            ? null
            : { dir: config.outboxFilesDir, thresholdChars: config.spillChars },
          // Slice R: time-only progress notices; `progress: null` disables them.
          progress: config.taskProgress
            ? {
                milestonesMs: config.taskMilestonesMin.map((minute) => minute * 60_000),
                stallMs: config.taskStallMinutes === 0 ? null : config.taskStallMinutes * 60_000,
                pauseOnStall: config.watchdogPause,
              }
            : null,
          logger: {
            warn: (message) => log('host:warn', message),
            // Slice Q: an exhausted outbox row is an error, not a quiet drop.
            error: (message) => log('host:error', message),
          },
        })
        stores.tasks = host.stores.tasks
        log('modules', {
          foreground: config.foreground,
          runner: config.foreground === 'rule' ? null : config.decideRunner,
          reminders: 'on',
          changes: 'on',
          spill: config.spillChars === 0 ? 'off' : config.spillChars,
          progress: config.taskProgress
            ? {
                milestonesMin: config.taskMilestonesMin,
                stallMin: config.taskStallMinutes,
                pauseOnStall: config.watchdogPause,
              }
            : 'off',
        })
      },
    },
    {
      id: 4,
      name: 'profile',
      run() {
        // The front desk's zero-tool guarantee is the overlay's job (AR25 / #11);
        // a rule foreground has no model tools either, so both paths check it.
        assertZeroToolAsset(
          fileURLToPath(new URL('../plugins/orchestrator/assets/frontdesk.sdk.patch.yml', import.meta.url)),
        )
        log('profile', 'zero-tool overlay verified')
      },
    },
    {
      id: 5,
      name: 'ports',
      run() {
        const dsh = resolveExecutable(config.dshBin)
        if (dsh === null) throw new Error(`dsh binary not executable: ${config.dshBin} (set DSH_WFXM_DSH_BIN)`)
        try {
          accessSync(config.workdir, constants.W_OK)
          accessSync(config.snapshotDir, constants.W_OK)
          accessSync(config.attachmentDir, constants.W_OK)
          accessSync(config.outboxFilesDir, constants.W_OK)
        } catch (error) {
          throw new Error(`data directories not writable: ${error instanceof Error ? error.message : String(error)}`)
        }
        for (const [key, path] of [
          ['DSH_WFXM_FEISHU_CONFIG', config.feishuConfigPath],
          ['DSH_WFXM_CREDENTIALS', config.credentialsPath],
        ]) {
          if (path !== null && !existsSync(path)) throw new Error(`${key} not found: ${path}`)
        }
        log('ports', { dsh, workdir: config.workdir, channel: config.channel })
      },
    },
    {
      id: 6,
      name: 'recovery',
      async run() {
        // Slice AV: 先还原上一条进程遗留的半应用工作区，再让 ⑤ 重排任务——
        // 反过来的话，重试会踩在尚未回滚的改动上（docs/11 §5.4）。
        const settled = await host.recoverChanges()
        log('recovery:changes', settled)
        log('halt', { halted: host.isHalted() })
        const recovered = host.worker.recover()
        log('recovery', { requeued: recovered.requeued.length, failed: recovered.failed.length })
      },
    },
    {
      id: 7,
      name: 'channel',
      async run() {
        if (config.channel === 'loopback') {
          // Drills / --check only: no inbound, so startup can be exercised end to
          // end (steps 7-8 included) without a second Feishu long connection.
          channel = { start: async () => {}, stop: async () => {} }
          transport = {
            async send(item) {
              seq += 1
              return { externalMsgId: `loop-${item.id}-${seq}` }
            },
          }
          await channel.start()
          log('channel', 'loopback (no inbound)')
          return
        }
        const credentials = loadFeishuCredentials({
          ...config.feishuConfigPath === null ? {} : { configPath: config.feishuConfigPath },
          ...config.credentialsPath === null ? {} : { credentialsPath: config.credentialsPath },
        })
        const client = await createLarkClient({
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          ...credentials.domain === null ? {} : { domain: credentials.domain },
        })
        // Slice BI (A8): voice transcription is optional; without ASR config the
        // channel keeps its explicit "转写未启用" note.
        const transcriber = config.asr === null ? null : createOpenAiTranscriber(config.asr)
        log('asr', transcriber === null
          ? 'disabled'
          : { model: config.asr.model, baseUrl: config.asr.baseUrl })
        transport = createFeishuTransport({
          client,
          patchDelayMs: 8000,
          resolveChatId: (threadId) => host?.stores.gateway.getThread(threadId)?.chatId ?? null,
          logger: {
            info: (message, meta) => log('transport', meta === undefined ? message : { message, ...meta }),
            warn: (message, meta) => log('transport:warn', meta === undefined ? message : { message, ...meta }),
            error: (message, meta) => log('transport:error', meta === undefined ? message : { message, ...meta }),
          },
        })
        channel = createFeishuChannel({
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          ...credentials.domain === null ? {} : { domain: credentials.domain },
          onMessage,
          onCardAction,
          // Slice AS (A8): images/files/voice land under the data directory and
          // their paths are appended to the message text.
          attachments: {
            dir: config.attachmentDir,
            resource: client.im.v1.messageResource,
            ...(transcriber === null ? {} : { transcribe: transcriber }),
          },
          logger: {
            info: (message, meta) => log('channel', meta === undefined ? message : { message, ...meta }),
            warn: (message, meta) => log('channel:warn', meta === undefined ? message : { message, ...meta }),
            error: (message, meta) => log('channel:error', meta === undefined ? message : { message, ...meta }),
          },
        })
        // Fresh install: print a one-time code instead of silently rejecting the
        // first stranger (docs/14 §四). The code is not logged after pairing.
        if (host.stores.gateway.listBindings().length === 0) {
          const actor = host.stores.gateway.createActor({ kind: 'owner', displayName: 'owner' })
          const minted = host.stores.gateway.mintPairingCode({
            actorId: actor.id,
            channelId: credentials.appId,
          })
          log('pairing', { hint: `在飞书给机器人发：/bind ${minted.code}`, expiresAt: minted.expiresAt })
        }
        await channel.start()
        log('channel', { appId: credentials.appId })
      },
    },
    {
      id: 8,
      name: 'readiness',
      run() {
        writeReadiness(config.readinessPath, {
          pid: process.pid,
          channel: config.channel,
          foreground: config.foreground,
          dbPath: config.dbPath,
        })
        log('readiness', config.readinessPath)
      },
    },
  ]

  try {
    await runStartup(plan, { logger: log, total: 8 })
  } catch (error) {
    await shutdown(EXIT_STARTUP_FAILED, error)
    return
  }

  if (checkOnly) {
    await shutdown(0, '--check passed')
    return
  }

  host.start()
  startPatrol()
  log('ready', { pid: process.pid, channel: config.channel })

  /**
   * G2/G3: the host ticks, svcops inspects, module ⑥ (outbox) delivers. Patrol
   * failures are logged and never block inbound serving; `--check` returns
   * before this point, so drills stay side-effect free.
   */
  function startPatrol() {
    const { config: patrolConfig, warnings } = readPatrolConfig(process.env)
    for (const warning of warnings) log('patrol:warn', warning)
    if (patrolConfig.intervalMinutes <= 0) {
      log('patrol', 'disabled (DSH_WFXM_PATROL_INTERVAL_MINUTES=0)')
      return
    }
    const inspection = readInspectionConfig(process.env)
    for (const warning of inspection.warnings) log('patrol:warn', warning)
    // Slice O: a dedicated headless runner keeps the summary turn away from the
    // resident front-desk session (no interleaving) and pays one cold start per
    // day at most. `foreground=rule` drills have no model, so they skip it.
    const semanticRunner = config.semanticDigest && config.foreground === 'orchestrator'
      ? createDecisionRunner({
          kind: 'headless',
          timeoutMs: config.decideTimeoutMs,
          logger: { warn: (message) => log('semantic:warn', message) },
        })
      : null
    log('semantic', semanticRunner === null
      ? (config.semanticDigest ? 'disabled (foreground=rule)' : 'disabled (DSH_WFXM_SEMANTIC_DIGEST)')
      : `enabled (headless, ${config.decideTimeoutMs}ms)`)

    // ①/⑤ own the data; this root only reads. `title` lets the weekly report
    // reuse the same counts without pretending to be a daily digest, and
    // `semantic:false` keeps the weekly message model-free (Slice P).
    const gatewayStore = host.stores.gateway
    const taskStore = host.stores.tasks

    const buildConversationDigest = async ({ from, to, title, semantic }) => {
      const taskById = new Map(taskStore.listTasks().map((task) => [task.id, task]))
      const messages = gatewayStore.listInbox({
        since: from.toISOString(),
        until: to.toISOString(),
      })
      const links = taskStore.listTaskThreads()
      const digest = summarizeConversationDigest({
        threads: gatewayStore.listThreads().map((thread) => ({
          threadId: thread.id,
          chatId: thread.chatId,
          kind: thread.kind,
          topicId: thread.topicId,
        })),
        messages: messages.map((item) => ({
          threadId: item.threadId,
          chatId: item.chatId,
          kind: item.kind,
          status: item.status,
          receivedAt: item.receivedAt,
        })),
        tasks: links.flatMap((link) => {
          const task = taskById.get(link.taskId)
          return task === undefined
            ? []
            : [{
                taskId: task.id,
                threadId: link.threadId,
                createdAt: task.createdAt,
                intent: task.intent,
              }]
        }),
        window: { from, to, ...(title === undefined ? {} : { title }) },
      })
      if (digest === null) return null

      let text = digest.text
      if (!semantic || semanticRunner === null) return text

      // Assemble the same window for the model: ① texts are already
      // redacted by the owner (`inboundText`); ⑤ contributes intent/status/
      // receipt. Nothing here is logged except counts.
      const groups = new Map()
      const group = (key, at) => {
        let entry = groups.get(key)
        if (entry === undefined) {
          entry = { messages: [], tasks: [], taskIds: new Set(), lastAt: at }
          groups.set(key, entry)
        }
        return entry
      }
      for (const item of messages) {
        if (item.kind !== 'message') continue
        const key = item.threadId !== null
          ? `thread:${item.threadId}`
          : item.chatId !== null
            ? `chat:${item.chatId}`
            : null
        if (key === null) continue
        const body = inboundText(item.content)
        if (body === null) continue
        const entry = group(key, item.receivedAt)
        entry.messages.push({ at: item.receivedAt, text: body })
        if (item.receivedAt > entry.lastAt) entry.lastAt = item.receivedAt
      }
      for (const link of links) {
        const task = taskById.get(link.taskId)
        if (task === undefined) continue
        const created = Date.parse(task.createdAt)
        if (!(created >= from.getTime() && created <= to.getTime())) continue
        const entry = group(`thread:${link.threadId}`, task.createdAt)
        if (entry.taskIds.has(task.id)) continue
        entry.taskIds.add(task.id)
        const latest = taskStore.listReceipts(task.id).at(-1)
        entry.tasks.push({
          intent: redactedText(typeof task.intent === 'string' ? task.intent : ''),
          status: task.status,
          receipt: latest === undefined ? null : redactedText(latest.summary),
        })
      }
      const conversations = [...groups.values()]
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
        .slice(0, 5)
      const summary = await summarizeConversationSemantics(
        { window: { from, to }, conversations },
        { runner: semanticRunner },
      )
      log('semantic', summary === null
        ? 'summary unavailable; structured digest kept'
        : `summary ok (${conversations.length} conversations)`)
      if (summary === null) return text
      const [head, ...rest] = text.split('\n')
      text = [head, summary, ...rest].join('\n')
      return text
    }

    try {
      patrol = createInspectionPatrol({
        dbPath: config.dbPath,
        config: patrolConfig,
        thresholds: inspection.thresholds,
        expectedPorts: inspection.expectedPorts,
        // Slice M: task digest shares the daily gate with the inspection digest
        // but goes out as its own message; ⑤ owns the data, this root only reads.
        taskDigest: ({ from, to }) => summarizeTaskDigest(
          taskStore.listTasks(),
          { from, to },
        )?.text ?? null,
        // Slice N/O: conversation digest reads ① threads/inbox and ⑤ task links.
        // The structured body never carries message text; Slice O adds one
        // model-written paragraph on top, and any failure keeps the body.
        conversationDigest: ({ from, to }) => buildConversationDigest({ from, to, semantic: true }),
        // Slice P: weekly body = ⑦ inspection section (built by the patrol) +
        // these ⑤/① sections. No model, no message bodies beyond the intent.
        weeklySections: async ({ from, to }) => {
          const tasks = summarizeTaskDigest(taskStore.listTasks(), {
            from,
            to,
            title: '任务（近 7 天）',
          })?.text ?? null
          const conversations = await buildConversationDigest({
            from,
            to,
            title: '会话（近 7 天）',
            semantic: false,
          })
          return [tasks, conversations]
            .filter((section) => section !== null && section !== '')
            .join('\n') || null
        },
        // Slice Q: outbound failures/backlog were invisible after the retry
        // ceiling; the daily digest and weekly report each carry one line.
        // ① owns the counts, this root only formats them.
        outboxDigest: ({ from, to }) => {
          const health = gatewayStore.outboxHealth({ since: from, now: to })
          const retrying = health.retrying > 0 ? `（重试 ${health.retrying}）` : ''
          return `出站：失败 ${health.failed} · 积压 ${health.pending}${retrying}`
        },
        deliver: ({ text, dedupeKey }) => {
          // v1 has one owner; `listBindings` is ascending, so the newest live
          // binding is the current recipient.
          const bindings = host.stores.gateway.listBindings()
          const openId = bindings.at(-1)?.externalUserId
          if (openId === undefined) {
            log('patrol:warn', 'no live owner binding; push dropped')
            return
          }
          const item = host.stores.gateway.enqueueOutbox({
            topic: 'say',
            payload: { text, openId },
            dedupeKey,
          })
          log('patrol', { queued: dedupeKey, outbox: item.id })
        },
        logger: {
          info: (message) => log('patrol', message),
          warn: (message) => log('patrol:warn', message),
        },
      })
      patrol.start()
    } catch (error) {
      log('patrol:warn', `failed to start: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function onMessage(message) {
    log('in', { msgId: message.msgId, chatId: message.chatId, replyToMsgId: message.replyToMsgId })
    const turn = await host.ingest({
      channelId: message.channelId,
      msgId: message.msgId,
      externalUserId: message.externalUserId,
      kind: 'message',
      content: message.content,
      chatId: message.chatId,
      topicId: message.topicId,
      rootMsgId: message.rootMsgId,
      replyToMsgId: message.replyToMsgId,
    })
    log('route', {
      target: turn.result.target,
      bypass: turn.result.bypassReason,
      followUp: turn.result.followUp === null
        ? null
        : { matchedBy: turn.result.followUp.matchedBy, taskId: turn.result.followUp.taskId },
      relay: turn.result.relay ?? null,
      control: turn.result.control ?? null,
      wake: turn.result.wake ?? null,
      foreground: turn.foreground,
      error: turn.error ?? turn.result.error,
    })
    // Ack / direct reply leave immediately; the worker loop owns execution.
    await host.pump()
  }

  /** `card.action.trigger` sink; Feishu needs a toast within a few seconds. */
  async function onCardAction(action) {
    log('card', { msgId: action.msgId, chatId: action.chatId, action: action.action })
    const turn = await host.ingest({
      channelId: action.channelId,
      msgId: action.msgId,
      externalUserId: action.externalUserId,
      kind: 'card_action',
      content: action.action,
      ...action.chatId === null ? {} : { chatId: action.chatId },
      ...action.replyToMsgId === null ? {} : { replyToMsgId: action.replyToMsgId },
    })
    log('card:result', {
      inbox: turn.result.inbox.status,
      approval: turn.result.approval ?? null,
      error: turn.error ?? turn.result.error,
    })
    // Feishu requires the callback answer within ~3s; the card patch is
    // intentionally delayed, so never await the pump here.
    void host.pump().catch((error) => {
      log('pump:error', { error: error instanceof Error ? error.message : String(error) })
    })
    const approval = turn.result.approval ?? null
    if (approval === null) return { ok: true, toast: '已处理' }
    // R3's first click is a staged, expected step — not a failure (Slice L).
    if (approval.ok === false && approval.code === 'confirm-required') {
      const record = stores?.approvals.get(approval.approvalId) ?? null
      const card = record === null
        ? undefined
        : buildApprovalConfirmCard({
          kind: 'approval_confirm',
          approvalId: approval.approvalId,
          level: record.level,
          summary: record.summary,
          nonce: approval.nonce ?? record.nonce,
          ...record.expiresAt === null ? {} : { expiresAt: record.expiresAt },
          ...record.externalMsgId === null ? {} : { externalMsgId: record.externalMsgId },
        })
      return {
        ok: true,
        toast: '已批准第一步，请点击「确认执行」',
        ...card === undefined ? {} : { card: { type: 'raw', data: card } },
      }
    }
    if (approval.ok) {
      const card = buildApprovalResultCard({
        approvalId: approval.approvalId,
        decision: approval.status === 'approved' ? 'approved' : 'rejected',
      })
      return {
        ok: true,
        toast: approval.status === 'approved' ? '已批准' : '已拒绝',
        card: { type: 'raw', data: card },
      }
    }
    return {
      ok: false,
      toast: approval.code === 'not-pending' ? '该审批已处理' : `处理失败：${approval.code}`,
    }
  }

  async function shutdown(code, reason) {
    if (stopping) return
    stopping = true
    if (reason instanceof StartupError) {
      log('startup:failed', { step: `${reason.step}/8`, name: reason.stepName, message: reason.message })
      if (reason.cause !== undefined) log('startup:cause', reason.cause instanceof Error ? reason.cause.message : String(reason.cause))
    } else if (reason !== undefined) {
      log('shutdown', reason)
    }
    try {
      host?.stop()
      // Drain what is already queued before dropping the long connection.
      for (let i = 0; i < 3 && host !== null; i += 1) {
        const pumped = await host.pump()
        if ((pumped.dispatch?.sent ?? 0) === 0) break
      }
    } catch (error) {
      log('shutdown:warn', `flush failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await channel?.stop()
    } catch (error) {
      log('shutdown:warn', `channel stop failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await decideRunner?.close()
    } catch (error) {
      log('shutdown:warn', `decision runner close failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      patrol?.stop()
    } catch (error) {
      log('shutdown:warn', `patrol close failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      host?.close()
      stores?.approvals.close()
      stores?.grants.close()
      stores?.memory.close()
      stores?.snapshot.close()
      stores?.reminders.close()
      stores?.changes.close()
    } catch (error) {
      log('shutdown:warn', `close failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    removeReadiness(config.readinessPath)
    lock.release()
    process.exit(code)
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => void shutdown(0, signal))
  }

  // Keep the process alive even in loopback mode (no channel timers).
  setInterval(() => {}, 60_000)
  await new Promise(() => {})
}

function fail(error) {
  if (error instanceof StartupError) {
    log('startup:failed', { step: `${error.step}/8`, name: error.stepName, message: error.message })
  } else {
    log('startup:failed', error instanceof Error ? error.message : String(error))
  }
  process.exit(EXIT_STARTUP_FAILED)
}

await main()
