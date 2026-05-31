/**
 * useSessionTerminal — drives the WS lifecycle for one embedded terminal.
 *
 * Owns: open/attach RPC, subscription to `terminal:data:<id>` / `terminal:exit:<id>`,
 * and reconnect handling (`_ws:reconnected` → try attach, fall back to open which
 * re-attaches the persistent tmux session). The xterm instance itself is owned by
 * the component — this hook just calls `onData` with incoming bytes and exposes
 * `sendInput` / `sendResize` / `kill` / `retry`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from './useWebSocket';
import {
  terminalOpen,
  terminalAttach,
  terminalInput,
  terminalResize,
  terminalClose,
  terminalKill,
  type TerminalNoTmux,
} from '@/api/terminal';
import { log } from '@/utils/log';

export type TerminalStatus = 'idle' | 'connecting' | 'ready' | 'no_tmux' | 'error' | 'exited';

interface UseSessionTerminalOpts {
  sessionId: string;
  enabled: boolean;
  /** Called with incoming terminal bytes (write to xterm). */
  onData: (data: string) => void;
  /** Called when the pty exits. */
  onExit?: (exitCode: number, signal: number | null) => void;
  /** Current terminal size — read at open/attach time. */
  getSize: () => { cols: number; rows: number };
}

interface UseSessionTerminalReturn {
  status: TerminalStatus;
  noTmux: TerminalNoTmux | null;
  errorMessage: string | null;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  /** Explicitly destroy (kills tmux). */
  kill: () => void;
  /** Re-attempt open (used by the NO_TMUX retry button). */
  retry: () => void;
}

export function useSessionTerminal(opts: UseSessionTerminalOpts): UseSessionTerminalReturn {
  const { sessionId, enabled, onData, onExit, getSize } = opts;
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [noTmux, setNoTmux] = useState<TerminalNoTmux | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const terminalIdRef = useRef<string | null>(null);
  // Keep latest callbacks in refs so the open/attach logic stays stable.
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const getSizeRef = useRef(getSize);
  getSizeRef.current = getSize;
  // Coalesce concurrent open() calls. The mount effect and the
  // `_ws:reconnected` handler can both fire open() before the first RPC
  // resolves; without this guard we'd send two terminal:open RPCs.
  const openingRef = useRef(false);

  const open = useCallback(async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    const { cols, rows } = getSizeRef.current();
    setStatus('connecting');
    setNoTmux(null);
    setErrorMessage(null);
    try {
      const res = await terminalOpen(sessionId, cols, rows);
      if (!res.ok) {
        terminalIdRef.current = null;
        setNoTmux(res);
        setStatus('no_tmux');
        log.warn('terminal', 'open rejected: NO_TMUX', { sessionId, host: res.host });
        return;
      }
      terminalIdRef.current = res.terminalId;
      setStatus('ready');
      log.info('terminal', 'opened', { sessionId, terminalId: res.terminalId });
    } catch (err) {
      terminalIdRef.current = null;
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus('error');
      log.warn('terminal', 'open failed', { sessionId, error: String(err) });
    } finally {
      openingRef.current = false;
    }
  }, [sessionId]);

  // Open when enabled; tear down (detach, keep tmux) when disabled/unmounted.
  useEffect(() => {
    if (!enabled) return;
    void open();
    return () => {
      const id = terminalIdRef.current;
      if (id) {
        terminalClose(id).catch(() => { /* best-effort */ });
      }
      terminalIdRef.current = null;
    };
  }, [enabled, open]);

  // Live output for this terminal. NOTE: we subscribe by sessionId because the
  // backend sets terminalId == sessionId (one terminal per session — see
  // TerminalManager.spawnTerminal). If that coupling is ever broken (e.g.
  // terminalId becomes a UUID), this subscription must switch to terminalIdRef
  // or events will silently stop arriving.
  useEvent(`terminal:data:${sessionId}`, (data) => {
    const d = data as { data?: string };
    if (typeof d?.data === 'string') onDataRef.current(d.data);
  });

  // pty exit.
  useEvent(`terminal:exit:${sessionId}`, (data) => {
    const d = data as { exitCode?: number; signal?: number | null };
    setStatus('exited');
    onExitRef.current?.(d?.exitCode ?? 0, d?.signal ?? null);
    log.info('terminal', 'exited', { sessionId, exitCode: d?.exitCode });
  });

  // On WS reconnect: try cheap attach (pty still alive in grace window);
  // on failure, reopen — server re-attaches the persistent tmux session.
  useEvent('_ws:reconnected', () => {
    if (!enabled) return;
    const id = terminalIdRef.current;
    const { cols, rows } = getSizeRef.current();
    if (id) {
      terminalAttach(id, cols, rows)
        .then((r) => {
          if (r.ok) {
            setStatus('ready');
            log.info('terminal', 'reattached', { sessionId, terminalId: id });
          } else {
            void open();
          }
        })
        .catch(() => { void open(); });
    } else {
      void open();
    }
  });

  const sendInput = useCallback((data: string) => {
    const id = terminalIdRef.current;
    if (id) terminalInput(id, data).catch(() => { /* dropped on disconnect */ });
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const id = terminalIdRef.current;
    if (id) terminalResize(id, cols, rows).catch(() => { /* dropped on disconnect */ });
  }, []);

  const kill = useCallback(() => {
    const id = terminalIdRef.current;
    if (id) {
      terminalKill(id).catch(() => { /* best-effort */ });
      terminalIdRef.current = null;
      setStatus('exited');
    }
  }, []);

  const retry = useCallback(() => { void open(); }, [open]);

  return { status, noTmux, errorMessage, sendInput, sendResize, kill, retry };
}
