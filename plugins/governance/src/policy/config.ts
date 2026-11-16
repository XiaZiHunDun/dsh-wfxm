import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'

const PolicySchema = z.object({
  version: z.number().int().positive(),
  killSwitchFile: z.string().default('KILL'),
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

export type Policy = z.infer<typeof PolicySchema> & {
  /** Absolute kill-switch path resolved against the policy file directory. */
  killSwitchPath: string
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
}

export function policyPath(): string {
  return process.env.DSH_WFXM_POLICY ?? join(repoRoot(), 'config', 'policy.yaml')
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
  return {
    ...parsed,
    writeRoots,
    readRoots: parsed.readRoots.map((item) => resolve(item)),
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
      : resolve(dirname(path), parsed.killSwitchFile),
  }
}
