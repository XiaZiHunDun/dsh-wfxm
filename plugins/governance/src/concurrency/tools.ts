import { resolve } from 'node:path'

/** Tools whose whole purpose is a file mutation. */
export const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
/** Tools that show a file to the model and therefore establish a snapshot. */
export const FILE_READ_TOOLS = new Set(['read'])

/**
 * Extract the file argument of a file tool.
 * @param toolName - host tool name.
 * @param args - model arguments.
 * @returns the requested path, or `null` when this call is not a file tool.
 */
export function requestedPath(toolName: string, args: unknown): string | null {
  if (!FILE_WRITE_TOOLS.has(toolName) && !FILE_READ_TOOLS.has(toolName)) return null
  if (typeof args !== 'object' || args === null) return null
  for (const key of ['file_path', 'path', 'target']) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * Resolve a requested path against the session workspace, matching tool-fs
 * semantics (relative paths stay inside the workspace, absolute paths escape).
 * @param workspace - effective session directory, when known.
 * @param requested - path as the model wrote it.
 * @returns absolute path used as the snapshot/lock identity.
 */
export function resolveTarget(workspace: string | undefined, requested: string): string {
  return resolve(workspace ?? process.cwd(), requested)
}

interface AgentLike {
  id?: string
  session?: { header?: { cwd?: string } }
}

interface WorkingDirectoryLike {
  get(session: unknown): string
}

/**
 * Effective session workspace root. Prefers the working-directory projection
 * (a session may `cd` after creation) and falls back to the immutable header.
 * @param ctx - plugin context carrying the optional `workingDirectory` service.
 * @param agent - calling agent, when the call is agent-scoped.
 * @returns absolute workspace root, or `undefined` for non-agent calls.
 */
export function sessionWorkspace(ctx: unknown, agent: unknown): string | undefined {
  const session = (agent as AgentLike | undefined)?.session
  if (session === undefined) return undefined
  const service = (ctx as { workingDirectory?: WorkingDirectoryLike } | undefined)?.workingDirectory
  if (service !== undefined && typeof service.get === 'function') {
    try {
      return service.get(session)
    } catch {
      // Fall through to the durable header.
    }
  }
  return session.header?.cwd
}

/**
 * Stable per-session identity used to scope snapshots and conflict counters.
 * @param agent - calling agent, when known.
 * @returns session id, or a shared bucket for non-agent calls.
 */
export function sessionIdentity(agent: unknown): string {
  const id = (agent as AgentLike | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? id : 'anonymous'
}
