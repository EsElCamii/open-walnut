/**
 * @deprecated — Use session-manager.ts instead.
 * This file re-exports everything for backward compatibility during migration.
 */
export {
  type OutputEvent,
  type SessionHistory,
  type TransportStartOptions,
  type TransportAttachOptions,
  type TransportStartResult,
  type TransportAttachResult,
  type SessionManager,
  type SessionManager as SessionTransport,
  createSessionManager as createTransport,
  createSessionManager,
  registerSessionManager,
  unregisterSessionManager,
  getRegisteredSessionManager,
  getRegisteredSessionManager as getRegisteredTransport,
} from './session-manager.js'
