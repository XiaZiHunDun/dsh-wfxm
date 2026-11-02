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
  return {
    ...parsed,
    writeRoots: parsed.writeRoots.map((item) => resolve(item)),
    readRoots: parsed.readRoots.map((item) => resolve(item)),
    killSwitchPath: isAbsolute(parsed.killSwitchFile)
      ? parsed.killSwitchFile
      : resolve(dirname(path), parsed.killSwitchFile),
  }
}
