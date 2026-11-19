#!/usr/bin/env node
/**
 * M9b regression check — compare a current baseline archive against the
 * reference. Advisory by default; `--enforce` turns a regression into exit 3.
 *
 * Usage:
 *   node bench/regress.mjs [--reference bench/baselines/reference.json]
 *     --current bench/results/<...>.json [--thresholds bench/thresholds.json]
 *     [--enforce]
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_THRESHOLDS,
  compareBaseline,
  renderRegressMarkdown,
  validateThresholds,
} from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function readJson(path, label) {
  if (!existsSync(path)) return { error: `${label}不存在：${path}` }
  try {
    return { doc: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: `无法解析${label}：${error.message}` }
  }
}

function main() {
  const referencePath = arg('reference', join(HERE, 'baselines', 'reference.json'))
  const currentPath = arg('current')
  const thresholdsPath = arg('thresholds', join(HERE, 'thresholds.json'))
  const enforce = process.argv.includes('--enforce')

  if (currentPath === undefined) {
    console.error('用法：node bench/regress.mjs --current <基线归档.json> [--reference 路径] [--thresholds 路径] [--enforce]')
    return 2
  }

  const reference = readJson(referencePath, '参考基线')
  if (reference.error !== undefined) {
    console.error(reference.error)
    return 2
  }
  const current = readJson(currentPath, '当前基线')
  if (current.error !== undefined) {
    console.error(current.error)
    return 2
  }

  const thresholdsFile = readJson(thresholdsPath, '阈值')
  const parsed = thresholdsFile.doc === undefined
    ? { thresholds: DEFAULT_THRESHOLDS, errors: [] }
    : validateThresholds(thresholdsFile.doc)
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) console.error(`阈值错误：${error}`)
    return 2
  }

  const result = compareBaseline(reference.doc, current.doc, parsed.thresholds)
  process.stdout.write(renderRegressMarkdown(result, {
    reference: referencePath,
    current: currentPath,
    generatedAt: new Date().toISOString(),
  }))
  if (!result.pass && enforce) return 3
  return 0
}

process.exitCode = main()
