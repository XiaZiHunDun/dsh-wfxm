/**
 * Project resolution for the single foreground window (11 §5.3.1).
 *
 * One Feishu window drives N projects, but assembly may only load one project's
 * context (13 §2.2), so every inbound message must answer "which project?".
 *
 * Signal order, first hit wins:
 *   explicit (`/use <alias>`) → reply anchor → chat stickiness → single project → ask
 *
 * There is deliberately no text guessing: the resolver never inspects the
 * message body (13 §3.3 硬规则). Module ① also never reads ⑥'s tables — the
 * lookup is injected (`ProjectLookupPort`), same pattern as `TaskRelayPort`.
 */

import type { ProjectMatchedBy } from './model.js'

export interface ProjectChoice {
  projectId: string
  name: string
}

/** Host-composed read onto ⑥'s project API (AR33: contract, not tables). */
export interface ProjectLookupPort {
  /** Alias first, then real name; archived projects never match. */
  resolveAlias(alias: string): ProjectChoice | null
  /** Unarchived projects, for the "which project?" prompt. */
  listProjects(limit?: number): ProjectChoice[]
}

export const PROJECT_CHOICE_LIMIT = 5

export interface ProjectResolution {
  /** False when ⑥ is not mounted; callers fail soft. */
  available: boolean
  projectId: string | null
  name: string | null
  matchedBy: ProjectMatchedBy | null
  /** More than one candidate and no usable signal: ask instead of guessing. */
  ambiguous: boolean
  candidates: ProjectChoice[]
}

export interface ResolveProjectInput {
  port?: ProjectLookupPort | null
  /** Alias from an explicit `/use` command. */
  explicitAlias?: string | null
  /** Project of the task this message replies to (⑤ v4 anchor). */
  anchorProjectId?: string | null
  /** Project this chat last used (sticky). */
  stickyProjectId?: string | null
}

const EMPTY: ProjectResolution = {
  available: false,
  projectId: null,
  name: null,
  matchedBy: null,
  ambiguous: false,
  candidates: [],
}

function ask(candidates: ProjectChoice[], available: boolean): ProjectResolution {
  return {
    available,
    projectId: null,
    name: null,
    matchedBy: 'asked',
    ambiguous: true,
    candidates,
  }
}

function hit(
  projectId: string,
  name: string | null,
  matchedBy: ProjectMatchedBy,
  available: boolean,
): ProjectResolution {
  return {
    available,
    projectId,
    name,
    matchedBy,
    ambiguous: false,
    candidates: [{ projectId, name: name ?? projectId }],
  }
}

function nameOf(port: ProjectLookupPort | null, projectId: string): string | null {
  if (port === null) return null
  const found = port.listProjects(PROJECT_CHOICE_LIMIT * 4).find((p) => p.projectId === projectId)
  return found?.name ?? null
}

/** Deterministic resolution with no semantic inference (11 §5.3.1). */
export function resolveProject(input: ResolveProjectInput): ProjectResolution {
  const port = input.port ?? null
  const available = port !== null

  // 1. Explicit: the only path that mutates stickiness is `/use`.
  if (input.explicitAlias !== undefined && input.explicitAlias !== null) {
    const alias = input.explicitAlias.trim()
    if (alias === '') return ask(port === null ? [] : port.listProjects(PROJECT_CHOICE_LIMIT), available)
    if (port === null) return { ...EMPTY, matchedBy: 'asked', ambiguous: true }
    const found = port.resolveAlias(alias)
    if (found === null) return ask(port.listProjects(PROJECT_CHOICE_LIMIT), available)
    return hit(found.projectId, found.name, 'explicit', true)
  }

  // 2. Reply anchor: the task already froze its project at submit time.
  if (input.anchorProjectId !== undefined && input.anchorProjectId !== null) {
    return hit(input.anchorProjectId, nameOf(port, input.anchorProjectId), 'anchor', available)
  }

  // 3. Stickiness: this chat's last explicit choice.
  if (input.stickyProjectId !== undefined && input.stickyProjectId !== null) {
    return hit(input.stickyProjectId, nameOf(port, input.stickyProjectId), 'sticky', available)
  }

  // 4. Only one project on the box: use it, but say so.
  // Without ⑥ we cannot know the projects: fail soft to a project-agnostic turn
  // (global preferences only) instead of asking on every message.
  if (port === null) return { ...EMPTY }
  const projects = port.listProjects(PROJECT_CHOICE_LIMIT)
  if (projects.length === 0) return { ...EMPTY, available: true }
  if (projects.length === 1) {
    return hit(projects[0].projectId, projects[0].name, 'single', true)
  }

  // 5. Never guess between projects.
  return ask(projects, true)
}

/** Candidates for an explicit `/projects` listing (never auto-selects). */
export function listProjectChoices(port?: ProjectLookupPort | null): ProjectChoice[] {
  return port === null || port === undefined ? [] : port.listProjects(PROJECT_CHOICE_LIMIT)
}

export type ProjectCommand =
  | { kind: 'use'; alias: string }
  | { kind: 'list' }

const USE_PATTERN = /^\/(?:use|switch)\s+(.+)$/i
const LIST_PATTERN = /^\/projects?$/i

/**
 * Explicit commands only. Slash-prefixed, so nothing here depends on natural
 * language; an unknown `/x` is not a project command and falls through to the
 * normal command intent.
 */
export function parseProjectCommand(text: string | null | undefined): ProjectCommand | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (LIST_PATTERN.test(trimmed)) return { kind: 'list' }
  const match = USE_PATTERN.exec(trimmed)
  if (match !== null) {
    const alias = match[1].trim()
    if (alias !== '') return { kind: 'use', alias }
  }
  return null
}
