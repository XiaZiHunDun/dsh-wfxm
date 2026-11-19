/**
 * Assertion DSL and static validation (17 §8.1 / §8.4).
 *
 * Eight kinds, parameters only. Every model-generated assertion must pass this
 * whitelist before it can reach `task_assertions`; adding a kind means changing
 * both docs/15's CHECK constraint and this file (17 §8.1).
 */

import { isAbsolute, resolve, sep } from 'node:path'
import { ASSERTION_KINDS, TaskError, type AssertionKind, type JsonObject } from './model.js'

/** Static occurrence cap; stops "assertion spam" from masking a real failure. */
export const MAX_ASSERTIONS = 8
const MAX_TEXT = 500
const MAX_SHORT_TEXT = 200
const MAX_GIT_PATHS = 50

const SHELL_FRAGMENT = /[;&|<>`$\\\r\n]/
const WILDCARD = /[*?[\]{}]/
const CONTROL = /[\u0000-\u001f\u007f]/
const SHA256 = /^[a-f0-9]{64}$/i
const UNIT = /^[A-Za-z0-9@._:-]+$/
const GIT_REF = /^[A-Za-z0-9._/~^-]+$/

export interface AssertionValidationOptions {
  /** Directories a `file_exists.path` must stay inside (site A / B roots). */
  allowedPaths?: readonly string[]
  /** Registered units; unregistered units are refused (17 §8.4 rule 2). */
  allowedUnits?: readonly string[]
  /** Registered ports. */
  allowedPorts?: readonly number[]
  /** Allowlisted hostnames for `http_status` / `page_contains`. */
  allowedHosts?: readonly string[]
  maxAssertions?: number
}

export interface PreparedAssertion {
  kind: AssertionKind
  /** Parameters only; the store keeps `kind` in its own column. */
  spec: JsonObject
}

function invalid(message: string): never {
  throw new TaskError('invalid-assertion', message)
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') invalid(`${field} must not be empty`)
  if (trimmed.length > max) invalid(`${field} exceeds ${max} characters`)
  if (CONTROL.test(trimmed)) invalid(`${field} contains control characters`)
  return trimmed
}

function safeToken(value: unknown, field: string): string {
  const token = text(value, field)
  if (SHELL_FRAGMENT.test(token)) invalid(`${field} contains shell fragments`)
  if (WILDCARD.test(token)) invalid(`${field} contains wildcard expansion`)
  return token
}

function url(value: unknown, field: string): URL {
  const raw = text(value, field)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    invalid(`${field} must be an absolute URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    invalid(`${field} must use http or https`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    invalid(`${field} must not embed credentials`)
  }
  return parsed
}

function port(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    invalid('port must be an integer in 1..65535')
  }
  return value
}

function assertInAllowlist<T>(value: T, allowed: readonly T[] | undefined, field: string): void {
  if (allowed !== undefined && !allowed.includes(value)) {
    invalid(`${field} ${JSON.stringify(value)} is not registered`)
  }
}

function assertInside(path: string, roots: readonly string[] | undefined): void {
  if (roots === undefined || roots.length === 0) return
  const target = resolve(path)
  const ok = roots.some((root) => {
    const base = resolve(root)
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
  })
  if (!ok) invalid(`path ${JSON.stringify(path)} is outside the allowed workspace roots`)
}

function gitPath(value: unknown): string {
  const path = safeToken(value, 'paths[]')
  if (isAbsolute(path)) invalid('git_diff_matches.paths[] must be relative')
  if (path.split('/').includes('..')) invalid('git_diff_matches.paths[] must not escape the repository')
  if (path.length > MAX_SHORT_TEXT) invalid('git_diff_matches.paths[] is too long')
  return path
}

/** Validate one assertion and return its normalized parameters. */
export function prepareAssertion(
  input: unknown,
  options: AssertionValidationOptions = {},
): PreparedAssertion {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('assertion must be an object with a kind')
  }
  const raw = input as Record<string, unknown>
  const kind = raw.kind
  if (typeof kind !== 'string' || !ASSERTION_KINDS.includes(kind as AssertionKind)) {
    invalid(`kind must be one of ${ASSERTION_KINDS.join(' / ')}`)
  }

  switch (kind as AssertionKind) {
    case 'exit_code': {
      const expected = raw.expected
      if (typeof expected !== 'number' || !Number.isInteger(expected)) {
        invalid('exit_code.expected must be an integer')
      }
      return { kind: 'exit_code', spec: { expected } }
    }
    case 'file_exists': {
      const path = text(raw.path, 'file_exists.path')
      if (!isAbsolute(path)) invalid('file_exists.path must be absolute')
      if (SHELL_FRAGMENT.test(path) || WILDCARD.test(path)) {
        invalid('file_exists.path contains shell fragments or wildcards')
      }
      assertInside(path, options.allowedPaths)
      const spec: JsonObject = { path }
      if (raw.sha256 !== undefined) {
        const sha = text(raw.sha256, 'file_exists.sha256')
        if (!SHA256.test(sha)) invalid('file_exists.sha256 must be 64 hex characters')
        spec.sha256 = sha.toLowerCase()
      }
      return { kind: 'file_exists', spec }
    }
    case 'port_listening': {
      const value = port(raw.port)
      assertInAllowlist(value, options.allowedPorts, 'port_listening.port')
      const host = raw.host === undefined ? '127.0.0.1' : text(raw.host, 'port_listening.host')
      if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) invalid('port_listening.host is not a host literal')
      return { kind: 'port_listening', spec: { port: value, host } }
    }
    case 'service_active': {
      const unit = safeToken(raw.unit, 'service_active.unit')
      if (!UNIT.test(unit)) invalid('service_active.unit is not a unit name')
      assertInAllowlist(unit, options.allowedUnits, 'service_active.unit')
      return { kind: 'service_active', spec: { unit } }
    }
    case 'unit_restarted': {
      const unit = safeToken(raw.unit, 'unit_restarted.unit')
      if (!UNIT.test(unit)) invalid('unit_restarted.unit is not a unit name')
      assertInAllowlist(unit, options.allowedUnits, 'unit_restarted.unit')
      return { kind: 'unit_restarted', spec: { unit } }
    }
    case 'http_status': {
      const parsed = url(raw.url, 'http_status.url')
      assertInAllowlist(parsed.hostname.toLowerCase(), options.allowedHosts, 'http_status.url host')
      const expected = raw.expected === undefined ? 200 : raw.expected
      if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 100 || expected > 599) {
        invalid('http_status.expected must be an HTTP status code')
      }
      return { kind: 'http_status', spec: { url: parsed.toString(), expected } }
    }
    case 'git_diff_matches': {
      const ref = safeToken(raw.ref, 'git_diff_matches.ref')
      if (!GIT_REF.test(ref)) invalid('git_diff_matches.ref is not a git revision')
      const expect = raw.expect === undefined ? 'changed' : raw.expect
      if (expect !== 'changed' && expect !== 'unchanged') {
        invalid('git_diff_matches.expect must be changed or unchanged')
      }
      const paths = raw.paths === undefined ? [] : raw.paths
      if (!Array.isArray(paths) || paths.length > MAX_GIT_PATHS) {
        invalid(`git_diff_matches.paths must be an array of at most ${MAX_GIT_PATHS} paths`)
      }
      return { kind: 'git_diff_matches', spec: { ref, paths: paths.map(gitPath), expect } }
    }
    case 'page_contains': {
      const parsed = url(raw.url, 'page_contains.url')
      assertInAllowlist(parsed.hostname.toLowerCase(), options.allowedHosts, 'page_contains.url host')
      const selector = text(raw.selector, 'page_contains.selector', MAX_SHORT_TEXT)
      const expect = text(raw.expect, 'page_contains.expect', MAX_SHORT_TEXT)
      return { kind: 'page_contains', spec: { url: parsed.toString(), selector, expect } }
    }
    case 'mail_archived': {
      // `folder` omitted means "the mail adapter's configured default"
      // (DSH_WFXM_MAIL_ARCHIVE_FOLDER, else Archive); the rule layer must not
      // import the mail package just to read that default.
      const folder = raw.folder === undefined ? undefined : text(raw.folder, 'mail_archived.folder', MAX_SHORT_TEXT)
      const minCount = raw.minCount === undefined ? 1 : raw.minCount
      if (typeof minCount !== 'number' || !Number.isInteger(minCount) || minCount < 1 || minCount > 10_000) {
        invalid('mail_archived.minCount must be an integer in 1..10000')
      }
      const spec: JsonObject = { minCount }
      if (folder !== undefined) spec.folder = folder
      return { kind: 'mail_archived', spec }
    }
  }
  return invalid('unreachable assertion kind')
}

/** Validate a whole set: cap, uniqueness of kind+params, and each item. */
export function prepareAssertions(
  input: unknown,
  options: AssertionValidationOptions = {},
): PreparedAssertion[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) invalid('assertions must be an array')
  const max = options.maxAssertions ?? MAX_ASSERTIONS
  if (input.length > max) invalid(`a task may declare at most ${max} assertions`)
  const seen = new Set<string>()
  return input.map((entry) => {
    const prepared = prepareAssertion(entry, options)
    const key = `${prepared.kind}:${JSON.stringify(prepared.spec)}`
    if (seen.has(key)) invalid(`duplicate assertion ${prepared.kind}`)
    seen.add(key)
    return prepared
  })
}
