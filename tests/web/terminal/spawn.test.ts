import { describe, it, expect } from 'vitest';
import {
  dtachSocketPath,
  buildDtachArgs,
  buildRemoteDtachCommand,
  buildRemoteSshArgs,
  DTACH_SOCKET_DIR,
} from '../../../src/web/terminal/spawn.js';
import type { SshTarget } from '../../../src/providers/session-io.js';

describe('dtachSocketPath', () => {
  it('derives a stable socket path under the dedicated dir from the session id', () => {
    expect(dtachSocketPath('abc-123')).toBe(`${DTACH_SOCKET_DIR}/walnut-abc-123.dsock`);
  });

  it('is stable across calls — guarantees idempotent re-attach after server restart', () => {
    const sid = 'sess-xyz';
    expect(dtachSocketPath(sid)).toBe(dtachSocketPath(sid));
  });

  it('rejects ids with shell metacharacters (fail fast, no injectable command)', () => {
    expect(() => dtachSocketPath('test$(whoami)')).toThrow(/Unsafe session id/);
    expect(() => dtachSocketPath('test;id')).toThrow(/Unsafe session id/);
    expect(() => dtachSocketPath('a b')).toThrow(/Unsafe session id/);
    // Real Claude session IDs (UUID form) are accepted.
    expect(dtachSocketPath('7b370f7c-c1bd-4961-b7cf-2a69d34d5854')).toBe(
      `${DTACH_SOCKET_DIR}/walnut-7b370f7c-c1bd-4961-b7cf-2a69d34d5854.dsock`,
    );
  });
});

describe('buildDtachArgs (local)', () => {
  it('uses -A (attach-or-create) + native-friendly flags, no mouse/screen grab', () => {
    // -A: idempotent attach-or-create (like tmux new-session -A).
    // -z: Ctrl-Z reaches the shell. -E: Ctrl-\ reaches the program (we detach by
    // closing the connection, not a keystroke). -r winch: redraw on reattach.
    const args = buildDtachArgs('/path/dtach', 'sid1', '/bin/zsh');
    expect(args).toEqual([
      '/path/dtach', '-A', `${DTACH_SOCKET_DIR}/walnut-sid1.dsock`, '-z', '-E', '-r', 'winch', '/bin/zsh',
    ]);
  });
});

describe('buildRemoteDtachCommand', () => {
  it('makes the socket dir, cds to cwd, then exec dtach -A', () => {
    expect(buildRemoteDtachCommand('/home/u/.local/bin/walnut-dtach', 'sid2', 'bash', '/var/data')).toBe(
      `mkdir -p '${DTACH_SOCKET_DIR}'; cd '/var/data' && exec '/home/u/.local/bin/walnut-dtach' -A '${DTACH_SOCKET_DIR}/walnut-sid2.dsock' -z -E -r winch 'bash'`,
    );
  });

  it('shell-quotes a cwd containing single quotes safely', () => {
    const cmd = buildRemoteDtachCommand('dtach', 'sid2', 'bash', "/weird/it's here");
    expect(cmd).toContain("cd '/weird/it'\\''s here' &&");
  });

  it('omits the cd prefix when no cwd (still makes the socket dir + execs dtach)', () => {
    expect(buildRemoteDtachCommand('dtach', 'sid2', 'bash')).toBe(
      `mkdir -p '${DTACH_SOCKET_DIR}'; exec 'dtach' -A '${DTACH_SOCKET_DIR}/walnut-sid2.dsock' -z -E -r winch 'bash'`,
    );
  });
});

describe('buildRemoteSshArgs', () => {
  const target: SshTarget = { hostname: 'dev.example.com', user: 'alice' };

  it('forces a remote PTY (-tt) and enables keepalive', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', target, 'bash', '/home/alice/x');
    expect(args).toContain('-tt');
    expect(args).toContain('ServerAliveInterval=15');
    expect(args).toContain('ServerAliveCountMax=3');
    expect(args).toContain('BatchMode=yes');
  });

  it('targets user@hostname and ends with the dtach command', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', target, 'bash', '/home/alice/x');
    expect(args).toContain('alice@dev.example.com');
    const last = args[args.length - 1];
    expect(last).toContain(`mkdir -p '${DTACH_SOCKET_DIR}'`);
    expect(last).toContain("cd '/home/alice/x' && exec 'dtach' -A");
    expect(last).toContain('walnut-sid3.dsock');
  });

  it('adds -p when a port is configured', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', { hostname: 'h', port: 2222 }, 'bash', undefined);
    expect(args).toContain('-p');
    expect(args).toContain('2222');
  });

  it('omits user prefix when no user is set', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', { hostname: 'h' }, 'bash', undefined);
    expect(args).toContain('h');
    expect(args).not.toContain('@h');
  });

  it('includes the ControlMaster socket args when a host alias is given', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', target, 'bash', '/x', 'devbox');
    expect(args).toContain('ControlMaster=auto');
    expect(args.some((a) => a.includes('walnut-term-ssh-devbox'))).toBe(true);
  });
});
