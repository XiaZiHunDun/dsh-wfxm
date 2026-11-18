/**
 * Shared package discovery for the dependency-free build/typecheck gates.
 *
 * The repo is a pnpm workspace, but this machine has no pnpm on PATH; these
 * helpers let `node scripts/{build,typecheck}.mjs` drive each package's own
 * compiler directly. CI still uses pnpm for install/build.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Plugin packages in dependency order. A clean checkout has no `lib/`, so
 * dependents (host, orchestrator) must compile after the packages they import
 * (`gateway`, `tasks`, ...); alphabetical order made the first build fail.
 */
export function pluginPackages(root) {
  const dir = join(root, 'plugins')
  const names = readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'tsconfig.json')))
    .sort()
  const known = new Set(names)
  const deps = new Map(names.map((name) => {
    let pkg = {}
    try {
      pkg = JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8'))
    } catch {
      // No package.json: nothing to order against.
    }
    const declared = { ...pkg.dependencies, ...pkg.devDependencies }
    return [name, Object.keys(declared)
      .filter((dep) => dep.startsWith('@dsh-wfxm/'))
      .map((dep) => dep.slice('@dsh-wfxm/'.length))
      .filter((dep) => known.has(dep))]
  }))

  const sorted = []
  const seen = new Set()
  const visiting = new Set()
  const visit = (name) => {
    if (seen.has(name) || visiting.has(name)) return
    visiting.add(name)
    for (const dep of deps.get(name) ?? []) visit(dep)
    visiting.delete(name)
    seen.add(name)
    sorted.push(name)
  }
  for (const name of names) visit(name)
  return sorted
}

export function packageTsc(root, name) {
  return join(root, 'plugins', name, 'node_modules', '.bin', 'tsc')
}

export function packageConfig(root, name) {
  return join(root, 'plugins', name, 'tsconfig.json')
}
