/**
 * File-level pre-images (粒度一, 13 §3.4).
 *
 * Written *before* a `write` / `edit` tool call so the previous content of one
 * file can be restored without rewinding the whole workspace. Intra-tool-call
 * rollback only — it says nothing about side effects of shell commands.
 *
 * - ≤ `inlineLimit` (1 MiB): stored inline as `inline:<base64>` in the row.
 * - larger: spilled to `file:<abs>` under `contentDir`, the row keeps the pointer.
 * - the file did not exist: `state='absent'`, restoring removes the path.
 *
 * Rows are keyed by `(tool_call_id, path)`; a second capture of the same pair
 * returns the first row, so a retried tool call cannot overwrite its own
 * pre-image with the already-damaged content.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  PREIMAGE_INLINE_LIMIT,
  SnapshotError,
  type PreimageRecord,
  type SnapshotStore,
} from './store.js'
import { writeAtomic } from './workspace.js'

export interface CapturePreimageInput {
  store: SnapshotStore
  /** Workspace root for relative paths; absolute paths ignore it. */
  root?: string
  path: string
  toolCallId: string
  taskId?: string | null
  checkpointId?: string | null
  /** Where oversized content is spilled (defaults to the database directory). */
  contentDir?: string
  inlineLimit?: number
  now?: () => number
  expiresAt?: Date | null
}

export function capturePreimage(input: CapturePreimageInput): PreimageRecord {
  if (!input.toolCallId) throw new SnapshotError('invalid-input', 'toolCallId is required')
  if (!input.path) throw new SnapshotError('invalid-input', 'path is required')
  const target = resolvePath(input.root, input.path)
  const known = input.store.getPreimage(input.toolCallId, target)
  if (known !== null) return known

  if (!existsSync(target)) {
    return input.store.addPreimage({
      taskId: input.taskId ?? null,
      toolCallId: input.toolCallId,
      path: target,
      state: 'absent',
      checkpointId: input.checkpointId ?? null,
      createdAt: input.now === undefined ? undefined : new Date(input.now()),
      expiresAt: input.expiresAt ?? null,
    })
  }

  let bytes: Buffer
  try {
    bytes = readFileSync(target)
  } catch (error) {
    throw new SnapshotError('io-error', `cannot read ${target}: ${messageOf(error)}`)
  }
  const limit = input.inlineLimit ?? PREIMAGE_INLINE_LIMIT
  const contentRef = bytes.byteLength <= limit
    ? `inline:${bytes.toString('base64')}`
    : spill(input, bytes)

  return input.store.addPreimage({
    taskId: input.taskId ?? null,
    toolCallId: input.toolCallId,
    path: target,
    state: 'present',
    contentRef,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
    checkpointId: input.checkpointId ?? null,
    createdAt: input.now === undefined ? undefined : new Date(input.now()),
    expiresAt: input.expiresAt ?? null,
  })
}

export interface RestorePreimageInput {
  preimage: PreimageRecord
  root?: string
}

/** Undo one pre-image: rewrite the original bytes, or delete an absent tombstone. */
export function restorePreimage(input: RestorePreimageInput): { path: string; state: 'present' | 'absent' } {
  const target = isAbsolute(input.preimage.path)
    ? input.preimage.path
    : resolvePath(input.root, input.preimage.path)
  if (input.preimage.state === 'absent') {
    rmSync(target, { force: true })
    return { path: target, state: 'absent' }
  }
  const ref = input.preimage.contentRef
  if (ref === null) {
    throw new SnapshotError('invalid-input', `pre-image ${input.preimage.id} has no content`)
  }
  const bytes = ref.startsWith('inline:')
    ? Buffer.from(ref.slice('inline:'.length), 'base64')
    : ref.startsWith('file:')
      ? readSpilled(ref.slice('file:'.length))
      : null
  if (bytes === null) {
    throw new SnapshotError('invalid-input', `unknown content ref ${JSON.stringify(ref)}`)
  }
  mkdirSync(dirname(target), { recursive: true })
  writeAtomic(target, bytes)
  return { path: target, state: 'present' }
}

/** Restore a task's pre-images newest-first (checkpoint rollback, 13 §3.4). */
export function rollbackPreimages(input: {
  store: SnapshotStore
  /** Whole task (R3) or — together with `checkpointId` — one step (R2). */
  taskId?: string
  checkpointId?: string
  root?: string
}): { path: string; state: 'present' | 'absent' }[] {
  if (!input.taskId && !input.checkpointId) {
    throw new SnapshotError('invalid-input', 'rollback needs taskId or checkpointId')
  }
  const rows = input.store.listPreimages({
    ...input.taskId === undefined ? {} : { taskId: input.taskId },
    ...input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId },
  })
  const undone: { path: string; state: 'present' | 'absent' }[] = []
  for (const row of [...rows].reverse()) {
    undone.push(restorePreimage({ preimage: row, root: input.root }))
  }
  return undone
}

function spill(input: CapturePreimageInput, bytes: Buffer): string {
  const dir = resolve(input.contentDir ?? dirname(input.store.db.name))
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `preimage_${randomBytes(8).toString('hex')}.bin`)
  try {
    writeFileSync(target, bytes, { flag: 'wx' })
  } catch (error) {
    throw new SnapshotError('io-error', `cannot spill pre-image: ${messageOf(error)}`)
  }
  return `file:${target}`
}

function readSpilled(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch (error) {
    throw new SnapshotError('not-found', `pre-image content ${path} is gone: ${messageOf(error)}`)
  }
}

function resolvePath(root: string | undefined, path: string): string {
  if (isAbsolute(path)) return resolve(path)
  if (root === undefined || root === '') {
    throw new SnapshotError('invalid-input', 'a root is required for relative paths')
  }
  const target = resolve(root, path)
  return existsSync(target) ? realpathSync(target) : target
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
