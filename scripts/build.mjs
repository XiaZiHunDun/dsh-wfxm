#!/usr/bin/env node
/**
 * Build every plugin with its own compiler (pnpm-free fallback).
 *
 *   node scripts/build.mjs            # emit lib/
 *   node scripts/build.mjs --noEmit   # same traversal, typecheck only
 *
 * CI uses `pnpm -r build`; this exists so a machine without pnpm (and the
 * release script) still produces the artifacts the verify suites import.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageConfig, packageTsc, pluginPackages } from './lib/packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const noEmit = process.argv.includes('--noEmit')
const failures = []

for (const name of pluginPackages(root)) {
  const tsc = packageTsc(root, name)
  if (!existsSync(tsc)) {
    failures.push(`${name}: missing ${tsc} (run pnpm install)`)
    continue
  }
  const args = ['-p', packageConfig(root, name)]
  if (noEmit) args.push('--noEmit')
  const started = Date.now()
  const run = spawnSync(tsc, args, { cwd: root, encoding: 'utf8' })
  if (run.status !== 0) {
    failures.push(`${name}: ${(run.stderr || run.stdout || '').trim().slice(0, 800)}`)
    continue
  }
  console.log(`${noEmit ? 'typecheck' : 'build'} ok  ${name} (${Date.now() - started}ms)`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
