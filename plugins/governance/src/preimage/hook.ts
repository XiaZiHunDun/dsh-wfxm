/**
 * ④ hooks ⑦'s pre-images into the write path (13 §3.4, 粒度一).
 *
 * Called from the `tools/pre-execute` gate *after* the policy allows the call and
 * *before* `next()` lets the tool write. Two rules matter:
 *
 *   - the pre-image is taken for the file the tool is about to modify, so the
 *     previous bytes exist even if the tool call crashes half-way;
 *   - a failed capture denies the call (`preimage-failed`). A write that cannot
 *     be undone is exactly what this layer exists to prevent.
 *
 * Relative paths are skipped: the hook has no session cwd, and guessing one
 * would record a pre-image for the wrong file.
 */

import { isAbsolute, resolve, sep } from 'node:path'
import { capturePreimage, type SnapshotStore } from '@dsh-wfxm/snapshot'
import type { Policy } from '../policy/config.js'
import { resolveTaskContext } from './task-context.js'

/** Same tool set the policy gate treats as writes (policy/rules.ts). */
export const PREIMAGE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'str_replace_editor'])

export interface PreimageGuardResult {
  ok: boolean
  /** Absolute paths whose previous bytes were recorded (or tombstoned). */
  captured: string[]
  /** Paths deliberately not captured (relative / outside the roots). */
  skipped: string[]
  reason?: string
}

const PATH_KEYS = ['path', 'file_path', 'target'] as const

export function pathsOf(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  const paths: string[] = []
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) paths.push(value)
  }
  return paths
}

export function guardPreimages(input: {
  policy: Policy
  store: SnapshotStore
  toolCallId: string
  toolName: string
  args: unknown
}): PreimageGuardResult {
  const captured: string[] = []
  const skipped: string[] = []
  if (!input.policy.preimages.enabled) return { ok: true, captured, skipped }
  if (!PREIMAGE_TOOLS.has(input.toolName)) return { ok: true, captured, skipped }

  // One context per tool call; null outside a task (chat-driven writes).
  const task = resolveTaskContext()

  for (const path of pathsOf(input.args)) {
    if (!isAbsolute(path)) {
      skipped.push(path)
      continue
    }
    const target = resolve(path)
    if (!input.policy.preimages.roots.some((root) => isUnder(root, target))) {
      skipped.push(path)
      continue
    }
    try {
      capturePreimage({
        store: input.store,
        path: target,
        toolCallId: input.toolCallId,
        taskId: task?.taskId ?? null,
        checkpointId: task?.checkpointId ?? null,
        inlineLimit: input.policy.preimages.inlineLimit,
        contentDir: input.policy.preimages.contentDir,
      })
      captured.push(target)
    } catch (error) {
      return {
        ok: false,
        captured,
        skipped,
        reason: `preimage-failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  return { ok: true, captured, skipped }
}

function isUnder(root: string, target: string): boolean {
  const path = resolve(target)
  return path === root || path.startsWith(root + sep)
}
