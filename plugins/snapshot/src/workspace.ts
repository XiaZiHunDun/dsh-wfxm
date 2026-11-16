/**
 * Workspace-level checkpoints (粒度二, 13 §3.4).
 *
 * A capture answers two questions at once: what the logical state was (manifest
 * of relative path → sha256/size) and where it can be restored from (`dir:` copy
 * now; `restic:` is accepted by contract but not implemented here).
 *
 * Fail-closed rules: the workspace must not change while capturing
 * (`concurrent-mutation`), the capture must finish inside the deadline
 * (`SNAPSHOT_TIMEOUT_MS`, default 10s), and a partial copy is removed rather
 * than recorded as a usable checkpoint.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { SnapshotError, type SnapshotRecord, type SnapshotStore } from './store.js'

/** 13 §3.4: `.git` is restored by git itself; `node_modules` churns on install. */
export const DEFAULT_EXCLUDES: readonly string[] = ['.git/', 'node_modules/']

export const SNAPSHOT_TIMEOUT_MS = 10_000

export interface ScannedFile {
  /** POSIX-style path relative to the workspace root. */
  rel: string
  sha256: string
  size: number
}

export interface WorkspaceScan {
  files: ScannedFile[]
  /** `manifest:<sha256>` over the sorted file list (baseline only). */
  manifest: string
  sizeBytes: number
  /** Symlinks and excluded paths are not part of the manifest. */
  skipped: string[]
}

export interface ScanOptions {
  excludes?: readonly string[]
  timeoutMs?: number
  /** Injectable clock so the deadline is testable. */
  now?: () => number
}

export function scanWorkspace(root: string, options: ScanOptions = {}): WorkspaceScan {
  const abs = resolve(root)
  const excludes = options.excludes ?? DEFAULT_EXCLUDES
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS)
  const files: ScannedFile[] = []
  const skipped: string[] = []

  const walk = (dir: string, prefix: string): void => {
    if (now() > deadline) throw timeout(abs)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      throw new SnapshotError('io-error', `cannot read ${dir}: ${messageOf(error)}`)
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (isExcluded(rel, excludes)) {
        skipped.push(rel)
        continue
      }
      if (now() > deadline) throw timeout(abs)
      if (entry.isSymbolicLink()) {
        skipped.push(rel)
        continue
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, rel)
        continue
      }
      if (!entry.isFile()) {
        skipped.push(rel)
        continue
      }
      let buffer: Buffer
      try {
        buffer = readFileSync(full)
      } catch (error) {
        throw new SnapshotError('io-error', `cannot read ${rel}: ${messageOf(error)}`)
      }
      files.push({
        rel,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        size: buffer.byteLength,
      })
    }
  }
  walk(abs, '')

  const material = files
    .map((file) => `${file.rel}\u0000${file.sha256}\u0000${file.size}`)
    .sort()
    .join('\n')
  return {
    files,
    manifest: `manifest:${createHash('sha256').update(material).digest('hex')}`,
    sizeBytes: files.reduce((total, file) => total + file.size, 0),
    skipped,
  }
}

export interface CaptureWorkspaceInput {
  store: SnapshotStore
  /** Workspace root (a git worktree or a plain directory). */
  root: string
  /** Where `dir:` snapshots are written; usually /var/lib/dsh-wfxm/snapshots. */
  snapshotDir: string
  kind?: 'workspace' | 'task'
  excludes?: readonly string[]
  timeoutMs?: number
  now?: () => number
  contentKey?: string | null
  /** Test/host seam: runs between the two stability scans. */
  onFirstScan?: () => void
}

export interface WorkspaceCapture {
  snapshot: SnapshotRecord
  scan: WorkspaceScan
}

/**
 * Freeze the workspace into `dir:<snapshotDir>/<id>`.
 *
 * The copy is written to a `.tmp` sibling and renamed, so a crash never leaves a
 * half-copied directory that looks like a usable checkpoint.
 */
export function captureWorkspace(input: CaptureWorkspaceInput): WorkspaceCapture {
  const before = scanWorkspace(input.root, input)
  input.onFirstScan?.()
  const after = scanWorkspace(input.root, input)
  if (before.manifest !== after.manifest) {
    throw new SnapshotError(
      'concurrent-mutation',
      `workspace changed while capturing (${before.manifest} → ${after.manifest})`,
    )
  }
  const locator = writeCopy(input, before)
  const snapshot = input.store.createSnapshot({
    kind: input.kind ?? 'workspace',
    locator,
    baselineRef: before.manifest,
    excludes: [...(input.excludes ?? DEFAULT_EXCLUDES)],
    contentKey: input.contentKey ?? null,
    sizeBytes: before.sizeBytes,
    createdAt: input.now === undefined ? new Date() : new Date(input.now()),
  })
  return { snapshot, scan: before }
}

function writeCopy(input: CaptureWorkspaceInput, scan: WorkspaceScan): string {
  const snapshotDir = resolve(input.snapshotDir)
  const id = `snap_${randomBytes(8).toString('hex')}`
  const tmp = join(snapshotDir, `${id}.tmp`)
  const final = join(snapshotDir, id)
  mkdirSync(snapshotDir, { recursive: true })
  try {
    // An empty workspace still produces a valid (empty) snapshot directory;
    // without this the rename below fails with ENOENT because `tmp` was never created.
    mkdirSync(tmp, { recursive: true })
    for (const file of scan.files) {
      const target = join(tmp, fromPosix(file.rel))
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(resolve(input.root), fromPosix(file.rel)), target)
    }
    renameSync(tmp, final)
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw new SnapshotError('io-error', `cannot write snapshot copy: ${messageOf(error)}`)
  }
  return `dir:${final}`
}

export interface RestoreWorkspaceInput {
  root: string
  locator: string
  excludes?: readonly string[]
  timeoutMs?: number
  now?: () => number
}

export interface WorkspaceRestore {
  restored: string[]
  /** Files present now but absent from the snapshot; left untouched by design. */
  extra: string[]
}

/** Restore a `dir:` checkpoint file by file (atomic per file). */
export function restoreWorkspace(input: RestoreWorkspaceInput): WorkspaceRestore {
  if (!input.locator.startsWith('dir:')) {
    throw new SnapshotError(
      'not-supported',
      `only dir: locators can be restored by this adapter, got ${JSON.stringify(input.locator)}`,
    )
  }
  const source = resolve(input.locator.slice('dir:'.length))
  if (!existsSync(source)) {
    throw new SnapshotError('not-found', `snapshot copy ${source} is gone`)
  }
  const snapshot = scanWorkspace(source, input)
  const current = scanWorkspace(input.root, input)
  const present = new Set(current.files.map((file) => file.rel))
  const restored: string[] = []
  for (const file of snapshot.files) {
    const target = join(resolve(input.root), fromPosix(file.rel))
    mkdirSync(dirname(target), { recursive: true })
    writeAtomic(target, readFileSync(join(source, fromPosix(file.rel))))
    present.delete(file.rel)
    restored.push(file.rel)
  }
  return { restored, extra: [...present].sort() }
}

export function writeAtomic(target: string, bytes: Buffer): void {
  const tmp = join(dirname(target), `.${randomBytes(6).toString('hex')}.dsh-wfxm-tmp`)
  try {
    writeFileSync(tmp, bytes, { flag: 'wx' })
    renameSync(tmp, target)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw new SnapshotError('io-error', `cannot write ${target}: ${messageOf(error)}`)
  }
}

function isExcluded(rel: string, excludes: readonly string[]): boolean {
  return excludes.some((entry) => {
    const normalized = entry.replace(/^\.\//, '')
    if (normalized === '') return false
    if (normalized.endsWith('/')) {
      const prefix = normalized.slice(0, -1)
      return rel === prefix || rel.startsWith(`${prefix}/`)
    }
    return rel === normalized || rel.startsWith(`${normalized}/`)
  })
}

function fromPosix(rel: string): string {
  return rel.split('/').join(sep)
}

function timeout(root: string): SnapshotError {
  return new SnapshotError('snapshot-timeout', `capturing ${root} exceeded the deadline`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
