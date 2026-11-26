export type {
  CommandResult,
  CommandRunner,
  ServiceActionResult,
  ServiceInfo,
  ServiceLogs,
  ServiceStatus,
  SvcAction,
  SvcOpsPort,
  SvcRisk,
  SystemdAdapterOptions,
} from './systemd.js'
export {
  DEFAULT_UNIT_PREFIX,
  SvcOpsError,
  createSystemdAdapter,
  isManagedUnit,
  spawnRunner,
} from './systemd.js'
export type { DockerAdapterOptions } from './docker.js'
export {
  DEFAULT_CONTAINER_PREFIX,
  MANAGED_LABEL,
  createDockerAdapter,
  isManagedContainer,
} from './docker.js'
export {
  SVC_TOOL_PORT,
  SVC_TOOL_RISK,
  apply,
  inject,
  inspectionDbPath,
  name,
  quietWindowMs,
  registerSvcTools,
} from './tools.js'
export type { SvcToolsDeps } from './tools.js'
export {
  DEFAULT_CHECKLIST_ID,
  DEFAULT_THRESHOLDS,
  evaluate,
} from './inspection/checklist.js'
export type {
  HostMetrics,
  InspectionItem,
  InspectionItemStatus,
  InspectionReport,
  InspectionThresholds,
} from './inspection/checklist.js'
export { gradeInspection } from './inspection/alerting.js'
export type { AlertDecision, AlertLevel } from './inspection/alerting.js'
export { CANDIDATE_RULES, deriveCandidates } from './inspection/candidates.js'
export type { CandidateInput, CandidateRule, CandidateStrength } from './inspection/candidates.js'
export {
  DEFAULT_TRACE_HEALTH_THRESHOLDS,
  deriveSuggestions,
  evaluateTraceHealth,
  formatSuggestionDigest,
  formatSuggestions,
  readTraceHealthConfig,
} from './suggestions.js'
export type {
  FailureBreakdown,
  Suggestion,
  SuggestionBudget,
  SuggestionEntry,
  SuggestionInput,
  TraceBreach,
  TraceBreachKind,
  TraceHealth,
  TraceHealthThresholds,
} from './suggestions.js'
export {
  parseExpectedPorts,
  parseThresholds,
  readInspectionConfig,
} from './inspection/config.js'
export type { InspectionConfig, InspectionConfigResult } from './inspection/config.js'
export { formatCandidateDigest, summarize } from './inspection/report.js'
export type {
  InspectionDigest,
  InspectionDigestLatest,
  InspectionDigestOptions,
} from './inspection/report.js'
export {
  collectHostMetrics,
  probeDisk,
  probeFailedUnits,
  probeListeningPorts,
  probeLoad1,
  probeLogErrors,
  probeMemory,
} from './inspection/probes.js'
export { createInspectionStore } from './inspection/store.js'
export type {
  CandidateDigest,
  CandidateDigestItem,
  CandidateStatus,
  InspectionRecord,
  InspectionStore,
} from './inspection/store.js'
export type { ResourceProbeOptions, ResourceSnapshot } from './inspection/resources.js'
export { createResourceProbe } from './inspection/resources.js'
export {
  DEFAULT_ALERT_QUIET_MS,
  DEFAULT_DIGEST_HOUR,
  DEFAULT_DIGEST_WINDOW_HOURS,
  DEFAULT_PATROL_INTERVAL_MINUTES,
  DEFAULT_WEEKLY_DIGEST_DAY,
  WEEKLY_WINDOW_HOURS,
  createInspectionPatrol,
  formatInspectionAlert,
  formatInspectionDigest,
  formatInspectionWeek,
  isoWeekKey,
  readPatrolConfig,
} from './patrol.js'
export type {
  AlertTextInput,
  InspectionPatrol,
  MemoryHealthDigest,
  InspectionPatrolOptions,
  PatrolConfig,
  PatrolConfigResult,
  PatrolDelivery,
  PatrolRunResult,
  TraceHealthDigest,
} from './patrol.js'
