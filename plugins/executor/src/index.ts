export {
  createDshExecutor,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_SUMMARY_CHARS,
  DEFAULT_TIMEOUT_MS,
} from './executor.js'
export type {
  CheckpointPort,
  DshExecutorOptions,
  ExecFailure,
  ExecOutcome,
  ExecSuccess,
  ExecutorHooks,
  ExecutorTaskRef,
  FailureKind,
  TaskExecutorFn,
} from './executor.js'

export const name = 'dsh-wfxm-executor'
