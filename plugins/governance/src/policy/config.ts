import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'

const PolicySchema = z.object({
  version: z.number().int().positive(),
  killSwitchFile: z.string().default('KILL'),
  /**
   * E3 项目级授权：按 project_id 的工具白名单文件，路径相对 policy.yaml。
   * 文件缺失 = 不限制（向后兼容）；格式错误 = fail-closed。
   */
  projectToolsFile: z.string().default('project-tools.json'),
  writeRoots: z.array(z.string()).default([]),
  readRoots: z.array(z.string()).default([]),
  bash: z
    .object({
      denyPatterns: z.array(z.string()).default([]),
    })
    .default({ denyPatterns: [] }),
  concurrency: z
    .object({
      writeSerialization: z.boolean().default(true),
      conflictLimit: z.number().int().positive().default(3),
    })
    .default({ writeSerialization: true, conflictLimit: 3 }),
  preimages: z
    .object({
      /** Capture the previous bytes of every file a write tool is about to touch. */
      enabled: z.boolean().default(true),
      /** Roots a pre-image may read; empty means "same as writeRoots". */
      roots: z.array(z.string()).default([]),
      /** Above this many bytes the pre-image is spilled to `contentDir`. */
      inlineLimit: z.number().int().positive().default(1_048_576),
      contentDir: z.string().optional(),
    })
    .default({ enabled: true, roots: [], inlineLimit: 1_048_576 }),
})

/** E3：某项目（或缺省）允许调用的工具；`*` 前缀通配（如 `exec_*`）。 */
export interface ProjectToolPolicy {
  /** 没有登记的项目落到这份清单；null = 不限制。 */
  default: string[] | null
  projects: Record<string, string[]>
}

export type Policy = z.infer<typeof PolicySchema> & {
  /** Absolute kill-switch path resolved against the policy file directory. */
  killSwitchPath: string
  /** null = 白名单文件不存在，E3 不生效。 */
  projectTools: ProjectToolPolicy | null
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
}

export function policyPath(): string {
  return process.env.DSH_WFXM_POLICY ?? join(repoRoot(), 'config', 'policy.yaml')
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new Error(`governance policy: ${label} must be an array of non-empty strings`)
  }
  return value
}

/**
 * Load `project-tools.json`. A missing file disables E3 (the pre-E3 behaviour);
 * a malformed file aborts mounting rather than silently allowing everything.
 */
export function loadProjectTools(path: string): ProjectToolPolicy | null {
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('governance policy: project-tools must be a JSON object')
  }
  const fallback = parsed.default
  const projectsRaw = parsed.projects ?? {}
  if (typeof projectsRaw !== 'object' || projectsRaw === null || Array.isArray(projectsRaw)) {
    throw new Error('governance policy: project-tools.projects must be an object')
  }
  const projects: Record<string, string[]> = {}
  for (const [projectId, value] of Object.entries(projectsRaw)) {
    projects[projectId] = stringList(value, `project-tools.projects.${projectId}`)
  }
  return {
    default: fallback === undefined ? null : stringList(fallback, 'project-tools.default'),
    projects,
  }
}

/**
 * Load the policy file. A missing file disables gating (development
 * convenience); a malformed file is fail-closed and aborts plugin mounting.
 */
export function loadPolicy(): Policy | null {
  const path = policyPath()
  if (!existsSync(path)) return null
  const parsed = PolicySchema.parse(parse(readFileSync(path, 'utf8')))
  const writeRoots = parsed.writeRoots.map((item) => resolve(item))
  const configDir = dirname(path)
  const projectToolsPath = isAbsolute(parsed.projectToolsFile)
    ? parsed.projectToolsFile
    : resolve(configDir, parsed.projectToolsFile)
  return {
    ...parsed,
    writeRoots,
    readRoots: parsed.readRoots.map((item) => resolve(item)),
    projectTools: loadProjectTools(projectToolsPath),
    preimages: {
      ...parsed.preimages,
      roots: (parsed.preimages.roots.length > 0 ? parsed.preimages.roots : writeRoots)
        .map((item) => resolve(item)),
      contentDir: parsed.preimages.contentDir === undefined
        ? undefined
        : resolve(parsed.preimages.contentDir),
    },
    killSwitchPath: isAbsolute(parsed.killSwitchFile)
      ? parsed.killSwitchFile
      : resolve(configDir, parsed.killSwitchFile),
  }
}
