/**
 * @deprecated — Use remote-session-manager.ts instead.
 * This file re-exports for backward compatibility during migration.
 */
export {
  RemoteSessionManager,
  RemoteSessionManager as DaemonTransport,
  findLocalImagePaths,
  findRemoteImagePaths,
  findRelativeImageNames,
} from './remote-session-manager.js'
