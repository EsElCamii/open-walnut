#!/usr/bin/env bun
'use strict'

/**
 * walnut-daemon — Remote session manager for Open Walnut.
 *
 * Runs as a persistent server on the remote machine.
 * Manages Claude CLI processes and streams output via WebSocket.
 *
 * Usage:
 *   bun daemon-standalone.ts --start      # Start daemon, print port to stdout
 *   bun daemon-standalone.ts --stop       # Stop running daemon
 *   bun daemon-standalone.ts --status     # Check if daemon is running
 *   bun daemon-standalone.ts --version    # Print version and exit
 *
 * Protocol: JSON over WebSocket
 *   Client → Daemon: { id, cmd, ...params }
 *   Daemon → Client: { id, ok, ...data } or { ev, ...data }
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { ServerWebSocket } from 'bun'

// ── Version flag ──
if (process.argv.includes('--version')) {
  console.log(process.env.DAEMON_VERSION || 'dev')
  process.exit(0)
}

// ── Constants ──
const DAEMON_DIR = '/tmp/open-walnut'
const STREAMS_DIR = '/tmp/open-walnut-streams'
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const LOG_FILE = path.join(DAEMON_DIR, 'daemon.log')
const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
const AGENT_POLL_INTERVAL_MS = 2000
const AGENT_REDISCOVER_INTERVAL_MS = 10000

// ── PATH setup ──
// When running as a compiled binary, the daemon starts with a bare PATH.
// Discover common tool locations so spawned CLI processes (claude, node) work.
// Claude CLI (#!/usr/bin/env node) needs BOTH claude AND node in PATH.
;(() => {
  const home = process.env.HOME || '/root'
  const extraPaths = [
    `${home}/.local/bin`,              // Claude CLI default install location
    `${home}/.npm-global/bin`,         // npm global
    `${home}/.cargo/bin`,              // Rust tools
    `${home}/.pyenv/shims`,           // pyenv (node via pyenv)
    `${home}/.bun/bin`,               // bun
    `${home}/.toolbox/bin`,           // toolbox
  ]

  // Try sourcing shell RC to get full PATH (nvm, fnm, volta, pyenv, etc.)
  // Try both .zshrc and .bashrc since $SHELL may not be set in daemon context
  const rcFiles = [`${home}/.zshrc`, `${home}/.bashrc`]
  let pathFromRc = ''

  for (const rcFile of rcFiles) {
    try {
      if (!fs.existsSync(rcFile)) continue
      // Use /bin/bash to source (works for both .bashrc and most .zshrc)
      // Some .zshrc uses zsh-specific syntax, so try zsh first if available
      const shells = rcFile.endsWith('.zshrc')
        ? ['/bin/zsh', '/usr/bin/zsh', '/bin/bash']
        : ['/bin/bash', '/bin/sh']
      for (const shell of shells) {
        try {
          if (!fs.existsSync(shell)) continue
          const result = execSync(
            `source ${JSON.stringify(rcFile)} 2>/dev/null; echo "$PATH"`,
            { encoding: 'utf-8', shell, timeout: 5000 },
          ).trim()
          if (result && result.includes('/') && result.length > 20) {
            pathFromRc = result
            break
          }
        } catch { continue }
      }
      if (pathFromRc) break
    } catch { continue }
  }

  // Merge all paths: extras + RC-sourced + current PATH
  // Note: node discovery is NOT done here — it's handled by buildSpawnPreamble()
  // at session spawn time, which properly activates nvm/pyenv shell functions.
  const allPaths = [
    ...extraPaths,
    ...(pathFromRc ? pathFromRc.split(':') : []),
    ...(process.env.PATH || '').split(':'),
  ].filter(Boolean)

  // Deduplicate while preserving order
  const seen = new Set<string>()
  const deduped = allPaths.filter(p => { if (seen.has(p)) return false; seen.add(p); return true })
  process.env.PATH = deduped.join(':')
})()

// ── Types ──
interface SessionData {
  proc: ChildProcess | null
  pipePath: string
  jsonlPath: string
  pgidPath: string
  pid: number | null
  offset: number
  watchers: Map<ServerWebSocket<WsData>, { close: () => void }>
  exitCode: number | null
}

interface AgentSub {
  files: Map<string, { offset: number }>
  timer: ReturnType<typeof setInterval> | null
  rediscoverTimer: ReturnType<typeof setInterval> | null
  ws: ServerWebSocket<WsData>
  sid: string
  agent: string
  team?: string
}

interface WsData {}

// ── Logging ──
function logMsg(level: string, msg: string, data?: Record<string, unknown>) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  })
  try { fs.appendFileSync(LOG_FILE, entry + '\n') } catch {}
  if (level === 'error') console.error(msg, data || '')
}

// ── Shell helpers ──

/** Shell-quote a string for safe embedding in a sh command. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Build a shell preamble that activates the user's full dev environment.
 *
 * Matches the proven REMOTE_BASE_PATH approach from session-io.ts:
 *   1. Source shell RC files (.bashrc/.zshrc) to activate nvm/pyenv/volta
 *   2. Fallback: source nvm.sh directly and try each version (with GLIBC check)
 *
 * This ensures `node` is available for Claude CLI (#!/usr/bin/env node),
 * even on hosts where nvm binaries need newer GLIBC than the system provides.
 */
function buildSpawnPreamble(): string {
  return [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
    'case "$SHELL" in'
      + ' */zsh) [ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc" >/dev/null 2>&1 ;;'
      + ' */bash) [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 ;;'
      + ' esac',
    'node -v >/dev/null 2>&1 || {'
      + ' if [ -s "$HOME/.nvm/nvm.sh" ]; then'
      + '   . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1;'
      + '   node -v >/dev/null 2>&1 || {'
      + '     for v in $(ls -1r "$NVM_DIR/versions/node/" 2>/dev/null); do'
      + '       nvm use --delete-prefix "$v" >/dev/null 2>&1 && node -v >/dev/null 2>&1 && break;'
      + '     done; };'
      + ' elif [ -x "$HOME/.fnm/fnm" ]; then eval "$("$HOME/.fnm/fnm" env)" >/dev/null 2>&1;'
      + ' elif [ -d "$HOME/.volta" ]; then export PATH="$HOME/.volta/bin:$PATH";'
      + ' elif [ -s "$HOME/.asdf/asdf.sh" ]; then . "$HOME/.asdf/asdf.sh" >/dev/null 2>&1;'
      + ' fi;'
      + ' true; }',
  ].join('; ')
}

// ── Managed Sessions ──
const sessions = new Map<string, SessionData>()

// ── WebSocket connections ──
const wsClients = new Set<ServerWebSocket<WsData>>()
let idleTimer: ReturnType<typeof setTimeout> | null = null

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (wsClients.size === 0) {
      logMsg('info', 'idle timeout — exiting', { timeoutMs: IDLE_TIMEOUT_MS })
      cleanup()
      process.exit(0)
    }
  }, IDLE_TIMEOUT_MS)
}

// ── Agent subscriptions ──
const agentSubs = new Map<string, AgentSub>()

// ── Session management commands ──

function handleCommand(ws: ServerWebSocket<WsData>, msg: string) {
  let cmd: Record<string, unknown>
  try { cmd = JSON.parse(msg) } catch { return sendError(ws, null, 'invalid JSON') }
  const { id } = cmd

  switch (cmd.cmd) {
    case 'start': return cmdStart(ws, id as number, cmd)
    case 'attach': return cmdAttach(ws, id as number, cmd)
    case 'send': return cmdSend(ws, id as number, cmd)
    case 'stop': return cmdStop(ws, id as number, cmd)
    case 'status': return cmdStatus(ws, id as number, cmd)
    case 'rename': return cmdRename(ws, id as number, cmd)
    case 'read-history': return cmdReadHistory(ws, id as number, cmd)
    case 'subscribe-agent': return cmdSubscribeAgent(ws, id as number, cmd)
    case 'unsubscribe-agent': return cmdUnsubscribeAgent(ws, id as number, cmd)
    case 'write-inbox': return cmdWriteInbox(ws, id as number, cmd)
    case 'fs.read': return cmdFsRead(ws, id as number, cmd)
    case 'fs.write': return cmdFsWrite(ws, id as number, cmd)
    case 'fs.ls': return cmdFsLs(ws, id as number, cmd)
    case 'fs.find': return cmdFsFind(ws, id as number, cmd)
    case 'list': return cmdList(ws, id as number)
    case 'ping': return sendOk(ws, id as number, { pong: true })
    default: return sendError(ws, id as number, 'unknown command: ' + cmd.cmd)
  }
}

// ── Start a Claude session ──
function cmdStart(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, args, cwd, message, resume } = cmd as {
    sid: string; args: string[]; cwd: string; message: string; resume?: boolean
  }
  if (!sid || !args || !cwd || !message) {
    return sendError(ws, id, 'start: missing required fields (sid, args, cwd, message)')
  }

  fs.mkdirSync(STREAMS_DIR, { recursive: true })

  const pipePath = path.join(STREAMS_DIR, sid + '.pipe')
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
  const stderrPath = jsonlPath + '.err'
  const pgidPath = path.join(STREAMS_DIR, sid + '.pgid')

  // Record offset before spawn (for resume — only stream new data)
  let offset = 0
  if (resume) {
    try { offset = fs.statSync(jsonlPath).size } catch { offset = 0 }
  }

  // Create FIFO
  try { fs.unlinkSync(pipePath) } catch {}
  try { execSync('mkfifo ' + JSON.stringify(pipePath)) } catch (err: unknown) {
    return sendError(ws, id, 'mkfifo failed: ' + (err as Error).message)
  }

  // Open files
  const pipeFd = fs.openSync(pipePath, fs.constants.O_RDWR)
  const outputFd = fs.openSync(jsonlPath, resume ? 'a' : 'w')
  const stderrFd = fs.openSync(stderrPath, resume ? 'a' : 'w')

  // Touch output file on resume so health checks see fresh mtime
  if (resume) {
    try { const now = new Date(); fs.utimesSync(jsonlPath, now, now) } catch {}
  }

  // Spawn Claude via login shell to activate nvm/pyenv/volta shell functions.
  // This matches the proven buildRemotePreamble() approach from session-io.ts —
  // sourcing RC files ensures the full dev environment (including node) is available,
  // even on hosts where nvm binaries need newer GLIBC than the system provides.
  const preamble = buildSpawnPreamble()
  const escapedArgs = args.map((a: string) => shellQuote(a)).join(' ')
  const shellCmd = `${preamble}; exec ${escapedArgs}`

  const proc = spawn('/bin/bash', ['-c', shellCmd], {
    detached: true,
    stdio: [pipeFd, outputFd, stderrFd],
    cwd: cwd,
    env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
  })

  // Handle spawn errors (e.g., /bin/bash not found) — don't let it crash the daemon
  proc.on('error', (err) => {
    logMsg('error', 'spawn failed', { sid, error: err.message })
    // The exit handler below will fire with exitCode=null, which triggers the error path
  })

  // Write initial message to FIFO
  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  })
  fs.writeSync(pipeFd, Buffer.from(payload + '\n'))
  fs.closeSync(pipeFd)

  // Close fds in parent
  fs.closeSync(outputFd)
  fs.closeSync(stderrFd)

  // Save PID
  const pid = proc.pid!
  proc.unref()
  try { fs.writeFileSync(pgidPath, String(pid)) } catch {}

  logMsg('info', 'session started', { sid, pid, resume: !!resume })

  // Track session
  const sessionData: SessionData = {
    proc,
    pipePath,
    jsonlPath,
    pgidPath,
    pid,
    offset,
    watchers: new Map(),
    exitCode: null,
  }

  proc.on('exit', (code) => {
    sessionData.exitCode = code
    logMsg('info', 'session process exited', { sid, pid, code: code ?? 1 })
    // Broadcast exit to all connected clients watching this session
    for (const client of sessionData.watchers.keys()) {
      sendEvent(client, 'exit', { sid, code: code ?? 1 })
    }
  })

  sessions.set(sid, sessionData)

  // Start watching JSONL for this client
  startWatching(ws, sid, offset)

  sendOk(ws, id, { pid, outputFile: jsonlPath, offset })
}

// ── File watching for JSONL streaming ──
function startWatching(ws: ServerWebSocket<WsData>, sid: string, fromOffset: number) {
  const session = sessions.get(sid)
  if (!session) return

  // If already watching, stop first
  const existingWatcher = session.watchers.get(ws)
  if (existingWatcher) {
    existingWatcher.close()
  }

  let offset = fromOffset || 0

  // Poll-based watcher (more reliable than fs.watch across filesystems)
  const pollInterval = setInterval(() => {
    try {
      const stat = fs.statSync(session.jsonlPath)
      if (stat.size > offset) {
        const fd = fs.openSync(session.jsonlPath, 'r')
        const bytesToRead = stat.size - offset
        const buf = Buffer.alloc(bytesToRead)
        fs.readSync(fd, buf, 0, bytesToRead, offset)
        fs.closeSync(fd)
        offset = stat.size

        const text = buf.toString('utf-8')
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.trim()) {
            sendEvent(ws, 'jsonl', { sid, line })
          }
        }
      }
    } catch {}
  }, 100) // 100ms poll interval — low latency, minimal CPU

  const watcher = { close: () => clearInterval(pollInterval) }
  session.watchers.set(ws, watcher)
}

function stopWatching(ws: ServerWebSocket<WsData>, sid: string) {
  const session = sessions.get(sid)
  if (!session) return
  const watcher = session.watchers.get(ws)
  if (watcher) {
    watcher.close()
    session.watchers.delete(ws)
  }
}

// ── Attach to existing session ──
function cmdAttach(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, fromOffset } = cmd as { sid: string; fromOffset?: number }
  if (!sid) return sendError(ws, id, 'attach: missing sid')

  let session = sessions.get(sid)

  if (!session) {
    // Try to discover from files
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    const pgidPath = path.join(STREAMS_DIR, sid + '.pgid')
    const pipePath = path.join(STREAMS_DIR, sid + '.pipe')

    if (!fs.existsSync(jsonlPath)) {
      return sendError(ws, id, 'attach: session not found: ' + sid)
    }

    let pid: number | null = null
    let alive = false
    try {
      pid = parseInt(fs.readFileSync(pgidPath, 'utf-8').trim(), 10)
      process.kill(pid, 0) // check alive
      alive = true
    } catch { pid = null; alive = false }

    session = {
      proc: null,
      pipePath,
      jsonlPath,
      pgidPath,
      pid,
      offset: fromOffset || 0,
      watchers: new Map(),
      exitCode: alive ? null : 0,
    }
    sessions.set(sid, session)
  }

  const offset = fromOffset || 0
  const alive = session.pid !== null && session.exitCode === null

  startWatching(ws, sid, offset)

  sendOk(ws, id, {
    pid: session.pid,
    alive,
    outputFile: session.jsonlPath,
  })
}

// ── Send message ──
function cmdSend(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, message } = cmd as { sid: string; message: string }
  if (!sid || !message) return sendError(ws, id, 'send: missing sid or message')

  const session = sessions.get(sid)
  if (!session) return sendError(ws, id, 'send: session not found: ' + sid)

  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  })

  try {
    const buf = Buffer.from(payload + '\n')
    const fd = fs.openSync(session.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    try {
      const written = fs.writeSync(fd, buf)
      if (written !== buf.length) {
        return sendOk(ws, id, { ok: false, reason: 'partial write' })
      }
    } finally {
      fs.closeSync(fd)
    }
    sendOk(ws, id, { ok: true })
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENXIO' || code === 'EAGAIN') {
      sendOk(ws, id, { ok: false, reason: code })
    } else {
      sendError(ws, id, 'send failed: ' + (err as Error).message)
    }
  }
}

// ── Stop session ──
function cmdStop(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid } = cmd as { sid: string }
  if (!sid) return sendError(ws, id, 'stop: missing sid')

  const session = sessions.get(sid)
  if (!session || !session.pid) return sendOk(ws, id, { stopped: true })

  try {
    process.kill(session.pid, 'SIGINT')
    // Wait up to 5s for exit
    let checks = 0
    const checkExit = () => {
      try { process.kill(session.pid!, 0) } catch {
        sendOk(ws, id, { stopped: true })
        return
      }
      checks++
      if (checks >= 25) { // 5s
        try { process.kill(session.pid!, 'SIGTERM') } catch {}
        sendOk(ws, id, { stopped: true, forced: true })
        return
      }
      setTimeout(checkExit, 200)
    }
    setTimeout(checkExit, 200)
  } catch {
    sendOk(ws, id, { stopped: true })
  }
}

// ── Status ──
function cmdStatus(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid } = cmd as { sid: string }
  if (!sid) return sendError(ws, id, 'status: missing sid')

  const session = sessions.get(sid)
  if (!session) return sendOk(ws, id, { exists: false })

  let alive = false
  if (session.pid) {
    try { process.kill(session.pid, 0); alive = true } catch {}
  }

  let mtime: string | null = null, size = 0
  try {
    const stat = fs.statSync(session.jsonlPath)
    mtime = stat.mtime.toISOString()
    size = stat.size
  } catch {}

  sendOk(ws, id, { exists: true, alive, pid: session.pid, mtime, size })
}

// ── Rename session files ──
function cmdRename(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { oldSid, newSid } = cmd as { oldSid: string; newSid: string }
  if (!oldSid || !newSid) return sendError(ws, id, 'rename: missing oldSid or newSid')
  if (oldSid === newSid) return sendOk(ws, id, { renamed: true })

  const session = sessions.get(oldSid)
  if (!session) return sendError(ws, id, 'rename: session not found: ' + oldSid)

  const oldBase = path.join(STREAMS_DIR, oldSid)
  const newBase = path.join(STREAMS_DIR, newSid)

  try {
    for (const ext of ['.jsonl', '.jsonl.err', '.pipe', '.pgid', '.log']) {
      try { fs.renameSync(oldBase + ext, newBase + ext) } catch {}
    }
    session.jsonlPath = newBase + '.jsonl'
    session.pipePath = newBase + '.pipe'
    session.pgidPath = newBase + '.pgid'

    sessions.delete(oldSid)
    sessions.set(newSid, session)

    sendOk(ws, id, { renamed: true })
    logMsg('info', 'session renamed', { oldSid, newSid })
  } catch (err: unknown) {
    sendError(ws, id, 'rename failed: ' + (err as Error).message)
  }
}

// ── Read history ──
function cmdReadHistory(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, canonicalPath } = cmd as { sid: string; canonicalPath?: string }
  if (!sid) return sendError(ws, id, 'read-history: missing sid')

  try {
    // Read main JSONL
    let mainContent = ''
    const jsonlPath = canonicalPath || path.join(STREAMS_DIR, sid + '.jsonl')
    try { mainContent = fs.readFileSync(jsonlPath, 'utf-8') } catch {}

    // Read subagents
    const subagents: Record<string, string> = {}
    const subagentDir = path.dirname(jsonlPath) + '/' + sid + '/subagents'
    try {
      const files = fs.readdirSync(subagentDir)
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          try {
            subagents[f] = fs.readFileSync(path.join(subagentDir, f), 'utf-8')
          } catch {}
        }
      }
    } catch {}

    sendOk(ws, id, { main: mainContent, subagents })
  } catch (err: unknown) {
    sendError(ws, id, 'read-history failed: ' + (err as Error).message)
  }
}

// ── Subscribe to subagent ──
function cmdSubscribeAgent(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, agent, team, offsets } = cmd as {
    sid: string; agent: string; team?: string; offsets?: Record<string, number>
  }
  if (!sid || !agent) return sendError(ws, id, 'subscribe-agent: missing sid or agent')

  const subKey = sid + ':' + agent

  // Unsubscribe existing
  const existing = agentSubs.get(subKey)
  if (existing) {
    if (existing.timer) clearInterval(existing.timer)
    if (existing.rediscoverTimer) clearInterval(existing.rediscoverTimer)
    agentSubs.delete(subKey)
  }

  const sub: AgentSub = {
    files: new Map(),
    timer: null,
    rediscoverTimer: null,
    ws,
    sid,
    agent,
    team,
  }

  // Discover agent JSONL files
  function discoverFiles() {
    try {
      // Look in session subagents dir
      const sessionDir = path.join(STREAMS_DIR, sid, 'subagents')
      try {
        const files = fs.readdirSync(sessionDir)
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue
          // Match by agent name in filename
          if (f.toLowerCase().includes(agent.toLowerCase()) || f.includes(agent)) {
            const fullPath = path.join(sessionDir, f)
            if (!sub.files.has(fullPath)) {
              const startOffset = (offsets && offsets[f]) || 0
              sub.files.set(fullPath, { offset: startOffset })
            }
          }
        }
      } catch {}
    } catch {}
  }

  // Poll for new data
  function pollData() {
    for (const [filePath, fileState] of sub.files) {
      try {
        const stat = fs.statSync(filePath)
        if (stat.size > fileState.offset) {
          const fd = fs.openSync(filePath, 'r')
          const bytes = stat.size - fileState.offset
          const buf = Buffer.alloc(bytes)
          fs.readSync(fd, buf, 0, bytes, fileState.offset)
          fs.closeSync(fd)
          fileState.offset = stat.size

          const lines = buf.toString('utf-8').split('\n').filter((l: string) => l.trim())
          if (lines.length > 0) {
            sendEvent(ws, 'agent', {
              sid,
              agent,
              file: path.basename(filePath),
              lines,
            })
          }
        }
      } catch {}
    }
  }

  // Initial discovery + data send
  discoverFiles()
  pollData()

  // Start polling
  sub.timer = setInterval(pollData, AGENT_POLL_INTERVAL_MS)
  sub.rediscoverTimer = setInterval(discoverFiles, AGENT_REDISCOVER_INTERVAL_MS)

  agentSubs.set(subKey, sub)
  sendOk(ws, id, { subscribed: true, files: [...sub.files.keys()] })
}

// ── Unsubscribe from subagent ──
function cmdUnsubscribeAgent(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, agent } = cmd as { sid: string; agent: string }
  const subKey = sid + ':' + agent
  const sub = agentSubs.get(subKey)
  if (sub) {
    if (sub.timer) clearInterval(sub.timer)
    if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
    agentSubs.delete(subKey)
  }
  sendOk(ws, id, { unsubscribed: true })
}

// ── Write to team inbox ──
function cmdWriteInbox(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { team, agent, from, text, summary } = cmd as {
    team: string; agent: string; from?: string; text: string; summary?: string
  }
  if (!team || !agent || !text) return sendError(ws, id, 'write-inbox: missing fields')

  const homeDir = process.env.HOME || '/root'
  const inboxPath = path.join(homeDir, '.claude', 'teams', team, 'inboxes', agent + '.json')

  try {
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true })

    let inbox: unknown[] = []
    try { inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf-8')) } catch {}
    if (!Array.isArray(inbox)) inbox = []

    inbox.push({
      from: from || 'walnut',
      text,
      summary: summary || text.slice(0, 100),
      timestamp: new Date().toISOString(),
      read: false,
    })

    fs.writeFileSync(inboxPath, JSON.stringify(inbox, null, 2))
    sendOk(ws, id, { written: true })
  } catch (err: unknown) {
    sendError(ws, id, 'write-inbox failed: ' + (err as Error).message)
  }
}

// ── File system operations ──
function cmdFsRead(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let filePath = cmd.path as string
  const encoding = cmd.encoding as string | undefined
  if (!filePath) return sendError(ws, id, 'fs.read: missing path')

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = (process.env.HOME || '/root') + filePath.slice(1)
  }

  try {
    const enc = encoding || 'base64'
    const data = fs.readFileSync(filePath)
    if (enc === 'base64') {
      sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64' })
    } else {
      sendOk(ws, id, { data: data.toString('utf-8'), encoding: 'utf-8' })
    }
  } catch (err: unknown) {
    sendError(ws, id, 'fs.read failed: ' + (err as Error).message)
  }
}

function cmdFsWrite(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { path: filePath, data, encoding } = cmd as { path: string; data: string; encoding?: string }
  if (!filePath || !data) return sendError(ws, id, 'fs.write: missing path or data')

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const enc = encoding || 'base64'
    const buf = enc === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf-8')
    fs.writeFileSync(filePath, buf)
    sendOk(ws, id, { written: true, size: buf.length })
  } catch (err: unknown) {
    sendError(ws, id, 'fs.write failed: ' + (err as Error).message)
  }
}

function cmdFsLs(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let dirPath = cmd.path as string
  if (!dirPath) return sendError(ws, id, 'fs.ls: missing path')

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (dirPath === '~' || dirPath.startsWith('~/')) {
    dirPath = (process.env.HOME || '/root') + dirPath.slice(1)
  }

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    const result = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }))
    sendOk(ws, id, { entries: result, resolvedPath: dirPath })
  } catch (err: unknown) {
    sendError(ws, id, 'fs.ls failed: ' + (err as Error).message)
  }
}

function cmdFsFind(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let basePath = (cmd.path as string) || '~/.claude/projects'
  const name = cmd.name as string
  const maxDepth = (cmd.maxDepth as number) || 3
  if (!name) return sendError(ws, id, 'fs.find: missing name')

  // Expand ~ to home directory
  if (basePath === '~' || basePath.startsWith('~/')) {
    basePath = (process.env.HOME || '/root') + basePath.slice(1)
  }

  try {
    const found: string[] = []
    function walk(dir: string, depth: number) {
      if (depth > maxDepth || found.length >= 10) return
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const e of entries) {
          const full = path.join(dir, e.name)
          if (e.isFile() && e.name.includes(name)) {
            found.push(full)
            if (found.length >= 10) return
          } else if (e.isDirectory()) {
            walk(full, depth + 1)
          }
        }
      } catch {}
    }
    walk(basePath, 0)
    sendOk(ws, id, { files: found })
  } catch (err: unknown) {
    sendError(ws, id, 'fs.find failed: ' + (err as Error).message)
  }
}

// ── List all sessions ──
function cmdList(ws: ServerWebSocket<WsData>, id: number) {
  const result: Array<{
    sid: string; pid: number | null; alive: boolean; mtime: string | null; size: number
  }> = []

  // Scan streams dir for PGID files
  try {
    const files = fs.readdirSync(STREAMS_DIR)
    for (const f of files) {
      if (!f.endsWith('.pgid')) continue
      const sid = f.replace('.pgid', '')
      try {
        const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, f), 'utf-8').trim(), 10)
        let alive = false
        try { process.kill(pid, 0); alive = true } catch {}

        let mtime: string | null = null, size = 0
        try {
          const stat = fs.statSync(path.join(STREAMS_DIR, sid + '.jsonl'))
          mtime = stat.mtime.toISOString()
          size = stat.size
        } catch {}

        result.push({ sid, pid, alive, mtime, size })
      } catch {}
    }
  } catch {}

  // Also include in-memory sessions not yet persisted
  for (const [sid, session] of sessions) {
    if (!result.find(r => r.sid === sid)) {
      let alive = false
      if (session.pid) {
        try { process.kill(session.pid, 0); alive = true } catch {}
      }
      result.push({
        sid,
        pid: session.pid,
        alive,
        mtime: null,
        size: 0,
      })
    }
  }

  sendOk(ws, id, { sessions: result })
}

// ── Protocol helpers ──
function sendOk(ws: ServerWebSocket<WsData>, id: number | null, data: Record<string, unknown>) {
  try { ws.send(JSON.stringify({ id, ok: true, ...data })) } catch {}
}

function sendError(ws: ServerWebSocket<WsData>, id: number | null, error: string) {
  logMsg('error', 'command error', { id, error })
  try { ws.send(JSON.stringify({ id, ok: false, error })) } catch {}
}

function sendEvent(ws: ServerWebSocket<WsData>, ev: string, data: Record<string, unknown>) {
  try { ws.send(JSON.stringify({ ev, ...data })) } catch {}
}

// ── Cleanup ──
function cleanup() {
  // Stop all watchers
  for (const [, session] of sessions) {
    for (const [, watcher] of session.watchers) {
      watcher.close()
    }
  }
  // Stop all agent subs
  for (const [, sub] of agentSubs) {
    if (sub.timer) clearInterval(sub.timer)
    if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
  }
  // Remove port/pid files
  try { fs.unlinkSync(PORT_FILE) } catch {}
  try { fs.unlinkSync(PID_FILE) } catch {}
}

// ── Handle disconnect for a WebSocket client ──
function handleDisconnect(ws: ServerWebSocket<WsData>) {
  wsClients.delete(ws)

  // Clean up watchers for this client
  for (const [sid] of sessions) {
    stopWatching(ws, sid)
  }

  // Clean up agent subs for this client
  for (const [key, sub] of agentSubs) {
    if (sub.ws === ws) {
      if (sub.timer) clearInterval(sub.timer)
      if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
      agentSubs.delete(key)
    }
  }

  resetIdleTimer()
  logMsg('info', 'client disconnected', { clients: wsClients.size })
}

// ── Main ──
const action = process.argv[2]

if (action === '--stop') {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    process.kill(pid, 'SIGTERM')
    console.log('daemon stopped (pid=' + pid + ')')
  } catch {
    console.log('daemon not running')
  }
  process.exit(0)
}

if (action === '--status') {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    const port = fs.readFileSync(PORT_FILE, 'utf-8').trim()
    console.log(JSON.stringify({ running: true, pid, port: parseInt(port, 10) }))
  } catch {
    console.log(JSON.stringify({ running: false }))
  }
  process.exit(0)
}

if (action === '--start') {
  // Check if already running
  try {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    process.kill(existingPid, 0)
    const existingPort = fs.readFileSync(PORT_FILE, 'utf-8').trim()
    console.log(existingPort) // Already running — return port
    process.exit(0)
  } catch {
    // Not running, continue to start
  }

  fs.mkdirSync(DAEMON_DIR, { recursive: true })
  fs.mkdirSync(STREAMS_DIR, { recursive: true })

  // Start Bun.serve() with built-in WebSocket support
  const server = Bun.serve<WsData>({
    port: 0, // random port
    hostname: '127.0.0.1',

    fetch(req, server) {
      // Upgrade WebSocket requests
      if (server.upgrade(req, { data: {} })) {
        return undefined
      }
      return new Response('walnut-daemon ok')
    },

    websocket: {
      open(ws) {
        wsClients.add(ws)
        resetIdleTimer()
        logMsg('info', 'client connected', { clients: wsClients.size })
      },

      message(ws, msg) {
        resetIdleTimer()
        handleCommand(ws, typeof msg === 'string' ? msg : Buffer.from(msg).toString())
      },

      close(ws) {
        handleDisconnect(ws)
      },
    },
  })

  const port = server.port
  fs.writeFileSync(PORT_FILE, String(port))
  fs.writeFileSync(PID_FILE, String(process.pid))
  console.log(port) // Print port for parent to capture
  logMsg('info', 'daemon started', { port, pid: process.pid })
  resetIdleTimer()

  // Handle signals
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGINT', () => { cleanup(); process.exit(0) })

  // Detach from terminal (close stdin so SSH doesn't hold)
  if (process.stdin.isTTY === false) {
    process.stdin.resume()
    process.stdin.on('end', () => {}) // Don't exit on stdin close
  }
} else {
  console.error('Usage: bun daemon-standalone.ts --start | --stop | --status | --version')
  process.exit(1)
}
