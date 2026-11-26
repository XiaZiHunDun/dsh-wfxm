export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_DAILY_LIMIT_BYTES,
  DEFAULT_DISK_WARN_RATIO,
  DEFAULT_FILE_RETENTION_DAYS,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_PER_TASK_LIMIT_BYTES,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_RETENTION_DAYS,
  createTelemetryStore,
} from './store.js'
export type {
  AttemptOutcome,
  BeginAttemptInput,
  DiskUsage,
  DropReason,
  FinishAttemptInput,
  FlushResult,
  PruneResult,
  TaskAttempt,
  TelemetryStats,
  TelemetryStore,
  TelemetryStoreOptions,
  TraceErrorRecord,
  TraceEventRecord,
  TraceModelRecord,
  TraceQueryInput,
  TraceQueryResult,
  TraceToolRecord,
} from './store.js'

export {
  TELEMETRY_ATTR_KEYS,
  TELEMETRY_MESSAGE_LIMIT,
  TELEMETRY_STACK_LIMIT,
  TelemetryError,
  digestText,
  normalizeTelemetryEvent,
  redactAttrsForStorage,
  redactForStorage,
  resolveTelemetryMode,
  telemetryEventSchema,
  toIsoTime,
  validateTelemetryEvent,
} from './event.js'
export type {
  AttrValue,
  NormalizedError,
  NormalizedModel,
  NormalizedTelemetryEvent,
  NormalizedTool,
  TelemetryEventInput,
  TelemetryLevel,
  TelemetryMode,
  ValidatedTelemetryEvent,
} from './event.js'

export { dayKey, uuidv7 } from './ids.js'

export const name = 'dsh-wfxm-telemetry'
