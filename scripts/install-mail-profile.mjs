#!/usr/bin/env node
/**
 * 把 `@dsh-wfxm/mail` 挂到 dsh profile（默认 headless = 任务执行器）。
 *
 * dsh 的 profile 是运行期状态，不在本仓；这个脚本做幂等接线：
 *   - package.json 的 `dependencies` 增加 `link:<repo>/plugins/mail`
 *   - `dsh.profile.bundles` 追加 `@dsh-wfxm/mail`
 *   - `node_modules/@dsh-wfxm/mail` 建相对符号链接
 *
 * 用法：
 *   node scripts/install-mail-profile.mjs [--profile-dir <dir>] [--dry-run]
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const mailDir = join(repo, 'plugins/mail')
const PACKAGE = '@dsh-wfxm/mail'

function parseArgs(argv) {
  const options = { profileDir: join(homedir(), '.dsh/profiles/headless'), dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--profile-dir') {
      index += 1
      if (argv[index] === undefined) throw new Error('--profile-dir needs a value')
      options.profileDir = resolve(argv[index])
    } else if (arg.startsWith('--profile-dir=')) {
      options.profileDir = resolve(arg.slice('--profile-dir='.length))
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const packagePath = join(options.profileDir, 'package.json')
  if (!existsSync(packagePath)) {
    throw new Error(`profile package.json not found: ${packagePath}`)
  }
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  const changes = []

  pkg.dependencies ??= {}
  const linkTarget = `link:${mailDir}`
  if (pkg.dependencies[PACKAGE] !== linkTarget) {
    pkg.dependencies[PACKAGE] = linkTarget
    changes.push(`dependencies ${PACKAGE} = ${linkTarget}`)
  }

  const bundles = pkg.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error(`profile package.json has no dsh.profile.bundles: ${packagePath}`)
  if (!bundles.includes(PACKAGE)) {
    bundles.push(PACKAGE)
    changes.push(`bundles += ${PACKAGE}`)
  }

  const linkPath = join(options.profileDir, 'node_modules/@dsh-wfxm/mail')
  const linkValue = relative(join(options.profileDir, 'node_modules/@dsh-wfxm'), mailDir)
  let linkState = 'present'
  if (!existsSync(linkPath)) {
    linkState = 'created'
    if (!options.dryRun) {
      mkdirSync(join(options.profileDir, 'node_modules/@dsh-wfxm'), { recursive: true })
      symlinkSync(linkValue, linkPath)
    }
    changes.push(`node_modules/@dsh-wfxm/mail -> ${linkValue}`)
  }

  if (changes.length > 0 && !options.dryRun) {
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  }

  console.log(JSON.stringify({
    ok: true,
    profileDir: options.profileDir,
    dryRun: options.dryRun,
    changed: changes.length > 0,
    changes,
    link: linkState,
  }, null, 2))
}

try {
  main()
} catch (error) {
  console.error(`install-mail-profile: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
