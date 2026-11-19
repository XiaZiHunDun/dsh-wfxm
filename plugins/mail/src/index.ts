export type { MailAccount, MailConfigOptions, MailConfigResult } from './config.js'
export {
  DEFAULT_CREDENTIALS_PATH,
  DEFAULT_MAIL_CONFIG_PATH,
  readMailAccount,
  resolveSecretRef,
} from './config.js'
export {
  MailError,
  queryMail,
  readMail,
  searchMail,
} from './query.js'
export type {
  MailAttachmentInfo,
  MailErrorCode,
  MailMessageSummary,
  MailReadRequest,
  MailReadResult,
  MailSearchRequest,
  MailSearchResult,
  QueryMailOptions,
} from './query.js'
export {
  buildMailDigest,
  classifyMail,
  isAutomatedSender,
  renderDigest,
} from './digest.js'
export type { MailDigestGroup, MailDigestRequest, MailDigestResult } from './digest.js'
export {
  DEFAULT_DIGEST_TIME_ZONE,
  digestDue,
  localDayMinutes,
  parseDigestEnv,
  readDigestState,
  writeDigestState,
} from './schedule.js'
export type { MailDigestConfig, MailDigestState } from './schedule.js'
export {
  MAIL_TOOL_PORT,
  MAIL_TOOL_RISK,
  apply,
  inject,
  isIsoDate,
  name,
  registerMailTools,
  validateDigestArgs,
  validateReadArgs,
  validateSearchArgs,
} from './tools.js'
export type { ContextLike, MailToolsDeps } from './tools.js'
