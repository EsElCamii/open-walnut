/**
 * SessionTerminal — embedded xterm.js terminal for a session, in a portal modal.
 *
 * The shell runs under dtach on the target host (local or remote/SSH) so its
 * state survives disconnects. dtach (unlike tmux) does NOT grab the mouse or use
 * an alternate screen, so xterm.js keeps native scroll + drag-select + copy.
 * This component owns the xterm instance (in a ref — never React state, since
 * xterm manages its own canvas/DOM) and delegates the WS lifecycle to
 * useSessionTerminal.
 *
 * When dtach can't be provisioned on the target, useSessionTerminal returns a
 * NO_DTACH result and we render an install-hint card instead of mounting xterm.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useSessionTerminal } from '@/hooks/useSessionTerminal';

interface SessionTerminalProps {
  sessionId: string;
  /** Display label (host alias or cwd) for the header. */
  label?: string;
  host?: string;
  onClose: () => void;
}

export function SessionTerminal({ sessionId, label, host, onClose }: SessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [copied, setCopied] = useState(false);

  const getSize = useCallback(() => {
    const t = termRef.current;
    return t ? { cols: t.cols, rows: t.rows } : { cols: 80, rows: 24 };
  }, []);

  const { status, noDtach, errorMessage, sendInput, sendResize, kill, retry } = useSessionTerminal({
    sessionId,
    enabled: true,
    onData: (data) => termRef.current?.write(data),
    onExit: (code) => termRef.current?.write(`\r\n\x1b[90m[process exited${code ? ` (code ${code})` : ''}]\x1b[0m\r\n`),
    getSize,
  });

  // Create the xterm instance once. Skip while NO_DTACH (no terminal to mount).
  useEffect(() => {
    if (noDtach) return;
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1a1b26', foreground: '#c0caf5' },
      // Large native scrollback: dtach doesn't use an alternate screen, so the
      // browser keeps the full output history and the scroll wheel scrolls it
      // natively (no tmux copy-mode, no mouse grab).
      scrollback: 50000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    term.onData((d) => sendInput(d));

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [noDtach, sendInput]);

  // Refit on container resize; push the new size to the pty (debounced).
  useEffect(() => {
    if (noDtach || !containerRef.current) return;
    let raf = 0;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        fitRef.current?.fit();
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const t = termRef.current;
          if (t) sendResize(t.cols, t.rows);
        }, 100);
      });
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      if (debounce) clearTimeout(debounce);
    };
  }, [noDtach, sendResize]);

  // Focus the terminal once ready.
  useEffect(() => {
    if (status === 'ready') {
      fitRef.current?.fit();
      const t = termRef.current;
      if (t) {
        t.focus();
        sendResize(t.cols, t.rows);
      }
    }
  }, [status, sendResize]);

  // Escape closes (detach, dtach session kept).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleKill = useCallback(() => {
    if (window.confirm('结束终端会关闭 dtach 会话,正在运行的进程将被终止。确定吗?')) {
      kill();
      onClose();
    }
  }, [kill, onClose]);

  const handleCopyHint = useCallback(() => {
    const cmd = noDtach?.installHint?.split(/\s+#/)[0]?.trim();
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [noDtach]);

  const overlay = (
    <div className="session-terminal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="session-terminal-panel">
        <div className="session-terminal-header">
          <div className="session-terminal-title">
            <span className="session-terminal-icon">&#x2328;</span>
            <span className="session-terminal-label">{label ?? 'Terminal'}</span>
            {host && <span className="session-terminal-host">SSH: {host}</span>}
            <span className={`session-terminal-status session-terminal-status-${status}`}>{status}</span>
          </div>
          <div className="session-terminal-actions">
            {!noDtach && status !== 'no_dtach' && (
              <button className="session-terminal-btn session-terminal-btn-kill" onClick={handleKill} title="结束终端 (kill dtach)">
                结束终端
              </button>
            )}
            <button className="session-terminal-close" onClick={onClose} title="关闭 (Esc) — 保留 dtach 会话">
              &#x2715;
            </button>
          </div>
        </div>

        {noDtach ? (
          <div className="session-terminal-error-card">
            <div className="session-terminal-error-icon">&#x26A0;&#xFE0F;</div>
            <div className="session-terminal-error-title">
              无法启动终端:无法在目标主机{noDtach.host ? ` (${noDtach.host})` : ''} 上准备 dtach
            </div>
            <p className="session-terminal-error-body">
              终端用 dtach 保证 SSH 断开后会话不丢失。Walnut 会自动编译它,但该主机似乎缺少 C 编译器:
            </p>
            <div className="session-terminal-install">
              <code>{noDtach.installHint}</code>
              <button className="session-terminal-btn" onClick={handleCopyHint}>
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <button className="session-terminal-btn session-terminal-retry" onClick={retry}>
              重试
            </button>
          </div>
        ) : (
          <div className="session-terminal-body">
            <div className="session-terminal-xterm" ref={containerRef} />
            {status === 'error' && errorMessage && (
              <div className="session-terminal-inline-error">
                {errorMessage}
                <button className="session-terminal-btn" onClick={retry}>重试</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
