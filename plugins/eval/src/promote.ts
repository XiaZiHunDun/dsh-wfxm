/**
 * `/eval promote` 的候选任务生成（P2-3）。
 *
 * 只在 `eval/candidates/` 落一份 `eval-task/v0` 草稿，并先用 agent-eval 的
 * `src/contract.mjs` 校验；校验不过就拒绝落盘。turns/expect 由人工补全，
 * 不会从轨迹自动推断判据，也不会自动改 `agent-eval/tasks/`。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { EvalFinding } from './store.js'

export type PromoteCandidate = Record<string, unknown>

export type PromoteResult =
  | { ok: true; taskId: string; path: string; display: string; task: PromoteCandidate }
  | { ok: false; reason: string }

export interface CandidatePromoter {
  /** `AGENT_EVAL_ROOT/src/contract.mjs` 是否存在。 */
  readonly available: boolean
  promote(finding: EvalFinding): Promise<PromoteResult>
}

export interface CandidatePromoterOptions {
  root: string | null
  candidatesDir: string
}

/** 去掉 `sha256:<hex>` 前缀，只留截断摘要。 */
function summaryOfDigest(digest: string): string {
  return digest.replace(/^sha256:[0-9a-f]+\s*/, '').trim()
}

function suiteFor(finding: EvalFinding): string {
  return finding.suite.startsWith('dsh-') && finding.suite !== 'dsh-snapshot'
    ? finding.suite
    : 'dsh-adversarial'
}

function draftFor(finding: EvalFinding): PromoteCandidate {
  const summary = summaryOfDigest(finding.detailDigest)
  return {
    id: `dsh-reg-${finding.id.slice(0, 8)}`,
    title: finding.title,
    suite: suiteFor(finding),
    taxonomy: 'robustness',
    difficulty: 'medium',
    source: 'regression',
    split: 'dev',
    kind: 'chat',
    notes: `由 /eval promote 从 finding ${finding.id} 生成；turns/expect 需人工补全后再提 PR。`,
    turns: [summary === '' ? '（待补全用户原话）' : `（待补全用户原话）${summary}`],
    timeoutMs: 120000,
    // 故意留空：判据必须人工补，避免从失败摘要臆测。
    expect: {},
  }
}

interface ContractModule {
  validateTask?: (task: unknown) => string[]
}

export function createCandidatePromoter(options: CandidatePromoterOptions): CandidatePromoter {
  const root = options.root === null || options.root === '' ? null : options.root
  const contractPath = root === null ? null : join(root, 'src', 'contract.mjs')
  const available = contractPath !== null && existsSync(contractPath)

  return {
    available,
    async promote(finding: EvalFinding): Promise<PromoteResult> {
      if (contractPath === null || !available) {
        return { ok: false, reason: '候选生成需要 AGENT_EVAL_ROOT（含 src/contract.mjs）' }
      }
      const task = draftFor(finding)
      const taskId = String(task.id)

      let contract: ContractModule
      try {
        contract = await import(`${pathToFileURL(contractPath).href}?t=${Date.now()}`) as ContractModule
      } catch (error) {
        return { ok: false, reason: `无法加载 contract.mjs：${error instanceof Error ? error.message : String(error)}` }
      }
      if (typeof contract.validateTask !== 'function') {
        return { ok: false, reason: 'contract.mjs 未导出 validateTask' }
      }
      let errors: string[]
      try {
        errors = contract.validateTask(task)
      } catch (error) {
        return { ok: false, reason: `契约校验异常：${error instanceof Error ? error.message : String(error)}` }
      }
      if (!Array.isArray(errors) || errors.length > 0) {
        const detail = Array.isArray(errors) ? errors.slice(0, 3).join('；') : '返回值不是错误列表'
        return { ok: false, reason: `候选未通过契约校验：${detail}` }
      }

      const file = join(options.candidatesDir, `${finding.id}.json`)
      const display = `eval/candidates/${basename(file)}`
      if (existsSync(file)) return { ok: false, reason: `候选已存在：${display}；请先人工审核或删除` }
      mkdirSync(options.candidatesDir, { recursive: true })
      writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
      return { ok: true, taskId, path: file, display, task }
    },
  }
}
