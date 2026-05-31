import { describe, it, expect } from 'vitest';
import {
  tmuxSessionName,
  buildLocalTmuxArgs,
  buildRemoteTmuxCommand,
  buildRemoteSshArgs,
} from '../../../src/web/terminal/spawn.js';
import type { SshTarget } from '../../../src/providers/session-io.js';

describe('tmuxSessionName', () => {
  it('derives a stable name from the session id', () => {
    expect(tmuxSessionName('abc-123')).toBe('walnut-abc-123');
  });

  it('is stable across calls — guarantees idempotent re-attach after server restart', () => {
    const sid = 'sess-xyz';
    expect(tmuxSessionName(sid)).toBe(tmuxSessionName(sid));
  });

  it('rejects ids with shell metacharacters (fail fast, no injectable command)', () => {
    expect(() => tmuxSessionName('test$(whoami)')).toThrow(/Unsafe session id/);
    expect(() => tmuxSessionName('test;id')).toThrow(/Unsafe session id/);
    expect(() => tmuxSessionName('a b')).toThrow(/Unsafe session id/);
    // Real Claude session IDs (UUID form) are accepted.
    expect(tmuxSessionName('7b370f7c-c1bd-4961-b7cf-2a69d34d5854')).toBe('walnut-7b370f7c-c1bd-4961-b7cf-2a69d34d5854');
  });
});

describe('buildLocalTmuxArgs', () => {
  it('uses new-session -A (idempotent attach-or-create) with -s and -c', () => {
    expect(buildLocalTmuxArgs('sid1', '/home/u/proj')).toEqual([
      'new-session', '-A', '-s', 'walnut-sid1', '-c', '/home/u/proj',
    ]);
  });

  it('omits -c when no cwd (tmux falls back to home)', () => {
    expect(buildLocalTmuxArgs('sid1')).toEqual(['new-session', '-A', '-s', 'walnut-sid1']);
  });
});

describe('buildRemoteTmuxCommand', () => {
  it('builds a shell-quoted remote tmux command with cwd', () => {
    expect(buildRemoteTmuxCommand('sid2', '/var/data')).toBe(
      "tmux new-session -A -s walnut-sid2 -c '/var/data'",
    );
  });

  it('shell-quotes cwd containing single quotes safely', () => {
    const cmd = buildRemoteTmuxCommand('sid2', "/weird/it's here");
    expect(cmd).toBe("tmux new-session -A -s walnut-sid2 -c '/weird/it'\\''s here'");
  });

  it('omits -c when no cwd', () => {
    expect(buildRemoteTmuxCommand('sid2')).toBe('tmux new-session -A -s walnut-sid2');
  });
});

describe('buildRemoteSshArgs', () => {
  const target: SshTarget = { hostname: 'dev.example.com', user: 'alice' };

  it('forces a remote PTY (-tt) and enables keepalive', () => {
    const args = buildRemoteSshArgs('sid3', target, '/home/alice/x');
    expect(args).toContain('-tt');
    expect(args).toContain('ServerAliveInterval=15');
    expect(args).toContain('ServerAliveCountMax=3');
    expect(args).toContain('BatchMode=yes');
  });

  it('targets user@hostname and ends with the tmux command', () => {
    const args = buildRemoteSshArgs('sid3', target, '/home/alice/x');
    expect(args).toContain('alice@dev.example.com');
    expect(args[args.length - 1]).toBe(
      "tmux new-session -A -s walnut-sid3 -c '/home/alice/x'",
    );
  });

  it('adds -p when a port is configured', () => {
    const args = buildRemoteSshArgs('sid3', { hostname: 'h', port: 2222 }, undefined);
    expect(args).toContain('-p');
    expect(args).toContain('2222');
  });

  it('omits user prefix when no user is set', () => {
    const args = buildRemoteSshArgs('sid3', { hostname: 'h' }, undefined);
    expect(args).toContain('h');
    expect(args).not.toContain('@h');
  });
});
