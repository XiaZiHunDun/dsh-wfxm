export {
  ATTACH_MARKER,
  createDshExecutor,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_SUMMARY_CHARS,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  NEED_INPUT_MARKER,
} from './executor.js'
export type {
  CheckpointPort,
  DshExecutorOptions,
  ExecAttachment,
  ExecFailure,
  ExecNeedsInput,
  ExecOutcome,
  ExecSuccess,
  ExecutorHooks,
  ExecutorTaskRef,
  FailureKind,
  TaskExecutorFn,
} from './executor.js'

export const name = 'dsh-wfxm-executor'
