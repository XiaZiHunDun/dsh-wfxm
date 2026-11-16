/**
 * `projects` / `memory_facts` / `memory_edges` store.
 *
 * Single writer is module ⑥ (docs/15 §三), so the DDL lives here rather than in
 * governance. Facts are superseded, never deleted (AR23, 13 §2.3 rule 2).
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import {
  MemoryError,
  type FactEvidence,
  type FactKind,
  type FactScope,
  type FactSource,
  type MemoryFact,
  type PreparedFact,
} from './facts.js'

const MIGRATION_MODULE = 'memory'

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (module)
);
`

const PROJECTS_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  root_path      TEXT NOT NULL,
  rules_doc      TEXT,
  default_expert TEXT,
  created_at     TEXT NOT NULL,
  archived_at    TEXT
);
`

const FACTS_DDL = `
CREATE TABLE IF NOT EXISTS memory_facts (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL CHECK (scope IN ('project','global')),
  project_id       TEXT,
  subject          TEXT NOT NULL,
  predicate        TEXT NOT NULL,
  value_json       TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN
                     ('user-confirmed','observed','inferred','summary')),
  kind             TEXT NOT NULL CHECK (kind IN ('environment','preference')),
  evidence_json    TEXT,
  last_injected_at TEXT,
  confidence       REAL,
  valid_from       TEXT NOT NULL,
  superseded_by    TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_facts_live
  ON memory_facts(scope, project_id, subject, predicate) WHERE superseded_by IS NULL;
`

const EDGES_DDL = `
CREATE TABLE IF NOT EXISTS memory_edges (
  id           TEXT PRIMARY KEY,
  from_fact_id TEXT NOT NULL,
  relation     TEXT NOT NULL,
  to_fact_id   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_edges_from ON memory_edges(from_fact_id, relation);
`

/**
 * v2：项目别名（11 §5.3.1）。`alias` 存小写归一值，主键即保证大小写不敏感的唯一性；
 * 归档不删别名，解析时 join `projects.archived_at IS NULL` 一并失效。
 */
const PROJECT_ALIASES_DDL = `
CREATE TABLE IF NOT EXISTS project_aliases (
  alias       TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_aliases_project ON project_aliases(project_id);
`

interface Migration {
  version: number
  ddl: string[]
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, ddl: [PROJECTS_DDL, FACTS_DDL, EDGES_DDL] },
  { version: 2, ddl: [PROJECT_ALIASES_DDL] },
  {
    version: 3,
    // 15 §10.3 (B4-b): project-level isolation defaults. Existing rows keep
    // `none` / `manual`; the worktree planner still verifies the repo at run time.
    ddl: [
      `ALTER TABLE projects ADD COLUMN vcs TEXT NOT NULL DEFAULT 'none'
         CHECK (vcs IN ('git','none'));`,
      'ALTER TABLE projects ADD COLUMN prepare_cmd TEXT;',
      'ALTER TABLE projects ADD COLUMN worktree_root TEXT;',
      `ALTER TABLE projects ADD COLUMN merge_mode TEXT NOT NULL DEFAULT 'manual'
         CHECK (merge_mode IN ('manual','pr'));`,
    ],
  },
]

export interface Project {
  id: string
  name: string
  rootPath: string
  rulesDoc: string | null
  defaultExpert: string | null
  /** `git` projects are candidates for per-task worktrees; others stay serial. */
  vcs: 'git' | 'none'
  /** Runs once per worktree after checkout (install deps, write .env, …). */
  prepareCmd: string | null
  /** Empty = `<rootPath>/.agents/worktrees`. */
  worktreeRoot: string | null
  mergeMode: 'manual' | 'pr'
  createdAt: string
  archivedAt: string | null
}

export interface UpsertProjectInput {
  name: string
  rootPath: string
  rulesDoc?: string | null
  defaultExpert?: string | null
  vcs?: 'git' | 'none'
  prepareCmd?: string | null
  worktreeRoot?: string | null
  mergeMode?: 'manual' | 'pr'
}

export interface ProjectAlias {
  alias: string
  projectId: string
  createdAt: string
}

export interface MemoryEdge {
  id: string
  fromFactId: string
  relation: string
  toFactId: string
}

export interface FactFilter {
  scope?: FactScope
  /** Exact match on one project's facts (project facts only). */
  projectId?: string
  /**
   * Project-context read (08 §七 #3): this project's facts **plus** global
   * preferences. Never another project's facts.
   */
  forProject?: string
  subject?: string
  predicate?: string
  limit?: number
}

export interface MemoryStore {
  upsertProject(input: UpsertProjectInput): Project
  getProject(id: string): Project | null
  getProjectByName(name: string): Project | null
  listProjects(options?: { includeArchived?: boolean }): Project[]
  archiveProject(id: string, at?: string): boolean
  /** Alias lookup key is case-insensitive; the stored value is lowercased. */
  addProjectAlias(input: { projectId: string; alias: string }): ProjectAlias
  removeProjectAlias(input: { projectId: string; alias: string }): boolean
  listProjectAliases(projectId: string): ProjectAlias[]
  /** Resolve by alias first, then by project name; archived projects never match. */
  resolveProjectAlias(alias: string): Project | null
  /** Unarchived projects for the "which project?" prompt (11 §5.3.1). */
  listProjectChoices(limit?: number): Project[]
  insertFact(fact: PreparedFact): MemoryFact
  /** Mark the old row as replaced; the row itself stays queryable. */
  supersedeFact(oldId: string, newId: string): boolean
  getFact(id: string): MemoryFact | null
  liveFacts(filter?: FactFilter): MemoryFact[]
  /** Record this round's injection; drives the 30-day review candidates (19 D19-4). */
  touchInjected(ids: string[], at?: string): number
  addEdge(input: { fromFactId: string; relation: string; toFactId: string }): MemoryEdge
  edgesOf(factId: string): MemoryEdge[]
  close(): void
}

interface ProjectRow {
  id: string
  name: string
  root_path: string
  rules_doc: string | null
  default_expert: string | null
  vcs: 'git' | 'none'
  prepare_cmd: string | null
  worktree_root: string | null
  merge_mode: 'manual' | 'pr'
  created_at: string
  archived_at: string | null
}

interface AliasRow {
  alias: string
  project_id: string
  created_at: string
}

interface FactRow {
  id: string
  scope: FactScope
  project_id: string | null
  subject: string
  predicate: string
  value_json: string
  source: FactSource
  kind: FactKind
  evidence_json: string | null
  last_injected_at: string | null
  confidence: number | null
  valid_from: string
  superseded_by: string | null
  created_at: string
}

interface EdgeRow {
  id: string
  from_fact_id: string
  relation: string
  to_fact_id: string
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    rulesDoc: row.rules_doc,
    defaultExpert: row.default_expert,
    vcs: row.vcs,
    prepareCmd: row.prepare_cmd,
    worktreeRoot: row.worktree_root,
    mergeMode: row.merge_mode,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  }
}

function toFact(row: FactRow): MemoryFact {
  const parsed: unknown = JSON.parse(row.value_json)
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    subject: row.subject,
    predicate: row.predicate,
    value: typeof parsed === 'string' ? parsed : String(parsed),
    source: row.source,
    kind: row.kind,
    evidence: row.evidence_json === null ? null : JSON.parse(row.evidence_json) as FactEvidence,
    confidence: row.confidence,
    lastInjectedAt: row.last_injected_at,
    validFrom: row.valid_from,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
  }
}

function toEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    fromFactId: row.from_fact_id,
    relation: row.relation,
    toFactId: row.to_fact_id,
  }
}

function migrate(db: Database): void {
  db.exec(MIGRATIONS_DDL)
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get(MIGRATION_MODULE) as { version: number | null } | undefined
  const current = row?.version ?? 0

  const pending = MIGRATIONS.filter((migration) => migration.version > current)
  if (pending.length === 0) return

  db.transaction(() => {
    for (const migration of pending) for (const ddl of migration.ddl) db.exec(ddl)
    if (current < 3) {
      // v3 defaults `vcs` to `none`; existing git projects should not need a
      // manual re-upsert just to become worktree candidates.
      const update = db.prepare('UPDATE projects SET vcs = ? WHERE id = ?')
      const rows = db.prepare('SELECT id, root_path FROM projects').all() as Array<{ id: string; root_path: string }>
      for (const project of rows) {
        if (existsSync(join(project.root_path, '.git'))) update.run('git', project.id)
      }
    }
    const latest = pending[pending.length - 1].version
    if (current === 0) {
      db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
        MIGRATION_MODULE,
        latest,
        new Date().toISOString(),
      )
    } else {
      db.prepare(
        'UPDATE schema_migrations SET version = ?, applied_at = ? WHERE module = ?',
      ).run(latest, new Date().toISOString(), MIGRATION_MODULE)
    }
  }).immediate()
}

export function createMemoryStore(dbPath: string): MemoryStore {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const insertProject = db.prepare(`
    INSERT INTO projects(
      id, name, root_path, rules_doc, default_expert, vcs, prepare_cmd, worktree_root,
      merge_mode, created_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `)
  const updateProject = db.prepare(`
    UPDATE projects
       SET root_path = ?, rules_doc = ?, default_expert = ?, vcs = ?, prepare_cmd = ?,
           worktree_root = ?, merge_mode = ?, archived_at = NULL
     WHERE id = ?
  `)
  const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?')
  const selectProjectByName = db.prepare('SELECT * FROM projects WHERE name = ?')
  const listProjectsAll = db.prepare('SELECT * FROM projects ORDER BY created_at ASC, rowid ASC')
  const listProjectsLive = db.prepare(
    'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC, rowid ASC',
  )
  const archiveProjectStmt = db.prepare(
    'UPDATE projects SET archived_at = ? WHERE id = ? AND archived_at IS NULL',
  )
  const selectProjectByNameInsensitive = db.prepare(
    'SELECT * FROM projects WHERE name = ? COLLATE NOCASE AND archived_at IS NULL LIMIT 1',
  )
  const selectAlias = db.prepare('SELECT * FROM project_aliases WHERE alias = ?')
  const insertAlias = db.prepare(
    'INSERT INTO project_aliases(alias, project_id, created_at) VALUES (?, ?, ?)',
  )
  const deleteAlias = db.prepare('DELETE FROM project_aliases WHERE alias = ? AND project_id = ?')
  const listAliasesByProject = db.prepare(
    'SELECT * FROM project_aliases WHERE project_id = ? ORDER BY alias ASC',
  )
  const resolveAliasStmt = db.prepare(`
    SELECT p.* FROM project_aliases a
    JOIN projects p ON p.id = a.project_id
    WHERE a.alias = ? AND p.archived_at IS NULL
  `)
  const listChoicesStmt = db.prepare(
    'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC, rowid ASC LIMIT ?',
  )

  const insertFactStmt = db.prepare(`
    INSERT INTO memory_facts(
      id, scope, project_id, subject, predicate, value_json, source, kind,
      evidence_json, last_injected_at, confidence, valid_from, superseded_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)
  `)
  const selectFact = db.prepare('SELECT * FROM memory_facts WHERE id = ?')
  const supersedeStmt = db.prepare(
    'UPDATE memory_facts SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL',
  )
  const touchStmt = db.prepare(
    'UPDATE memory_facts SET last_injected_at = ? WHERE id = ? AND superseded_by IS NULL',
  )

  const insertEdgeStmt = db.prepare(
    'INSERT INTO memory_edges(id, from_fact_id, relation, to_fact_id) VALUES (?, ?, ?, ?)',
  )
  const edgesOfStmt = db.prepare(
    'SELECT * FROM memory_edges WHERE from_fact_id = ? ORDER BY rowid ASC',
  )

  return {
    upsertProject(input) {
      const existing = selectProjectByName.get(input.name) as ProjectRow | undefined
      // Detect a git checkout once, so callers do not have to repeat it. An
      // explicit `vcs` still wins; existing rows keep their stored value unless
      // the caller overrides it.
      const detectedVcs: 'git' | 'none' =
        input.vcs ?? (existsSync(join(input.rootPath, '.git')) ? 'git' : 'none')
      if (existing === undefined) {
        const row: ProjectRow = {
          id: randomUUID(),
          name: input.name,
          root_path: input.rootPath,
          rules_doc: input.rulesDoc ?? null,
          default_expert: input.defaultExpert ?? null,
          vcs: detectedVcs,
          prepare_cmd: input.prepareCmd ?? null,
          worktree_root: input.worktreeRoot ?? null,
          merge_mode: input.mergeMode ?? 'manual',
          created_at: new Date().toISOString(),
          archived_at: null,
        }
        insertProject.run(
          row.id,
          row.name,
          row.root_path,
          row.rules_doc,
          row.default_expert,
          row.vcs,
          row.prepare_cmd,
          row.worktree_root,
          row.merge_mode,
          row.created_at,
        )
        return toProject(row)
      }
      updateProject.run(
        input.rootPath,
        input.rulesDoc === undefined ? existing.rules_doc : input.rulesDoc,
        input.defaultExpert === undefined ? existing.default_expert : input.defaultExpert,
        input.vcs ?? existing.vcs,
        input.prepareCmd === undefined ? existing.prepare_cmd : input.prepareCmd,
        input.worktreeRoot === undefined ? existing.worktree_root : input.worktreeRoot,
        input.mergeMode ?? existing.merge_mode,
        existing.id,
      )
      return toProject(selectProject.get(existing.id) as ProjectRow)
    },
    getProject(id) {
      const row = selectProject.get(id) as ProjectRow | undefined
      return row === undefined ? null : toProject(row)
    },
    getProjectByName(name) {
      const row = selectProjectByName.get(name) as ProjectRow | undefined
      return row === undefined ? null : toProject(row)
    },
    listProjects(options) {
      const rows = (options?.includeArchived === true ? listProjectsAll : listProjectsLive)
        .all() as ProjectRow[]
      return rows.map(toProject)
    },
    archiveProject(id, at) {
      return archiveProjectStmt.run(at ?? new Date().toISOString(), id).changes > 0
    },
    addProjectAlias(input) {
      const alias = input.alias.trim().toLowerCase()
      if (alias === '') throw new MemoryError('invalid-fact', 'alias must not be empty')
      const project = selectProject.get(input.projectId) as ProjectRow | undefined
      if (project === undefined) throw new MemoryError('not-found', `project ${input.projectId} not found`)

      const existing = selectAlias.get(alias) as AliasRow | undefined
      if (existing !== undefined) {
        if (existing.project_id === input.projectId) {
          return { alias: existing.alias, projectId: existing.project_id, createdAt: existing.created_at }
        }
        throw new MemoryError('conflict', `alias ${alias} already belongs to another project`)
      }
      // 别名不得遮蔽另一个项目的真名，否则解析会出现两个都说得通的答案。
      const shadowed = selectProjectByNameInsensitive.get(alias) as ProjectRow | undefined
      if (shadowed !== undefined && shadowed.id !== input.projectId) {
        throw new MemoryError('conflict', `alias ${alias} shadows project ${shadowed.name}`)
      }

      const createdAt = new Date().toISOString()
      insertAlias.run(alias, input.projectId, createdAt)
      return { alias, projectId: input.projectId, createdAt }
    },
    removeProjectAlias(input) {
      return deleteAlias.run(input.alias.trim().toLowerCase(), input.projectId).changes > 0
    },
    listProjectAliases(projectId) {
      return (listAliasesByProject.all(projectId) as AliasRow[]).map((row) => ({
        alias: row.alias,
        projectId: row.project_id,
        createdAt: row.created_at,
      }))
    },
    resolveProjectAlias(alias) {
      const key = alias.trim().toLowerCase()
      if (key === '') return null
      const byAlias = resolveAliasStmt.get(key) as ProjectRow | undefined
      if (byAlias !== undefined) return toProject(byAlias)
      const byName = selectProjectByNameInsensitive.get(key) as ProjectRow | undefined
      return byName === undefined ? null : toProject(byName)
    },
    listProjectChoices(limit) {
      const rows = listChoicesStmt.all(limit ?? 5) as ProjectRow[]
      return rows.map(toProject)
    },
    insertFact(fact) {
      const record: MemoryFact = {
        id: randomUUID(),
        scope: fact.scope,
        projectId: fact.projectId,
        subject: fact.subject,
        predicate: fact.predicate,
        value: fact.value,
        source: fact.source,
        kind: fact.kind,
        evidence: fact.evidence,
        confidence: fact.confidence,
        lastInjectedAt: null,
        validFrom: fact.validFrom,
        supersededBy: null,
        createdAt: new Date().toISOString(),
      }
      insertFactStmt.run(
        record.id,
        record.scope,
        record.projectId,
        record.subject,
        record.predicate,
        JSON.stringify(record.value),
        record.source,
        record.kind,
        record.evidence === null ? null : JSON.stringify(record.evidence),
        record.confidence,
        record.validFrom,
        record.createdAt,
      )
      return record
    },
    supersedeFact(oldId, newId) {
      if (oldId === newId) return false
      return supersedeStmt.run(newId, oldId).changes > 0
    },
    getFact(id) {
      const row = selectFact.get(id) as FactRow | undefined
      return row === undefined ? null : toFact(row)
    },
    liveFacts(filter) {
      const clauses = ['superseded_by IS NULL']
      const params: unknown[] = []
      if (filter?.scope !== undefined) {
        clauses.push('scope = ?')
        params.push(filter.scope)
      }
      if (filter?.projectId !== undefined) {
        clauses.push('project_id = ?')
        params.push(filter.projectId)
      }
      if (filter?.forProject !== undefined) {
        // 项目上下文 = 全局偏好 ∪ 本项目事实；其他项目的行不出现。
        clauses.push("(scope = 'global' OR (scope = 'project' AND project_id = ?))")
        params.push(filter.forProject)
      }
      if (filter?.subject !== undefined) {
        clauses.push('subject = ?')
        params.push(filter.subject)
      }
      if (filter?.predicate !== undefined) {
        clauses.push('predicate = ?')
        params.push(filter.predicate)
      }
      const rawLimit = filter?.limit
      if (rawLimit !== undefined) params.push(Math.max(1, Math.floor(rawLimit)))
      const limitClause = rawLimit === undefined ? '' : ' LIMIT ?'
      const rows = db
        .prepare(`SELECT * FROM memory_facts WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, rowid ASC${limitClause}`)
        .all(...params) as FactRow[]
      return rows.map(toFact)
    },
    touchInjected(ids, at) {
      if (ids.length === 0) return 0
      const stamp = at ?? new Date().toISOString()
      return db.transaction(() => {
        let touched = 0
        for (const id of ids) touched += touchStmt.run(stamp, id).changes
        return touched
      })()
    },
    addEdge(input) {
      const edge: MemoryEdge = { id: randomUUID(), ...input }
      insertEdgeStmt.run(edge.id, edge.fromFactId, edge.relation, edge.toFactId)
      return edge
    },
    edgesOf(factId) {
      return (edgesOfStmt.all(factId) as EdgeRow[]).map(toEdge)
    },
    close() {
      db.close()
    },
  }
}
