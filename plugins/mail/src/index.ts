export type { MailAccount, MailConfigOptions, MailConfigResult } from './config.js'
export {
  DEFAULT_ARCHIVE_FOLDER,
  DEFAULT_CREDENTIALS_PATH,
  DEFAULT_MAIL_CONFIG_PATH,
  readArchiveFolder,
  readMailAccount,
  resolveSecretRef,
} from './config.js'
export {
  MailError,
  archiveMail,
  countMailFolder,
  queryMail,
  readMail,
  searchMail,
} from './query.js'
export type {
  MailArchiveRequest,
  MailArchiveResult,
  MailAttachmentInfo,
  MailErrorCode,
  MailFolderCountRequest,
  MailFolderCountResult,
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
  MAX_TODO_ITEMS,
  MAX_TODO_TEXT,
  buildTodoExtractionPrompt,
  parseMailTodos,
  renderMailTodos,
} from './todos.js'
export type {
  MailTodoItem,
  MailTodoSource,
  RenderTodosOptions,
  TodoPromptInput,
} from './todos.js'
export {
  MAIL_TOOL_PORT,
  MAIL_TOOL_RISK,
  apply,
  inject,
  isIsoDate,
  name,
  registerMailTools,
  validateArchiveArgs,
  validateDigestArgs,
  validateReadArgs,
  validateSearchArgs,
} from './tools.js'
export type { ContextLike, MailArchiveArgs, MailToolsDeps } from './tools.js'
