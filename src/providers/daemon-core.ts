/**
 * Daemon core primitives — pure functions with dependency injection.
 *
 * This module contains the lifecycle primitives (P1..P5 in the plan):
 *   P1  reapSession          — idempotent single death funnel
 *   P2  readRegistry / persistRegistry — write-ahead inventory
 *   P3  startOrphanPoll      — 1s adopted-session watchdog
 *   P4  reconcileRegistry    — startup adopt/reap sweep
 *   P5  broadcastSessionState — authoritative state channel
 *
 * All I/O + clock + process calls flow through the injected `deps` so the
 * functions are unit-testable in vitest without a real FIFO, SIGCHLD, or
 * /proc. The Bun adapter (daemon-standalone.ts) constructs this with real
 * deps; the embedded source template (daemon-source.ts) mirrors the same
 * behaviour for SSH-deployed daemons.
 */

import { execSync } from 'node:child_process'

// ── Shared types ──

export type SessionMode = 'bypass' | 'plan' | 'accept' | 'default'

export interface RegistryEntry {
  pid: number
  startTime: string | null
  pipePath: string
  jsonlPath: string
  pgidPath: string
  cwd: string
  args: string[]
  spawnedAt: string
  parented: boolean
  mode?: SessionMode
  pendingCtrl?: PendingCtrl | null
}

/**
 * The subset of session fields that core primitives read/write. The Bun
 * adapter's SessionData extends this with `proc`, `watchers`, and `offset`
 * fields that core doesn't need to know about.
 */
export interface PendingCtrl {
  reqId: string
  toolName: string
  request: Record<string, unknown>
  receivedAt: number
}

export interface CoreSessionData {
  pipePath: string
  jsonlPath: string
  pgidPath: string
  pid: number | null
  state: 'running' | 'dead'
  exitCode: number | null
  exitReason: string | null
  exitedAt: number | null
  parented: boolean
  startTime: string | null
  cwd: string
  args: string[]
  orphanPollTimer: ReturnType<typeof setInterval> | null
  mode: SessionMode
  pendingCtrl: PendingCtrl | null
}

export interface DaemonCoreDeps<S extends CoreSessionData = CoreSessionData> {
  fs: typeof import('node:fs')
  clock: () => number
  /** `process.kill(pid, sig)` — throws on ESRCH/EPERM. sig===0 is a liveness probe. */
  killFn: (pid: number, sig: number | string) => void
  /** Read /proc/<pid>/stat field 22 on Linux. Returns null on non-Linux or error. */
  readStartTimeFn: (pid: number) => string | null
  /** Send signal to an entire process group (pgid===pid for detached spawns). */
  killProcessGroupFn: (pid: number, signal: string) => boolean
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  setTimeoutFn?: typeof setTimeout
  streamsDir: string
  registryFile: string
  orphanPollIntervalMs?: number
  logger: (level: string, msg: string, meta?: Record<string, unknown>) => void
  /** Broadcasts `{ev:'session_state', sid, state, ...extra}` to all wsClients. */
  broadcastSessionStateFn: (payload: Record<string, unknown>) => void
  /**
   * Legacy exit fan-out to per-session watchers. Gets the session so adapter
   * can iterate `watchers`. Core doesn't know the watcher type.
   */
  broadcastExitToWatchersFn: (session: S, code: number, stderrTail: string | undefined) => void
  /** The live in-memory session map. Core reads/writes this directly. */
  sessions: Map<string, S>
  /**
   * Factory for materializing an adopted (orphan) session. Core calls this
   * during reconcileRegistry so the adapter can fill in its own extra fields
   * (watchers: new Map(), proc: null, offset: 0, ...).
   */
  createAdoptedSession: (sid: string, entry: RegistryEntry) => S
}

/** Outcome of a cmdSend attempt — mirrors the wire envelope sent to clients. */
export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'session_dead'; exitCode: number | null }
  | { ok: false; reason: 'ENXIO'; exitCode: number | null }
  | { ok: false; reason: 'EAGAIN'; retriable: true }
  | { ok: false; reason: 'partial_write' }
  | { error: string }  // missing sid/message or non-classified write failure

export interface DaemonCore<S extends CoreSessionData = CoreSessionData> {
  readRegistry: () => Record<string, RegistryEntry>
  persistRegistry: () => void
  readStartTime: (pid: number) => string | null
  reapSession: (sid: string, code: number, reason: string) => void
  startOrphanPoll: (sid: string) => void
  reconcileRegistry: () => void
  broadcastSessionState: (sid: string, state: 'running' | 'dead', extra?: Record<string, unknown>) => void
  /**
   * Strict-ack send handler. Takes sid + message, returns the SendResult the
   * client should receive. Side-effects: may call reapSession on precheck-dead
   * or ENXIO to converge the death funnel synchronously with the request.
   */
  handleSendCommand: (sid: string | undefined, message: string | undefined) => SendResult
  /**
   * Same as handleSendCommand but writes `raw` to the FIFO verbatim without
   * the `{type:"user",...}` wrapping. Used for control_response messages from
   * the --permission-prompt-tool stdio protocol — the CLI expects its own
   * control envelope and rejects anything wrapped in user-message shape.
   */
  handleSendRawCommand: (sid: string | undefined, raw: string | undefined) => SendResult
}

export function createDaemonCore<S extends CoreSessionData = CoreSessionData>(
  deps: DaemonCoreDeps<S>,
): DaemonCore<S> {
  const {
    fs,
    clock,
    killFn,
    readStartTimeFn,
    killProcessGroupFn,
    streamsDir,
    registryFile,
    logger,
    broadcastSessionStateFn,
    broadcastExitToWatchersFn,
    sessions,
    createAdoptedSession,
  } = deps
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout
  const orphanPollIntervalMs = deps.orphanPollIntervalMs ?? 1000

  /**
   * Read the last line of the JSONL output and decide whether the CLI
   * completed a turn cleanly. `claude -p --input-format stream-json` writes
   * a final {"type":"result","stop_reason":"end_turn"} line and then exits 0
   * at the end of every turn — so "last line is a result with stop_reason"
   * is the authoritative signal that the process died because the turn was
   * over, not because of a crash, OOM, or other failure.
   */
  function isTurnCompleteExit(jsonlPath: string): boolean {
    try {
      const stat = fs.statSync(jsonlPath)
      if (stat.size === 0) return false
      const readLen = Math.min(stat.size, 8192)
      const start = Math.max(0, stat.size - readLen)
      const fd = fs.openSync(jsonlPath, 'r')
      const buf = Buffer.alloc(readLen)
      fs.readSync(fd, buf, 0, readLen, start)
      fs.closeSync(fd)
      const text = buf.toString('utf-8')
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length === 0) return false
      const last = lines[lines.length - 1]
      const parsed = JSON.parse(last) as { type?: string; stop_reason?: string; subtype?: string }
      if (parsed.type !== 'result') return false
      // Accept any stop_reason that represents a CLI-initiated clean exit:
      // end_turn (normal), tool_use (completed after tool), max_tokens, etc.
      // Only reject if the line signals an outright error.
      if (parsed.subtype === 'error_max_turns' || parsed.subtype === 'error_during_execution') return false
      return true
    } catch {
      return false
    }
  }

  function readRegistry(): Record<string, RegistryEntry> {
    try {
      const raw = fs.readFileSync(registryFile, 'utf-8')
      const data = JSON.parse(raw)
      if (
        data
        && typeof data === 'object'
        && data.sessions
        && typeof data.sessions === 'object'
      ) {
        return data.sessions as Record<string, RegistryEntry>
      }
    } catch {}
    return {}
  }

  function persistRegistry(): void {
    const out: Record<string, RegistryEntry> = {}
    for (const [sid, s] of sessions) {
      if (s.state !== 'running' || !s.pid) continue
      out[sid] = {
        pid: s.pid,
        startTime: s.startTime,
        pipePath: s.pipePath,
        jsonlPath: s.jsonlPath,
        pgidPath: s.pgidPath,
        cwd: s.cwd,
        args: s.args,
        spawnedAt: new Date(clock()).toISOString(),
        parented: s.parented,
        mode: s.mode,
        pendingCtrl: s.pendingCtrl ?? undefined,
      }
    }
    const body = JSON.stringify({ version: 1, sessions: out })
    const tmp = registryFile + '.tmp'
    try {
      fs.writeFileSync(tmp, body)
      try {
        const fd = fs.openSync(tmp, 'r+')
        try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      } catch {}
      fs.renameSync(tmp, registryFile)
    } catch (err) {
      logger('warn', 'registry persist failed', { error: (err as Error).message })
    }
  }

  function broadcastSessionState(
    sid: string,
    state: 'running' | 'dead',
    extra: Record<string, unknown> = {},
  ): void {
    broadcastSessionStateFn({ sid, state, ...extra })
  }

  /**
   * Idempotent single death funnel. All death paths converge here:
   *   - proc.on('exit') SIGCHLD (parented sessions)
   *   - orphan poll ESRCH / pid-recycled (adopted sessions)
   *   - cmdSend ENXIO (FIFO write detected dead reader)
   *   - idle scanner missed-exit fallback
   *   - cmdStop (explicit user stop)
   *   - startup reconcile (dead pids, pid-recycled, not-ours)
   *
   * Guard `state === 'dead'` makes concurrent callers safe. Every step is
   * isolated in try/catch so an unlink race or missing file cannot wedge the
   * rest of cleanup (persist + broadcast must still run).
   */
  function reapSession(sid: string, code: number, reason: string): void {
    const session = sessions.get(sid)
    if (!session) return
    if (session.state === 'dead') return  // idempotent guard

    // Detect "clean turn completion": claude -p writes a final {"type":"result",
    // "stop_reason":"end_turn"} line then exits 0. Every death path here
    // (orphan-poll, send-precheck, send-enxio) can't see the real exit code
    // because the process was adopted (no ChildProcess handle) or died between
    // SIGCHLD and our poll. Inspect JSONL tail as the authoritative signal —
    // if the CLI finished a turn cleanly, report code=0 so the walnut client
    // treats this as a normal turn boundary, not an error.
    const cleanExit = isTurnCompleteExit(session.jsonlPath)
    // Age of JSONL matters: a fresh spawn that dies within a few seconds
    // almost certainly never wrote its own type:result, so `cleanExit=true`
    // would be reading the previous turn's residue. Log it so we can spot
    // mis-normalized deaths instead of silently changing code=-1 → 0.
    let jsonlAgeMs: number | null = null
    try { jsonlAgeMs = clock() - fs.statSync(session.jsonlPath).mtimeMs } catch {}
    if (cleanExit && code !== 0) {
      logger('info', 'reapSession: turn-complete detected, normalizing exit code', {
        sid, pid: session.pid, originalCode: code, originalReason: reason, jsonlAgeMs,
      })
      code = 0
      reason = reason + '+turn-complete'
    }

    // Emit state_transition BEFORE the mutation so any concurrent reader
    // observing logger output sees the transition intent before the fact.
    logger('info', 'state_transition', {
      sid,
      oldState: 'running',
      newState: 'dead',
      reason,
      source: 'reapSession',
      pid: session.pid,
      code,
      cleanExit,
      jsonlAgeMs,
    })
    session.state = 'dead'
    session.exitCode = code
    session.exitReason = reason
    session.exitedAt = clock()

    logger('info', 'reapSession', {
      sid, pid: session.pid, code, reason, cleanExit, jsonlAgeMs,
    })

    // Stop orphan watchdog if we were polling kill(pid,0) for this session.
    if (session.orphanPollTimer) {
      try { clearIntervalFn(session.orphanPollTimer) } catch {}
      session.orphanPollTimer = null
    }

    // Unlink FIFO — prevents future writers from thinking the session is alive.
    // kernel buffers on a readerless FIFO silently swallow writes; deleting the
    // path means next open(O_WRONLY|O_NONBLOCK) returns ENXIO instead.
    try { fs.unlinkSync(session.pipePath) } catch {}

    // Kill any residual process group members (MCP servers outliving claude).
    if (session.pid) {
      try { killProcessGroupFn(session.pid, 'SIGTERM') } catch {}
      setTimeoutFn(() => {
        if (session.pid) {
          try { killProcessGroupFn(session.pid, 'SIGKILL') } catch {}
        }
      }, 2000)
    }

    // Drain tail of stderr for diagnostics before broadcast.
    let stderrTail: string | undefined
    try {
      const errPath = session.jsonlPath + '.err'
      const errStat = fs.statSync(errPath)
      if (errStat.size > 0) {
        const readLen = Math.min(errStat.size, 4096)
        const start = Math.max(0, errStat.size - readLen)
        const fd = fs.openSync(errPath, 'r')
        const buf = Buffer.alloc(readLen)
        fs.readSync(fd, buf, 0, readLen, start)
        fs.closeSync(fd)
        stderrTail = buf.toString('utf-8').trim() || undefined
      }
    } catch {}

    // Persist registry change before broadcasting so a daemon crash between
    // broadcast and persist can't leave a stale entry pointing at a dead pid.
    try { persistRegistry() } catch {}

    // Legacy exit fan-out to per-session watchers (backcompat).
    try { broadcastExitToWatchersFn(session, code, stderrTail) } catch {}

    // Authoritative session_state=dead to ALL clients.
    broadcastSessionState(sid, 'dead', { exitCode: code, reason, stderr: stderrTail })
  }

  /**
   * 1s orphan poll — adopted sessions have no ChildProcess, so SIGCHLD never
   * fires. Poll kill(pid,0) and /proc start_time instead. Parented sessions
   * don't need this (proc.on('exit') is ~0ms).
   */
  function startOrphanPoll(sid: string): void {
    const session = sessions.get(sid)
    if (!session) return
    if (session.state !== 'running') return
    if (!session.pid) return
    if (session.orphanPollTimer) return  // idempotent
    const pid = session.pid
    const capturedStartTime = session.startTime
    logger('info', 'startOrphanPoll: started', { sid, pid, startTime: capturedStartTime })
    const timer = setIntervalFn(() => {
      const s = sessions.get(sid)
      if (!s || s.state !== 'running') {
        if (s?.orphanPollTimer) {
          try { clearIntervalFn(s.orphanPollTimer) } catch {}
          s.orphanPollTimer = null
        }
        return
      }
      // Stale-timer guard: if cmdStart replaced the session under us, this
      // interval's captured `pid` no longer matches `s.pid`. Do NOT reap —
      // the newer session has its own lifecycle. Just self-terminate.
      //
      // Before this guard, a stale timer from an adopted orphan would still
      // be comparing the captured (old) pid's /proc start_time against the
      // freshly-written s.startTime (new pid), see them differ, and mis-fire
      // `reapSession(sid, -1, 'pid-recycled')` — killing the newborn CLI
      // while the old pid kept running unreaped. Symptom: every `--resume`
      // spawn died ~1s after starting with reason `pid-recycled+turn-complete`.
      if (s.pid !== pid) {
        logger('warn', 'orphan poll: stale timer detected (session replaced), self-terminating', {
          sid, capturedPid: pid, currentPid: s.pid,
        })
        try { clearIntervalFn(timer) } catch {}
        // Don't null s.orphanPollTimer — it belongs to the new session now.
        return
      }
      try { killFn(pid, 0) } catch {
        logger('info', 'orphan poll: kill(pid,0) ESRCH — reaping', { sid, pid })
        reapSession(sid, -1, 'orphan-poll-dead')
        return
      }
      // PID recycling defence: different start_time means the kernel handed
      // the pid to somebody else after the original CLI died.
      if (capturedStartTime) {
        const current = readStartTimeFn(pid)
        if (current && current !== capturedStartTime) {
          logger('warn', 'orphan poll: pid recycled (start_time drift) — reaping', {
            sid, pid, captured: capturedStartTime, current,
          })
          reapSession(sid, -1, 'pid-recycled')
        }
      }
    }, orphanPollIntervalMs)
    session.orphanPollTimer = timer
  }

  /**
   * Startup reconcile. Reads on-disk registry, probes each pid, and adopts
   * the living ones as orphans or reaps the dead/recycled/not-ours ones.
   * Also sweeps zombie FIFOs out of the streams directory.
   */
  function reconcileRegistry(): void {
    const registry = readRegistry()
    for (const [sid, entry] of Object.entries(registry)) {
      const pid = entry.pid
      if (!pid || pid <= 0) continue

      // Re-entrant safety: if a session is already in the map (previous
      // reconcile or in-flight spawn), don't overwrite it — that would leak
      // the existing orphanPollTimer and re-broadcast adopted=true.
      if (sessions.has(sid)) continue

      // Materialize session record first so reapSession has something to act
      // on. Adapter's factory fills in its own extra fields (watchers, ...).
      const session = createAdoptedSession(sid, entry)
      sessions.set(sid, session)

      // Is the pid alive and ours?
      try {
        killFn(pid, 0)
      } catch (err) {
        const errCode = (err as NodeJS.ErrnoException).code
        if (errCode === 'EPERM') {
          reapSession(sid, -1, 'reconcile-not-ours')
          continue
        }
        // ESRCH or other — dead.
        reapSession(sid, -1, 'reconcile-dead')
        continue
      }

      // Alive and ours — verify start_time to catch pid recycling.
      if (entry.startTime) {
        const current = readStartTimeFn(pid)
        if (current && current !== entry.startTime) {
          reapSession(sid, -1, 'reconcile-pid-recycled')
          continue
        }
      }

      // Genuine orphan — adopt and kick off 1s tight poll.
      logger('info', 'state_transition', {
        sid,
        oldState: 'none',
        newState: 'running',
        reason: 'reconcile-adopt',
        source: 'reconcileRegistry',
        pid,
      })
      logger('info', 'reconcile: adopted orphan session', { sid, pid })
      startOrphanPoll(sid)
      broadcastSessionState(sid, 'running', { pid, adopted: true })
    }

    // Zombie FIFO sweep — unlink *.pipe files in streams dir that don't
    // belong to a registered session. Prevents unbounded file growth across
    // crash/restart cycles.
    try {
      const files = fs.readdirSync(streamsDir)
      for (const f of files) {
        if (!f.endsWith('.pipe')) continue
        const sid = f.replace('.pipe', '')
        if (!sessions.has(sid)) {
          try { fs.unlinkSync(`${streamsDir}/${f}`) } catch {}
        }
      }
    } catch {}
  }

  /**
   * Strict-ack send handler. Core owns the branching logic (not_found /
   * session_dead / precheck-dead / ENXIO / EAGAIN / partial / OK); adapters
   * own the FIFO write path (provided via writeFifoFn) and the wire dispatch.
   */
  function handleSendCommand(sid: string | undefined, message: string | undefined): SendResult {
    if (!sid || !message) return { error: 'send: missing sid or message' }

    const session = sessions.get(sid)
    if (!session) return { ok: false, reason: 'not_found' }
    if (session.state === 'dead') {
      return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
    }

    // Pre-flight kill(pid,0) for hot-path death detection. If kill throws, the
    // process already died — reap now and return session_dead so the caller
    // doesn't try (and fail) to write the FIFO.
    if (session.pid) {
      try {
        killFn(session.pid, 0)
      } catch {
        reapSession(sid, -1, 'send-precheck-dead')
        return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
      }
    }

    // FIFO write — adapter can plug in a different writer, but the default
    // (see daemon-standalone.ts) is fs.openSync + writeSync + closeSync.
    try {
      const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: message } })
      const buf = Buffer.from(payload + '\n')
      const fd = fs.openSync(session.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      try {
        const written = fs.writeSync(fd, buf)
        if (written !== buf.length) return { ok: false, reason: 'partial_write' }
      } finally {
        fs.closeSync(fd)
      }
      return { ok: true }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENXIO') {
        // FIFO write with no reader → CLI is dead. Reap so next send sees the
        // dead state and skips the FIFO attempt.
        reapSession(sid, -1, 'send-enxio')
        return { ok: false, reason: 'ENXIO', exitCode: session.exitCode }
      }
      if (code === 'EAGAIN') {
        return { ok: false, reason: 'EAGAIN', retriable: true }
      }
      return { error: 'send failed: ' + (err as Error).message }
    }
  }

  /**
   * Raw FIFO write — bypasses the `{type:"user",...}` envelope. Caller provides
   * a complete JSON line (e.g. a control_response for --permission-prompt-tool).
   * Shares the pre-flight kill check, ENXIO death-funnel, and EAGAIN retry
   * semantics with handleSendCommand.
   */
  function handleSendRawCommand(sid: string | undefined, raw: string | undefined): SendResult {
    if (!sid || !raw) return { error: 'sendRaw: missing sid or raw' }

    const session = sessions.get(sid)
    if (!session) return { ok: false, reason: 'not_found' }
    if (session.state === 'dead') {
      return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
    }

    if (session.pid) {
      try {
        killFn(session.pid, 0)
      } catch {
        reapSession(sid, -1, 'sendRaw-precheck-dead')
        return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
      }
    }

    try {
      const buf = Buffer.from(raw.endsWith('\n') ? raw : raw + '\n')
      const fd = fs.openSync(session.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      try {
        const written = fs.writeSync(fd, buf)
        if (written !== buf.length) return { ok: false, reason: 'partial_write' }
      } finally {
        fs.closeSync(fd)
      }
      return { ok: true }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENXIO') {
        reapSession(sid, -1, 'sendRaw-enxio')
        return { ok: false, reason: 'ENXIO', exitCode: session.exitCode }
      }
      if (code === 'EAGAIN') {
        return { ok: false, reason: 'EAGAIN', retriable: true }
      }
      return { error: 'sendRaw failed: ' + (err as Error).message }
    }
  }

  return {
    readRegistry,
    persistRegistry,
    readStartTime: readStartTimeFn,
    reapSession,
    startOrphanPoll,
    reconcileRegistry,
    broadcastSessionState,
    handleSendCommand,
    handleSendRawCommand,
  }
}

/**
 * Default readStartTime implementation — reads /proc/<pid>/stat field 22 on
 * Linux, returns null on macOS and anywhere /proc isn't available.
 *
 * Exposed so the Bun adapter and unit-test fixtures can share one impl.
 */
/**
 * Permission policy: should the daemon auto-respond to a control_request?
 * Returns true if daemon should write allow response directly to FIFO.
 */
export function shouldAutoRespond(mode: SessionMode, toolName: string | undefined): boolean {
  if (mode === 'bypass') return true
  // ExitPlanMode is forwarded to walnut (not auto-allowed) because in `-p` mode
  // the CLI returns is_error=true for this tool, requiring interactive approval.
  // Auto-allowing would send a false "plan complete" signal.
  if (mode === 'plan') return toolName !== 'ExitPlanMode'
  return false
}

/**
 * Build the control_response JSON for writing to the FIFO.
 * Format must match claude-code-session.ts respondToControlRequest().
 */
export function buildControlResponse(requestId: string, request: Record<string, unknown>, allow: boolean, message?: string): string {
  const result = allow
    ? { behavior: 'allow' as const, updatedInput: request.input ?? {} }
    : { behavior: 'deny' as const, message: message ?? 'Permission denied by daemon policy' }
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: result,
    },
  })
}

export function defaultReadStartTime(fs: typeof import('node:fs'), pid: number): string | null {
  // Linux: /proc/<pid>/stat field 22 (kernel start time in clock ticks)
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const rparen = raw.lastIndexOf(')')
    if (rparen < 0) return null
    // After ") ", field[0]=state, ..., start_time is at index 19.
    const fields = raw.slice(rparen + 2).split(' ')
    return fields[19] ?? null
  } catch {}
  // macOS: ps -p <pid> -o lstart= (e.g. "Thu May  6 18:59:15 2026")
  // Force LANG=C so localized day/month names don't break startTime comparisons
  // when the daemon starts under one locale but reconciles under another.
  try {
    const result = (execSync(`ps -p ${pid} -o lstart=`, { encoding: 'utf-8', timeout: 2000, env: { ...process.env, LANG: 'C' } }) as string).trim()
    return result || null
  } catch {}
  return null
}
