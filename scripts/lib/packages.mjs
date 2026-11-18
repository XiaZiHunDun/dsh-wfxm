/**
 * Shared package discovery for the dependency-free build/typecheck gates.
 *
 * The repo is a pnpm workspace, but this machine has no pnpm on PATH; these
 * helpers let `node scripts/{build,typecheck}.mjs` drive each package's own
 * compiler directly. CI still uses pnpm for install/build.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function pluginPackages(root) {
  const dir = join(root, 'plugins')
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'tsconfig.json')))
    .sort()
}

export function packageTsc(root, name) {
  return join(root, 'plugins', name, 'node_modules', '.bin', 'tsc')
}

export function packageConfig(root, name) {
  return join(root, 'plugins', name, 'tsconfig.json')
}
