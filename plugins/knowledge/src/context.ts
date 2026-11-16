/**
 * Assembly point for module ⑥ (11 §5.3.1 片 3, 13 §2.2).
 *
 * Two things live here, both read-only:
 *   1. `createProjectLookupPort` — the real adapter ① consumes. It exposes only
 *      the two reads `ProjectLookupPort` needs, so ① never touches ⑥'s tables
 *      (AR33), and the shape is structural rather than a shared package type
 *      (AR32: 端口契约与实现无关).
 *   2. `projectMemoryContext` — what one turn may load into its prompt:
 *      global facts ∪ this project's facts, never another project's rows.
 *      It also returns a content fingerprint so a repeated cold-boundary
 *      injection can be skipped (13 §2.3 防重).
 *
 * This module decides *what is allowed in*; the host decides how to render it.
 * Ordering / truncation / weighting of the digest stay in the assembly layer.
 */

import { createHash } from 'node:crypto'
import { MemoryError, type MemoryFact } from './facts.js'
import type { MemoryStore, Project } from './store.js'

export interface ProjectChoice {
  projectId: string
  name: string
}

/** Structural twin of ①'s `ProjectLookupPort`. */
export interface ProjectLookupPort {
  /** Alias first, then real name; archived projects never match. */
  resolveAlias(alias: string): ProjectChoice | null
  /** Unarchived projects, for the "which project?" prompt. */
  listProjects(limit?: number): ProjectChoice[]
}

export const PROJECT_CHOICE_LIMIT = 5

export function createProjectLookupPort(store: MemoryStore): ProjectLookupPort {
  return {
    resolveAlias(alias) {
      if (typeof alias !== 'string' || alias.trim() === '') return null
      const project = store.resolveProjectAlias(alias.trim())
      return project === null ? null : { projectId: project.id, name: project.name }
    },
    listProjects(limit = PROJECT_CHOICE_LIMIT) {
      return store.listProjectChoices(limit).map((project) => ({
        projectId: project.id,
        name: project.name,
      }))
    },
  }
}

export interface ProjectContextInput {
  /** The project this turn was bound to; null / absent = no project context. */
  projectId?: string | null
  /** Hard cap for the assembly layer; omitted = no cap here. */
  limit?: number
  /** Stamp `last_injected_at` so 19 D19-4 review candidates can fire later. */
  touch?: boolean
  at?: Date
}

export interface ProjectContext {
  projectId: string | null
  project: Project | null
  /** Global facts ∪ this project's facts (global only without a project). */
  facts: MemoryFact[]
  /** Stable hash of the injected fact versions (13 §2.3 防重). */
  fingerprint: string
  /** Set only when `touch` recorded this round's injection. */
  injectedAt: string | null
}

/**
 * Project-scoped assembly read (08 §七 #3).
 *
 * An unknown or archived project is refused instead of silently falling back to
 * global: falling back would answer with the wrong scope and look like success.
 */
export function projectMemoryContext(
  store: MemoryStore,
  input: ProjectContextInput = {},
): ProjectContext {
  const projectId = input.projectId ?? null
  let project: Project | null = null
  if (projectId !== null) {
    project = store.getProject(projectId)
    if (project === null || project.archivedAt !== null) {
      throw new MemoryError(
        'not-found',
        `project ${JSON.stringify(projectId)} is unknown or archived`,
      )
    }
  }

  const extra = input.limit === undefined ? {} : { limit: input.limit }
  const facts = projectId === null
    ? store.liveFacts({ scope: 'global', ...extra })
    : store.liveFacts({ forProject: projectId, ...extra })

  let injectedAt: string | null = null
  if (input.touch === true && facts.length > 0) {
    const stamp = (input.at ?? new Date()).toISOString()
    const touched = store.touchInjected(
      facts.map((fact) => fact.id),
      stamp,
    )
    if (touched > 0) injectedAt = stamp
  }

  return {
    projectId,
    project,
    facts,
    fingerprint: fingerprintOf(facts),
    injectedAt,
  }
}

function fingerprintOf(facts: MemoryFact[]): string {
  const material = facts
    .map((fact) => `${fact.id}:${fact.validFrom}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}
