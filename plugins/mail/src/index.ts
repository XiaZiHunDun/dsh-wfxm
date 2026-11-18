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
  MAIL_TOOL_PORT,
  MAIL_TOOL_RISK,
  apply,
  inject,
  isIsoDate,
  name,
  registerMailTools,
  validateReadArgs,
  validateSearchArgs,
} from './tools.js'
export type { ContextLike, MailToolsDeps } from './tools.js'
