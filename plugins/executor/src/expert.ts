/**
 * Slice CH (O1): route a task to one expert adapter.
 *
 * The router is deliberately thin: adapters are ordinary `TaskExecutorFn`s, so
 * an expert can never receive the approval store, the grant store or any
 * credential (AR34). Routing is deterministic and first-hit-wins:
 *
 *   tasks.expert (explicit `/expert`) → projects.default_expert → global default
 *
 * An unknown name is a hard failure with `expert-unavailable`; silently falling
 * back would hide a misconfigured project behind "it worked".
 */

import type {
  ExecutorTelemetryPort,
  ExecutorTaskRef,
  TaskExecutorFn,
} from './executor.js'

/** Experts shipped with this build; CLI validation and error text use it. */
export const BUILTIN_EXPERTS = ['dsh'] as const

export interface ExpertAdapter {
  name: string
  execute: TaskExecutorFn
}

export type ExpertRouteReason = 'explicit' | 'project-default' | 'global-default'

export interface ExpertRoute {
  expert: string
  reason: ExpertRouteReason
}

export interface ExpertExecutorOptions {
  adapters: readonly ExpertAdapter[]
  /** Used when neither the task nor its project names one; defaults to `dsh`. */
  defaultExpert?: string
  /** Read the task's project default; the composition root injects ⑥'s API. */
  projectExpert?: (projectId: string) => string | null | Promise<string | null>
  /** P6-1: the same port `createDshExecutor` uses; absent means no trace. */
  telemetry?: ExecutorTelemetryPort | null
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function createExpertExecutor(options: ExpertExecutorOptions): TaskExecutorFn {
  const adapters = new Map<string, ExpertAdapter>()
  for (const adapter of options.adapters) {
    const name = cleanName(adapter?.name)
    if (name === null) throw new Error('expert adapter name must not be empty')
    if (adapters.has(name)) throw new Error(`duplicate expert adapter: ${name}`)
    adapters.set(name, adapter)
  }
  if (adapters.size === 0) throw new Error('at least one expert adapter is required')

  const defaultExpert = cleanName(options.defaultExpert) ?? 'dsh'
  const projectExpert = options.projectExpert ?? null
  const telemetry = options.telemetry ?? null
  const known = [...adapters.keys()].join(', ')

  return async function execute(task, hooks) {
    let route: ExpertRoute
    const explicit = cleanName(task.expert)
    if (explicit !== null) {
      route = { expert: explicit, reason: 'explicit' }
    } else {
      const projectName = projectExpert !== null && cleanName(task.projectId) !== null
        ? cleanName(await projectExpert(task.projectId as string))
        : null
      route = projectName !== null
        ? { expert: projectName, reason: 'project-default' }
        : { expert: defaultExpert, reason: 'global-default' }
    }

    const adapter = adapters.get(route.expert) ?? null
    if (adapter === null) {
      return {
        status: 'failed',
        failure: 'invalid_input',
        errorCode: 'expert-unavailable',
        summary: `专家不可用：${route.expert}。可用：${known}。任务未执行。`,
      }
    }

    const traceId = cleanName(task.correlationId)
    if (telemetry !== null && traceId !== null) {
      telemetry.emit({
        event: 'expert.routed',
        level: 'info',
        phase: 'execute',
        traceId,
        spanId: `task:${task.id}`,
        taskId: task.id,
        status: 'ok',
        attrs: {
          expert: route.expert,
          reason: route.reason,
          projectId: task.projectId ?? null,
          explicit: route.reason === 'explicit',
        },
      })
    }

    return adapter.execute(task, hooks)
  }
}

/** Kept for callers that only need the structural task shape. */
export type ExpertTaskRef = ExecutorTaskRef
