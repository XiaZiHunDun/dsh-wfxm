export type {
  FactEvidence,
  FactEvidenceInput,
  FactInput,
  FactKind,
  FactScope,
  FactSource,
  FactVerification,
  MemoryErrorCode,
  MemoryFact,
  PreparedFact,
} from './facts.js'
export { MAX_EVIDENCE_VALUE, MemoryError, factKey, prepareFact } from './facts.js'
export type {
  FactFilter,
  MemoryEdge,
  MemoryStore,
  Project,
  ProjectAlias,
  UpsertProjectInput,
} from './store.js'
export { createMemoryStore } from './store.js'
export type { GateDecision, GateOptions, GateResult, FactProbe, ProbeOutcome, ProbeStatus } from './verify.js'
export { DEFAULT_ENVIRONMENT_PREDICATES, gateFact } from './verify.js'
export { createPathProbe } from './probes.js'
export type { ProjectChoice, ProjectContext, ProjectContextInput, ProjectLookupPort } from './context.js'
export {
  PROJECT_CHOICE_LIMIT,
  createProjectLookupPort,
  projectMemoryContext,
} from './context.js'
export type { HealthCheck, HealthDigestOptions, HealthFinding, HealthOptions, HealthReport, ReviewCandidate } from './health.js'
export { checkFacts, formatFactHealth } from './health.js'
export type {
  MemoryProposal,
  ProposalInput,
  ProposalListOptions,
  ProposalStatus,
} from './proposals.js'
export { PROPOSAL_TTL_DAYS, formatPendingProposals, proposalExpiry } from './proposals.js'
export {
  MEMORY_TOOL_PORT,
  MEMORY_TOOL_RISK,
  apply,
  inject,
  memoryDbPath,
  name,
  registerMemoryTools,
} from './tools.js'
export type { MemoryToolsDeps } from './tools.js'
