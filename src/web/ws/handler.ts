/**
 * WebSocket connection manager.
 *
 * Tracks connected clients, broadcasts bus events, and routes
 * incoming RPC requests to registered method handlers.
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { WsFrame } from './protocol.js'
import { log } from '../../logging/index.js'

export type RpcHandler = (payload: unknown, client: WebSocket) => unknown | Promise<unknown>

/**
 * Per-connection delivery mode.
 * - "global"      (default): receives EVERY broadcast event — the original firehose
 *                  behavior. The main app window relies on this.
 * - "lightweight": receives only events whose `data.sessionId` / `data.taskId` is in
 *                  this connection's `interest` set (plus entity-less essential events).
 *                  Used by pop-out windows that only care about a single entity.
 */
type ClientMode = 'global' | 'lightweight'

interface Client {
  ws: WebSocket
  seq: number
  alive: boolean
  /** Delivery mode. Defaults to "global" so existing clients are unchanged. */
  mode: ClientMode
  /** Entity ids (sessionId / taskId) this connection cares about in lightweight mode. */
  interest: Set<string>
}

let wss: WebSocketServer | null = null
const clients = new Set<Client>()
const rpcMethods = new Map<string, RpcHandler>()

const PING_INTERVAL_MS = 30_000

let pingTimer: ReturnType<typeof setInterval> | null = null

/** Callbacks invoked when a client socket disconnects (close or error). */
const disconnectListeners = new Set<(ws: WebSocket) => void>()

/**
 * Subscribe to client-disconnect events. Used by the terminal manager to
 * detach terminals when their attached socket goes away. Registered via a
 * callback (not a direct import) to avoid a circular dependency.
 */
export function onClientDisconnect(listener: (ws: WebSocket) => void): void {
  disconnectListeners.add(listener)
}

/**
 * Register an RPC method handler.
 * When a client sends `{ type: "req", method: name, ... }`, the handler is called.
 */
export function registerMethod(name: string, handler: RpcHandler): void {
  rpcMethods.set(name, handler)
}

/**
 * Broadcast a bus event to all connected WebSocket clients.
 */
export function broadcastEvent(name: string, data: unknown): void {
  // DUP-DEBUG (debug-level): for tool_use / tool_result include toolUseId so each
  // broadcast can be traced. If two `broadcast session:tool-use` lines share the
  // same toolUseId, the duplication is upstream of the WS layer. Kept at debug —
  // these fire on the streaming hot path; surface via WALNUT_LOG_LEVEL=debug.
  if (name === 'session:tool-use' || name === 'session:tool-result') {
    const d = data as { toolUseId?: string; sessionId?: string; toolName?: string }
    log.ws.debug(`broadcast ${name}`, {
      clientCount: clients.size,
      sessionId: d?.sessionId,
      toolUseId: d?.toolUseId,
      toolName: d?.toolName,
    })
  } else {
    log.ws.debug(`broadcast ${name}`, { clientCount: clients.size })
  }
  // Extract entity ids once (shared across all clients) for lightweight filtering.
  const entity = data as { sessionId?: string; taskId?: string } | null | undefined
  const sessionId = entity?.sessionId
  const taskId = entity?.taskId

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue
    // Lightweight clients (pop-out windows) only want events for entities they
    // opted into. Default "global" clients are never filtered — unchanged firehose.
    if (client.mode === 'lightweight' && !clientWantsEvent(client, sessionId, taskId)) continue
    client.seq++
    const frame: WsFrame = { type: 'event', name, data, seq: client.seq }
    client.ws.send(JSON.stringify(frame))
  }
}

/**
 * Decide whether a lightweight client should receive an event.
 *
 * Rule (intentionally permissive — "when unsure, send"):
 * - If the event carries a sessionId/taskId in the client's interest set → send.
 * - If the event carries NO entity id at all (sessionId AND taskId both absent),
 *   it's an essential/lifecycle event (e.g. system:health, cron:*, _ws:*) → send.
 * - Otherwise the event is *about some other entity* the client didn't opt into → skip.
 */
function clientWantsEvent(client: Client, sessionId?: string, taskId?: string): boolean {
  if (sessionId && client.interest.has(sessionId)) return true
  if (taskId && client.interest.has(taskId)) return true
  // No entity id => not addressed to a specific entity => keep it (safe default).
  if (!sessionId && !taskId) return true
  return false
}

/**
 * Send a bus event to a single WebSocket client.
 */
export function sendToClient(ws: WebSocket, name: string, data: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  // Find the client to update its seq counter
  for (const client of clients) {
    if (client.ws === ws) {
      client.seq++
      const frame: WsFrame = { type: 'event', name, data, seq: client.seq }
      ws.send(JSON.stringify(frame))
      return
    }
  }
}

/**
 * Send a streaming event to all connected clients.
 * Clients filter by sessionId on the frontend side.
 */
export function sendStreamEvent(_sessionId: string, name: string, data: unknown): void {
  broadcastEvent(name, data)
}

/**
 * Send an RPC response back to a specific WebSocket client.
 */
function sendResponse(ws: WebSocket, id: string, ok: boolean, payload?: unknown, error?: string): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const frame: WsFrame = ok
    ? { type: 'res', id, ok: true, payload }
    : { type: 'res', id, ok: false, error }
  ws.send(JSON.stringify(frame))
}

/**
 * Handle an incoming message from a client.
 */
async function handleMessage(client: Client, raw: string): Promise<void> {
  let frame: WsFrame
  try {
    frame = JSON.parse(raw) as WsFrame
  } catch {
    return // ignore malformed JSON
  }

  if (frame.type !== 'req') return // only handle RPC requests from clients

  const handler = rpcMethods.get(frame.method)
  if (!handler) {
    sendResponse(client.ws, frame.id, false, undefined, `Unknown method: ${frame.method}`)
    return
  }

  try {
    const result = await handler(frame.payload, client.ws)
    sendResponse(client.ws, frame.id, true, result ?? undefined)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.ws.error(`RPC handler error for "${frame.method}"`, { error: message })
    sendResponse(client.ws, frame.id, false, undefined, message)
  }
}

/** Find the Client wrapper for a raw WebSocket (RPC handlers only get the socket). */
function findClient(ws: WebSocket): Client | undefined {
  for (const client of clients) {
    if (client.ws === ws) return client
  }
  return undefined
}

/**
 * Built-in "set-interest" RPC. Lets a client opt into lightweight delivery so it
 * only receives events for the entities it lists (used by pop-out windows to avoid
 * the full event firehose). Sending `{ mode: "global" }` (or omitting mode) restores
 * the default firehose. Idempotent — safe to call repeatedly (e.g. after reconnect).
 *
 * Payload: { mode?: "global" | "lightweight", ids?: string[] }
 *   - mode "lightweight" + ids [sessionId/taskId, ...] → filtered delivery
 *   - mode "global" (default) → full firehose, interest cleared
 * Returns: { mode, ids } reflecting the applied state.
 */
function registerSetInterest(): void {
  registerMethod('set-interest', (payload: unknown, ws: WebSocket) => {
    const client = findClient(ws)
    if (!client) throw new Error('set-interest: client not found')

    const p = (payload ?? {}) as { mode?: unknown; ids?: unknown }
    const mode: ClientMode = p.mode === 'lightweight' ? 'lightweight' : 'global'
    const ids = Array.isArray(p.ids) ? p.ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : []

    client.mode = mode
    client.interest = new Set(mode === 'lightweight' ? ids : []) // clear interest when going global

    log.ws.info('set-interest', { mode, idCount: client.interest.size })
    return { mode, ids: [...client.interest] }
  })
}

/**
 * Attach the WebSocket server to an existing HTTP server via upgrade.
 */
export function attachWss(server: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ noServer: true })
  registerSetInterest()

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    // Only upgrade requests to /ws (or all if no path check needed)
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }

    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    // New connections default to "global" mode (full firehose) — unchanged behavior.
    const client: Client = { ws, seq: 0, alive: true, mode: 'global', interest: new Set() }
    clients.add(client)
    log.ws.info('client connected', { clientCount: clients.size })

    ws.on('pong', () => {
      client.alive = true
    })

    ws.on('message', (data) => {
      handleMessage(client, data.toString()).catch((err) => {
        log.ws.error('message handler error', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    })

    ws.on('close', () => {
      clients.delete(client)
      for (const l of disconnectListeners) { try { l(ws) } catch { /* listener error ignored */ } }
      log.ws.info('client disconnected', { clientCount: clients.size })
    })

    ws.on('error', () => {
      clients.delete(client)
      for (const l of disconnectListeners) { try { l(ws) } catch { /* listener error ignored */ } }
      log.ws.warn('client error, removing', { clientCount: clients.size })
    })
  })

  // Ping/pong heartbeat
  pingTimer = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate()
        clients.delete(client)
        continue
      }
      client.alive = false
      client.ws.ping()
    }
  }, PING_INTERVAL_MS)

  return wss
}

/**
 * Close all connections and stop the WebSocket server.
 */
export function closeWss(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }

  for (const client of clients) {
    client.ws.terminate()
  }
  clients.clear()

  if (wss) {
    wss.close()
    wss = null
  }
}

/**
 * Number of currently connected clients (useful for tests/debugging).
 */
export function clientCount(): number {
  return clients.size
}
