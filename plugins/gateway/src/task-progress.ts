/**
 * Long-task visibility (Slice R + B3 v1): a `running` task that says nothing
 * for minutes is indistinguishable from a stuck bot. ⑤ has no streaming
 * progress (the dsh call is all-or-nothing), so the only honest signal is time:
 *
 * - one notice per milestone (`2m`, `10m` by default) since `started_at`;
 * - one structured stall notice per event sequence when no task event arrived
 *   for `stallMs`, naming the lifecycle phase it stopped at and the one action
 *   that actually stops it (`停止 <ref>`).
 *
 * The stall notice deliberately does **not** pause the task: the row would say
 * `paused` while the dsh child keeps running, and its completion would then hit
 * an illegal `paused → succeeded` transition. Cooperative cancellation is the
 * prerequisite, so v1 only tells the owner where it is stuck.
 *
 * ① owns `outbox`, so it enqueues the messages and deduplicates them by
 * `dedupe_key`. It never reads ⑤'s tables: the host implements the port below
 * (AR33). A task without an addressable live thread is skipped, never guessed.
 */

import type { Json } from './model.js'
import type { GatewayStore } from './store.js'

export const TASK_PROGRESS_TOPIC = 'task.progress'
export const DEFAULT_MILESTONES_MS: readonly number[] = [2 * 60_000, 10 * 60_000]
export const DEFAULT_STALL_MS = 15 * 60_000

/** One running task as ⑤ sees it; `threadIds` is ordered default-owner first. */
export interface RunningTaskSnapshot {
  taskId: string
  taskRef: string | null
  intent: string
  startedAt: string | null
  lastEventAt: string | null
  lastEventSeq: number | null
  /** Latest lifecycle event type, so a stall can say where it stopped. */
  lastEventType?: string | null
  threadIds: string[]
}

/** Implemented by the host on top of ⑤'s store. */
export interface TaskProgressPort {
  listRunningTasks(limit?: number): RunningTaskSnapshot[]
}

export interface TaskProgressOptions {
  store: GatewayStore
  tasks: TaskProgressPort
  now?: () => Date
  /** Ascending milestones in ms; defaults to 2 / 10 minutes. */
  milestonesMs?: readonly number[]
  /** Silence before the "maybe stuck" notice; `null` or `<= 0` disables it. */
  stallMs?: number | null
  /** Max running tasks scanned per pump; defaults to 50. */
  limit?: number
}

export interface TaskProgressReport {
  scanned: number
  enqueued: number
  skippedNoThread: number
  skippedDuplicate: number
}

export interface TaskProgressRelay {
  pump(): TaskProgressReport
}

function minutes(ms: number): number {
  return Math.max(1, Math.floor(ms / 60_000))
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

function refOf(snapshot: RunningTaskSnapshot): string {
  return snapshot.taskRef ?? snapshot.taskId.slice(0, 8)
}

/** Human phase for the last event, so "stuck at" is readable without raw enums. */
function phaseOf(eventType: string | null | undefined): string {
  switch (eventType) {
    case 'task.started': return '开始执行'
    case 'task.checkpoint': return '执行中（checkpoint 已打开）'
    case 'task.waiting_approval': return '等审批'
    case 'task.waiting_input': return '等补充输入'
    case 'task.resumed': return '刚恢复'
    case null:
    case undefined: return '未知阶段'
    default: return eventType
  }
}

/** Highest milestone already reached, so a restart never fires several at once. */
function reachedMilestone(elapsedMs: number, milestones: readonly number[]): number | null {
  let reached: number | null = null
  for (const milestone of milestones) {
    if (elapsedMs >= milestone && (reached === null || milestone > reached)) reached = milestone
  }
  return reached
}

export function createTaskProgressRelay(options: TaskProgressOptions): TaskProgressRelay {
  const { store, tasks } = options
  const now = options.now ?? (() => new Date())
  const milestones = [...(options.milestonesMs ?? DEFAULT_MILESTONES_MS)].sort((a, b) => a - b)
  const stallMs = options.stallMs === undefined ? DEFAULT_STALL_MS : options.stallMs
  const limit = options.limit ?? 50

  const enqueue = (
    snapshot: RunningTaskSnapshot,
    threadId: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): 'enqueued' | 'duplicate' => {
    if (store.findOutboxByDedupe(dedupeKey) !== null) return 'duplicate'
    store.enqueueOutbox({
      topic: TASK_PROGRESS_TOPIC,
      payload: payload as Json,
      taskId: snapshot.taskId,
      threadId,
      dedupeKey,
    })
    return 'enqueued'
  }

  return {
    pump() {
      const report: TaskProgressReport = {
        scanned: 0,
        enqueued: 0,
        skippedNoThread: 0,
        skippedDuplicate: 0,
      }
      const at = now()

      for (const snapshot of tasks.listRunningTasks(limit)) {
        report.scanned += 1

        const threadId = snapshot.threadIds.find((id) => store.getThread(id) !== null) ?? null
        if (threadId === null) {
          report.skippedNoThread += 1
          continue
        }

        const started = snapshot.startedAt === null ? null : Date.parse(snapshot.startedAt)
        if (started === null || Number.isNaN(started)) continue
        const elapsedMs = at.getTime() - started
        if (elapsedMs < 0) continue

        const milestone = reachedMilestone(elapsedMs, milestones)
        if (milestone !== null) {
          const text = `任务 ${refOf(snapshot)} 仍在运行（已运行 ${minutes(elapsedMs)} 分钟）。`
            + `目标：${oneLine(snapshot.intent, 80)}`
          const outcome = enqueue(
            snapshot,
            threadId,
            `task-progress:${snapshot.taskId}:${milestone}`,
            {
              kind: 'task_progress',
              taskId: snapshot.taskId,
              taskRef: snapshot.taskRef,
              elapsedMs,
              milestoneMs: milestone,
              text,
            },
          )
          if (outcome === 'enqueued') report.enqueued += 1
          else report.skippedDuplicate += 1
        }

        if (stallMs !== null && stallMs > 0 && snapshot.lastEventAt !== null) {
          const lastEvent = Date.parse(snapshot.lastEventAt)
          const silentMs = Number.isNaN(lastEvent) ? 0 : at.getTime() - lastEvent
          if (silentMs >= stallMs) {
            const seq = snapshot.lastEventSeq ?? 0
            const ref = refOf(snapshot)
            const phase = phaseOf(snapshot.lastEventType)
            const text = `任务 ${ref} 已 ${minutes(silentMs)} 分钟没有新事件，`
              + `卡在「${phase}」，已运行 ${minutes(elapsedMs)} 分钟。`
              + `不会自动停止：回复「停止 ${ref}」可取消，或继续等待。`
            const outcome = enqueue(
              snapshot,
              threadId,
              `task-progress:${snapshot.taskId}:stall:${seq}`,
              {
                kind: 'task_progress',
                taskId: snapshot.taskId,
                taskRef: snapshot.taskRef,
                elapsedMs,
                stall: true,
                silentMs,
                stuckAt: snapshot.lastEventType ?? null,
                stuckPhase: phase,
                options: ['wait', 'stop'],
                text,
              },
            )
            if (outcome === 'enqueued') report.enqueued += 1
            else report.skippedDuplicate += 1
          }
        }
      }

      return report
    },
  }
}
