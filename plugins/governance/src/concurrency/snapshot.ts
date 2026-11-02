import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'

/** Fingerprint of one file at the moment a session observed it. */
export interface FileFingerprint {
  size: number
  mtimeNs: string
  /** Content hash; `null` above {@link HASH_LIMIT_BYTES} (size+mtime is the fallback). */
  hash: string | null
}

const HASH_LIMIT_BYTES = 2 * 1024 * 1024

/**
 * Fingerprint a path, or `null` when it is absent or not a regular file.
 * @param path - absolute path.
 * @returns the current fingerprint, or `null` for absent/non-file.
 */
export async function fingerprint(path: string): Promise<FileFingerprint | null> {
  try {
    const stat = await fs.stat(path, { bigint: true })
    if (!stat.isFile()) return null
    const size = Number(stat.size)
    const hash = size <= HASH_LIMIT_BYTES
      ? createHash('sha256').update(await fs.readFile(path)).digest('hex')
      : null
    return { size, mtimeNs: stat.mtimeNs.toString(), hash }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Compare two fingerprints. Content hash wins when both sides have one; big
 * files fall back to size+mtime, which is the only signal Node's stat offers.
 * @param a - recorded fingerprint.
 * @param b - current fingerprint.
 * @returns whether the file still looks the same.
 */
export function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  if (a.hash !== null && b.hash !== null) return a.hash === b.hash
  return a.size === b.size && a.mtimeNs === b.mtimeNs
}

/**
 * Per-session memory of the last observed state of each file. `undefined` from
 * {@link SnapshotStore.get} means "never observed"; `null` means "observed
 * absent", which only allows a create.
 */
export interface SnapshotStore {
  record(key: string, value: FileFingerprint | null): void
  get(key: string): FileFingerprint | null | undefined
  clear(): void
}

export function createSnapshotStore(): SnapshotStore {
  const values = new Map<string, FileFingerprint | null>()
  return {
    record: (key, value) => {
      values.set(key, value)
    },
    get: (key) => values.get(key),
    clear: () => {
      values.clear()
    },
  }
}

/** Snapshot key: session id and canonical path, separated by NUL. */
export function snapshotKey(sessionId: string, path: string): string {
  return `${sessionId}\u0000${path}`
}
