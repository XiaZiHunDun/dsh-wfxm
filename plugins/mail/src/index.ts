export type { MailAccount, MailConfigOptions, MailConfigResult, MailSmtp, MailSmtpResult } from './config.js'
export {
  DEFAULT_ARCHIVE_FOLDER,
  DEFAULT_CREDENTIALS_PATH,
  DEFAULT_DRAFT_FOLDER,
  DEFAULT_MAIL_CONFIG_PATH,
  DEFAULT_SENT_FOLDER,
  readArchiveFolder,
  readDraftFolder,
  readDraftFolderOverride,
  readMailAccount,
  readMailSmtp,
  readSentFolder,
  readSentFolderOverride,
  resolveSecretRef,
} from './config.js'
export {
  MailError,
  archiveMail,
  countMailFolder,
  draftMail,
  queryMail,
  readMail,
  searchMail,
  sendMail,
} from './query.js'
export type {
  MailArchiveRequest,
  MailArchiveResult,
  MailAttachmentInfo,
  MailDraftRequest,
  MailDraftResult,
  MailErrorCode,
  MailFolderCountRequest,
  MailFolderCountResult,
  MailMessageSummary,
  MailReadRequest,
  MailReadResult,
  MailSearchRequest,
  MailSearchResult,
  MailSendRequest,
  MailSendResult,
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
  validateOutgoingArgs,
  validateReadArgs,
  validateSearchArgs,
} from './tools.js'
export type { ContextLike, MailArchiveArgs, MailOutgoingArgs, MailToolsDeps } from './tools.js'
