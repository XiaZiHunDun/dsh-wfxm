export {
  DEFAULT_SNAPSHOT_KEEP,
  PREIMAGE_INLINE_LIMIT,
  SnapshotError,
  createSnapshotStore,
} from './store.js'
export type {
  AddPreimageInput,
  CreateSnapshotInput,
  PreimageFilter,
  PreimageRecord,
  SnapshotErrorCode,
  SnapshotFilter,
  SnapshotKind,
  SnapshotRecord,
  SnapshotStore,
} from './store.js'

export {
  DEFAULT_EXCLUDES,
  SNAPSHOT_TIMEOUT_MS,
  captureWorkspace,
  restoreWorkspace,
  scanWorkspace,
  writeAtomic,
} from './workspace.js'
export type {
  CaptureWorkspaceInput,
  RestoreWorkspaceInput,
  ScanOptions,
  ScannedFile,
  WorkspaceCapture,
  WorkspaceRestore,
  WorkspaceScan,
} from './workspace.js'

export { capturePreimage, restorePreimage, rollbackPreimages } from './preimage.js'
export type { CapturePreimageInput, RestorePreimageInput } from './preimage.js'

export { createPreimageRollbackPort, createSnapshotPort } from './port.js'
export type {
  PreimageRollbackPort,
  SnapshotPort,
  SnapshotPortOptions,
  SnapshotPortResult,
  SnapshotTaskRef,
} from './port.js'

export const name = 'dsh-wfxm-snapshot'
