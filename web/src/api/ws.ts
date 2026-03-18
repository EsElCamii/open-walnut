/**
 * WebSocket client — singleton, auto-reconnects, dispatches events.
 *
 * Uses the structured `log` helper so every WS log line can be traced
 * across browser ↔ server by grepping a full sessionId / rpcId.
 */

import { log } from '@/utils/log';

/** WebSocket frame types matching the server protocol. */
export interface WsEventFrame {
  type: 'event';
  name: string;
  data: unknown;
  seq: number;
}

export interface WsReqFrame {
  type: 'req';
  id: string;
  method: string;
  payload: unknown;
}

export interface WsResFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

type WsFrame = WsEventFrame | WsResFrame;

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
type EventCallback = (data: unknown) => void;
type ConnectionCallback = (state: ConnectionState) => void;

let reqCounter = 0;
function nextReqId(): string {
  return `r${++reqCounter}-${Date.now().toString(36)}`;
}

// Suppress noisy high-frequency streaming events from logging
const SUPPRESSED_EVENTS = new Set([
  'session:text-delta',
  'agent:text-delta',
  'agent:thinking',
]);

class WsClient {
  private ws: WebSocket | null = null;
  private eventListeners = new Map<string, Set<EventCallback>>();
  private connectionListeners = new Set<ConnectionCallback>();
  private pendingRpc = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private _state: ConnectionState = 'disconnected';
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private eventCount = 0;
  // Distinguishes cold first-connect from subsequent reconnects.
  // `_ws:reconnected` only fires on reconnects, not the initial page load.
  private hasConnectedBefore = false;

  get state() {
    return this._state;
  }

  connect() {
    if (this.ws) return;
    this.disposed = false;
    this.setState('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;
    log.info('ws', 'connecting', { url });
    const ws = new WebSocket(url);

    ws.onopen = () => {
      const isReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.reconnectDelay = 1000;
      this.setState('connected');
      log.info('ws', isReconnect ? 'connected (reconnect)' : 'connected');
      // On reconnect, emit a synthetic event so components can re-fetch stale data.
      // Events during the disconnect window are permanently lost — the server has
      // no event buffer/replay; events are fire-and-forget over the live socket.
      // This lets SessionPanel re-fetch status and SessionChatHistory re-fetch history.
      if (isReconnect) {
        // seq: -1 is a sentinel meaning client-synthetic event, not a server-sequenced frame.
        this.dispatchEvent({ type: 'event', name: '_ws:reconnected', data: {}, seq: -1 });
      }
    };

    ws.onclose = (ev) => {
      log.info('ws', 'disconnected', { code: ev.code, reason: ev.reason || 'none' });
      this.ws = null;
      this.setState('disconnected');
      this.rejectPending('WebSocket disconnected');
      if (!this.disposed) this.scheduleReconnect();
    };

    ws.onerror = () => {
      log.warn('ws', 'error');
    };

    ws.onmessage = (ev) => {
      try {
        const frame: WsFrame = JSON.parse(ev.data);
        if (frame.type === 'event') {
          this.dispatchEvent(frame as WsEventFrame);
        } else if (frame.type === 'res') {
          this.handleResponse(frame);
        } else {
          log.warn('ws', 'unknown frame type', { frame: frame as Record<string, unknown> });
        }
      } catch {
        log.warn('ws', 'malformed frame');
      }
    };

    this.ws = ws;
  }

  disconnect() {
    log.info('ws', 'disconnect() called');
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
    this.rejectPending('WebSocket disposed');
  }

  onEvent(name: string, cb: EventCallback) {
    let set = this.eventListeners.get(name);
    if (!set) {
      set = new Set();
      this.eventListeners.set(name, set);
    }
    set.add(cb);
    log.debug('ws', `listener added: "${name}"`, { count: set.size });
  }

  offEvent(name: string, cb: EventCallback) {
    const set = this.eventListeners.get(name);
    set?.delete(cb);
    log.debug('ws', `listener removed: "${name}"`, { remaining: set?.size ?? 0 });
  }

  onConnectionChange(cb: ConnectionCallback) {
    this.connectionListeners.add(cb);
  }

  offConnectionChange(cb: ConnectionCallback) {
    this.connectionListeners.delete(cb);
  }

  sendRpc<T = unknown>(method: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        log.warn('ws', 'RPC failed — not connected', { method });
        reject(new Error('WebSocket not connected'));
        return;
      }
      const id = nextReqId();
      const frame: WsReqFrame = { type: 'req', id, method, payload };
      this.pendingRpc.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      // Extract IDs from payload for traceability
      const rpcLog: Record<string, unknown> = { rpcId: id, method };
      if (payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        if (p.sessionId) rpcLog.sessionId = p.sessionId;
        if (p.taskId) rpcLog.taskId = p.taskId;
      }
      log.info('ws', `RPC:${id} →`, rpcLog);
      this.ws.send(JSON.stringify(frame));
    });
  }

  private setState(state: ConnectionState) {
    if (this._state === state) return;
    const prev = this._state;
    this._state = state;
    log.info('ws', `state ${prev} → ${state}`);
    for (const cb of this.connectionListeners) {
      try { cb(state); } catch (err) {
        log.error('ws', 'connectionChange callback error', { error: String(err) });
      }
    }
  }

  private dispatchEvent(frame: WsEventFrame) {
    this.eventCount++;
    const cbs = this.eventListeners.get(frame.name);
    const listenerCount = cbs?.size ?? 0;

    if (!SUPPRESSED_EVENTS.has(frame.name)) {
      const summary = this.summarizeEventData(frame.name, frame.data);
      log.info('ws', `event "${frame.name}"`, { seq: frame.seq, listeners: listenerCount, ...summary });
    }

    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(frame.data);
      } catch (err) {
        log.error('ws', `event callback error for "${frame.name}"`, { error: String(err) });
      }
    }
  }

  /** Extract key fields for compact logging */
  private summarizeEventData(name: string, data: unknown): Record<string, unknown> {
    if (!data || typeof data !== 'object') return { data };
    const d = data as Record<string, unknown>;
    // For session events, show the most useful fields
    if (name.startsWith('session:')) {
      const summary: Record<string, unknown> = {};
      if (d.sessionId) summary.sessionId = d.sessionId;
      if (d.taskId) summary.taskId = d.taskId;
      if (d.process_status) summary.process_status = d.process_status;
      if (d.work_status) summary.work_status = d.work_status;
      if (d.mode) summary.mode = d.mode;
      if (d.activity) summary.activity = d.activity;
      if (d.planCompleted !== undefined) summary.planCompleted = d.planCompleted;
      if (d.title) summary.title = d.title;
      return Object.keys(summary).length > 0 ? summary : d;
    }
    // For task events, show id + title
    if (name.startsWith('task:') || name.startsWith('subtask:')) {
      const summary: Record<string, unknown> = {};
      if (d.id) summary.id = d.id;
      if (d.title) summary.title = d.title;
      if (d.phase) summary.phase = d.phase;
      return Object.keys(summary).length > 0 ? summary : d;
    }
    return d;
  }

  private handleResponse(frame: WsResFrame) {
    const pending = this.pendingRpc.get(frame.id);
    if (!pending) {
      log.warn('ws', `RPC:${frame.id} ← orphan response`);
      return;
    }
    this.pendingRpc.delete(frame.id);
    if (frame.ok) {
      log.info('ws', `RPC:${frame.id} ← OK`);
      pending.resolve(frame.payload);
    } else {
      log.warn('ws', `RPC:${frame.id} ← ERROR`, { error: frame.error });
      pending.reject(new Error(frame.error ?? 'RPC error'));
    }
  }

  private rejectPending(reason: string) {
    if (this.pendingRpc.size > 0) {
      log.warn('ws', 'rejecting pending RPCs', { count: this.pendingRpc.size, reason });
    }
    for (const [, p] of this.pendingRpc) {
      p.reject(new Error(reason));
    }
    this.pendingRpc.clear();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    log.info('ws', 'reconnecting', { delayMs: this.reconnectDelay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}

/** Singleton WS client instance */
export const wsClient = new WsClient();
