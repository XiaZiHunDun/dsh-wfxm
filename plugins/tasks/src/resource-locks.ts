/**
 * Resource leases (B4-b Phase 3, 11 §14.6 / 15 §10.4).
 *
 * Non-file resources (ports, databases, systemd units, docker projects, git
 * merges) are outside the worktree's reach, so they are serialised by a row in
 * `resource_locks`. Keys are normalised here — callers never write raw text into
 * the table — and multi-key acquisition is all-or-nothing (15 §10.4).
 *
 * This slice only ships the table + API. Nothing acquires locks automatically
 * yet: a task plan does not declare resources, so task behaviour is unchanged.
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { TaskError, type Json } from './model.js'
import type { ResourceLock, TaskStore } from './store.js'

/** Task lease is 60s; resources default to a longer window with heartbeat. */
export const DEFAULT_RESOURCE_TTL_SEC = 300
export const MAX_RESOURCE_TTL_SEC = 86_400

const PORT_PROTO = /^[a-z][a-z0-9]*$/
const UNIT_NAME = /^[A-Za-z0-9@._:-]+$/
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function invalid(message: string): TaskError {
  return new TaskError('invalid-input', message)
}

function absolutePath(raw: string, key: string): string {
  const path = isAbsolute(raw) ? raw : resolve(raw)
  try {
    return realpathSync(path)
  } catch {
    throw invalid(`${key} path does not exist: ${path}`)
  }
}

/**
 * `resource_key` 规范化（15 §10.4）. Unknown prefixes and malformed values are
 * rejected instead of guessed; the returned form is the only form written.
 */
export function normalizeResourceKey(raw: string): string {
  if (typeof raw !== 'string') throw invalid('resource key must be a string')
  const key = raw.trim()
  if (key === '') throw invalid('resource key must not be empty')
  const at = key.indexOf(':')
  if (at <= 0) throw invalid(`resource key needs a <prefix>:<value> form: ${JSON.stringify(raw)}`)
  const prefix = key.slice(0, at)
  const rest = key.slice(at + 1)
  if (rest === '') throw invalid(`resource key ${prefix}: has no value`)

  if (prefix === 'port') {
    const parts = rest.split(':')
    if (parts.length !== 2) throw invalid(`port key needs port:<proto>:<port>: ${key}`)
    const proto = parts[0].toLowerCase()
    if (!PORT_PROTO.test(proto)) throw invalid(`invalid port protocol: ${parts[0]}`)
    if (!/^\d{1,5}$/.test(parts[1])) throw invalid(`invalid port number: ${parts[1]}`)
    const port = Number(parts[1])
    if (port < 1 || port > 65_535) throw invalid(`port out of range: ${parts[1]}`)
    return `port:${proto}:${port}`
  }

  if (prefix === 'db') {
    const path = absolutePath(rest, 'db')
    return `db:${join(dirname(path), basename(path).toLowerCase())}`
  }

  if (prefix === 'unit') {
    if (!UNIT_NAME.test(rest)) throw invalid(`invalid unit name (no wildcards or spaces): ${rest}`)
    return `unit:${rest}`
  }

  if (prefix === 'docker') {
    if (!DOCKER_NAME.test(rest)) throw invalid(`invalid docker project name: ${rest}`)
    return `docker:${rest.toLowerCase()}`
  }

  if (prefix === 'git') {
    const path = absolutePath(rest, 'git')
    const isRepo = (() => {
      try {
        realpathSync(join(path, '.git'))
        return true
      } catch {
        return false
      }
    })()
    if (!isRepo) throw invalid(`git resource is not a repository root: ${path}`)
    return `git:${path}`
  }

  throw invalid(`unknown resource prefix: ${prefix}`)
}

/** Deduplicate and sort so multi-key acquisition always uses one lock order. */
export function normalizeResourceKeys(keys: readonly string[]): string[] {
  if (!Array.isArray(keys) || keys.length === 0) throw invalid('keys must not be empty')
  const normalized = keys.map(normalizeResourceKey)
  return [...new Set(normalized)].sort()
}

/**
 * Plan-declared resources (`task.plan.resources`, Slice Y). Absent/null/empty
 * means "no declared non-file resources", which keeps the serial fallback.
 */
export function declaredResources(plan: Json | null): string[] {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return []
  const raw = (plan as { resources?: Json }).resources
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw invalid('plan.resources must be an array of strings')
  if (raw.length === 0) return []
  const keys: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') throw invalid('plan.resources must be an array of strings')
    keys.push(entry)
  }
  return normalizeResourceKeys(keys)
}

export interface ResourceLockConflict {
  key: string
  taskId: string
  leaseExpiresAt: string
}

export interface ResourceLockGrant {
  lockIds: string[]
  keys: string[]
  expiresAt: string
}

export type ResourceLockAcquireResult =
  | { state: 'acquired'; grant: ResourceLockGrant }
  | { state: 'conflict'; blocking: ResourceLockConflict[]; expiresAt: string }

export interface ResourceLockHeartbeat {
  extended: number
  lost: string[]
  expiresAt: string
}

export interface ResourceLockServiceOptions {
  store: TaskStore
  now?: () => Date
  ttlSec?: number
}

export interface ResourceLockService {
  /**
   * Acquire every key or none. Contention is a `conflict` result (the caller
   * parks the task), never an exception: 15 §10.4 / 11 §14.7 验收 #5.
   */
  acquire(input: {
    taskId: string
    keys: readonly string[]
    ttlSec?: number
    owner?: string | null
  }): ResourceLockAcquireResult
  heartbeat(input: { lockIds: readonly string[]; ttlSec?: number }): ResourceLockHeartbeat
  /** Idempotent: already released ids are ignored, never an error. */
  release(lockIds: readonly string[]): { released: number }
  /** Lifecycle tie-in: a settled task drops every lease it still holds. */
  releaseByTask(taskId: string): { released: number }
  list(filter?: { taskId?: string; includeReleased?: boolean }): ResourceLock[]
}

function checkTtl(raw: number | undefined, fallback: number): number {
  const ttl = raw ?? fallback
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_RESOURCE_TTL_SEC) {
    throw invalid(`ttlSec must be an integer within 1..${MAX_RESOURCE_TTL_SEC} (got ${ttl})`)
  }
  return ttl
}

export function createResourceLockService(options: ResourceLockServiceOptions): ResourceLockService {
  const { store } = options
  const now = options.now ?? (() => new Date())
  const defaultTtl = options.ttlSec ?? DEFAULT_RESOURCE_TTL_SEC

  return {
    acquire(input) {
      const ttlSec = checkTtl(input.ttlSec, defaultTtl)
      const result = store.acquireResourceLocks({
        taskId: input.taskId,
        keys: input.keys,
        ttlSec,
        owner: input.owner ?? null,
        now: now(),
      })
      if (result.acquired.length === 0) {
        return { state: 'conflict', blocking: result.conflicts, expiresAt: result.expiresAt }
      }
      return {
        state: 'acquired',
        grant: {
          lockIds: result.acquired.map((lock) => lock.id),
          keys: result.acquired.map((lock) => lock.resourceKey),
          expiresAt: result.expiresAt,
        },
      }
    },
    heartbeat(input) {
      const ttlSec = checkTtl(input.ttlSec, defaultTtl)
      if (input.lockIds.length === 0) throw invalid('lockIds must not be empty')
      const at = now()
      const result = store.heartbeatResourceLocks({
        lockIds: [...input.lockIds],
        ttlSec,
        now: at,
      })
      const live = new Set(result.liveIds)
      return {
        extended: result.extended,
        lost: input.lockIds.filter((id) => !live.has(id)),
        expiresAt: result.expiresAt,
      }
    },
    release(lockIds) {
      return { released: store.releaseResourceLocks([...lockIds], now()) }
    },
    releaseByTask(taskId) {
      return { released: store.releaseTaskResourceLocks(taskId, now()) }
    },
    list(filter) {
      return store.listResourceLocks({ ...filter, now: now() })
    },
  }
}
