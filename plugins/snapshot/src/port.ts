/**
 * ⑤'s `SnapshotPort`, implemented by ⑦ (13 §3.4).
 *
 * The port is structural rather than a shared package type (AR32), so ⑤ never
 * imports this plugin and this plugin never imports ⑤. A task only carries a
 * `projectId`; the host supplies `resolveRoot`, which is the only place that
 * knows where a project lives (⑥'s `projects.root_path`).
 *
 * Every failure path throws: ⑤ turns any throw into `failed(snapshot-refused)`
 * and never executes the task. That is the fail-closed contract.
 */

import type { SnapshotStore } from './store.js'
import { SnapshotError } from './store.js'
import { rollbackPreimages } from './preimage.js'
import { captureWorkspace, type WorkspaceCapture } from './workspace.js'

export interface SnapshotTaskRef {
  id: string
  projectId: string | null
}

export interface SnapshotPortResult {
  snapshotId: string
  baselineRef: string | null
}

/** Structural twin of ⑤'s `SnapshotPort`. */
export interface SnapshotPort {
  capture(task: SnapshotTaskRef): Promise<SnapshotPortResult>
}

/**
 * Structural twin of ⑤'s `CheckpointRollbackPort` (13 §3.4 步级回滚).
 * Restores only the pre-images of one step, or the whole task when no
 * checkpoint is named; ordering and idempotence live in `rollbackPreimages`.
 */
export interface PreimageRollbackPort {
  rollback(input: { taskId: string; checkpointId?: string }): Array<{
    path: string
    state: 'present' | 'absent'
  }>
}

export function createPreimageRollbackPort(store: SnapshotStore): PreimageRollbackPort {
  return {
    rollback(input) {
      return rollbackPreimages({
        store,
        taskId: input.taskId,
        ...input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId },
      })
    },
  }
}

export interface SnapshotPortOptions {
  store: SnapshotStore
  /** Where `dir:` copies are written (usually /var/lib/dsh-wfxm/snapshots). */
  snapshotDir: string
  /** Project → workspace root; null means "unknown project" and refuses capture. */
  resolveRoot: (projectId: string | null) => string | null
  excludes?: readonly string[]
  timeoutMs?: number
  now?: () => number
  /** Exposed for tests / hosts that want the scan (manifest, size, skipped). */
  onCaptured?: (capture: WorkspaceCapture, task: SnapshotTaskRef) => void
}

export function createSnapshotPort(options: SnapshotPortOptions): SnapshotPort {
  return {
    async capture(task) {
      const projectId = task.projectId ?? null
      const root = options.resolveRoot(projectId)
      if (root === null || root === '') {
        throw new SnapshotError(
          'not-found',
          `no workspace root for project ${JSON.stringify(projectId)}`,
        )
      }
      const captured = captureWorkspace({
        store: options.store,
        root,
        snapshotDir: options.snapshotDir,
        kind: 'task',
        excludes: options.excludes,
        timeoutMs: options.timeoutMs,
        now: options.now,
      })
      options.onCaptured?.(captured, task)
      return {
        snapshotId: captured.snapshot.id,
        baselineRef: captured.snapshot.baselineRef,
      }
    },
  }
}
