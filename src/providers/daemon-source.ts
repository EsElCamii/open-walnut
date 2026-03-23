/**
 * walnut-daemon.js — Embedded source code for the remote daemon server.
 *
 * ARCHITECTURE:
 * This file contains the daemon source as a string constant. When connecting
 * to a remote host, DaemonConnection:
 *   1. Deploys this code via SSH (cat > /tmp/open-walnut/daemon.js)
 *   2. Starts it (node /tmp/open-walnut/daemon.js --start)
 *   3. Connects via WebSocket through an SSH tunnel
 *
 * The daemon runs independently on the remote machine — SSH dropping
 * doesn't kill it. It auto-exits after 30min of no WebSocket connections.
 *
 * WHY EMBEDDED:
 * - No npm install needed on remote (uses Node.js built-in WebSocket from Node 21+,
 *   with fallback to raw HTTP upgrade for older versions)
 * - Single file deployment via SSH pipe
 * - Version always matches the Walnut server
 *
 * PROTOCOL:
 * Client sends JSON commands, daemon sends JSON events.
 * Commands: start, attach, send, stop, status, rename, read-history,
 *   subscribe-agent, unsubscribe-agent, write-inbox, fs.read, fs.write,
 *   fs.ls, fs.find, list, ping
 * Events: jsonl (JSONL line), exit (process exited), agent (subagent data),
 *   ok (command response), error (command error)
 */

/**
 * Get the daemon source code as a string.
 * The source is a self-contained Node.js script that:
 * - Listens on a random localhost port (WebSocket)
 * - Manages Claude CLI processes (start, stop, attach)
 * - Streams JSONL output via WebSocket
 * - Handles subagent polling
 * - Provides file system operations
 * - Auto-exits after 30min of inactivity
 */
export function getDaemonSource(): string {
  return DAEMON_SOURCE
}

// ── Daemon source code ──
// This is deployed to /tmp/open-walnut/daemon.js on the remote machine.

const DAEMON_SOURCE = `#!/usr/bin/env node
'use strict';

/**
 * walnut-daemon — Remote session manager for Open Walnut.
 *
 * Runs as a persistent server on the remote machine.
 * Manages Claude CLI processes and streams output via WebSocket.
 *
 * Usage:
 *   node daemon.js --start      # Start daemon, print port to stdout
 *   node daemon.js --stop       # Stop running daemon
 *   node daemon.js --status     # Check if daemon is running
 *
 * Protocol: JSON over WebSocket
 *   Client → Daemon: { id, cmd, ...params }
 *   Daemon → Client: { id, ok, ...data } or { ev, ...data }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

// ── Constants ──
const DAEMON_DIR = '/tmp/open-walnut';
const STREAMS_DIR = '/tmp/open-walnut-streams';
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port');
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid');
const LOG_FILE = path.join(DAEMON_DIR, 'daemon.log');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const AGENT_POLL_INTERVAL_MS = 2000;
const AGENT_REDISCOVER_INTERVAL_MS = 10000;
const PING_INTERVAL_MS = 15000;

// ── Logging ──
function logMsg(level, msg, data) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  });
  try { fs.appendFileSync(LOG_FILE, entry + '\\n'); } catch {}
  if (level === 'error') console.error(msg, data || '');
}

// ── Managed Sessions ──
// Each session has: { proc, pipe, jsonlPath, watchers, offset, onExit }
const sessions = new Map();

// ── WebSocket connections ──
const wsClients = new Set();
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (wsClients.size === 0) {
      logMsg('info', 'idle timeout — exiting', { timeoutMs: IDLE_TIMEOUT_MS });
      cleanup();
      process.exit(0);
    }
  }, IDLE_TIMEOUT_MS);
}

// ── Agent subscriptions ──
// Map<subKey, { timer, rediscoverTimer, files: Map<filePath, offset> }>
const agentSubs = new Map();

// ── WebSocket server (using built-in or manual upgrade) ──

function createWsServer(httpServer) {
  // Try Node.js 21+ built-in WebSocket server, fall back to manual
  try {
    // Node 22+ has WebSocketServer
    const { WebSocketServer } = require('ws');
    const wss = new WebSocketServer({ server: httpServer });
    return wss;
  } catch {
    // Fall back: try native
    try {
      const { WebSocketServer } = require('node:ws');
      const wss = new WebSocketServer({ server: httpServer });
      return wss;
    } catch {
      // Manual WebSocket upgrade (no external deps)
      return createManualWsServer(httpServer);
    }
  }
}

/**
 * Minimal WebSocket server using raw HTTP upgrade.
 * Handles frames manually — supports text messages + ping/pong.
 * This is a fallback for Node.js versions without 'ws' package.
 */
function createManualWsServer(httpServer) {
  const EventEmitter = require('events');
  const emitter = new EventEmitter();

  httpServer.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC085B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\\r\\n' +
      'Upgrade: websocket\\r\\n' +
      'Connection: Upgrade\\r\\n' +
      'Sec-WebSocket-Accept: ' + acceptKey + '\\r\\n' +
      '\\r\\n'
    );

    // Create a WebSocket-like wrapper
    const ws = createWsWrapper(socket);
    emitter.emit('connection', ws);
  });

  return emitter;
}

function createWsWrapper(socket) {
  const EventEmitter = require('events');
  const ws = new EventEmitter();
  ws.readyState = 1; // OPEN
  let buffer = Buffer.alloc(0);

  ws.send = function(data) {
    if (ws.readyState !== 1) return;
    const payload = Buffer.from(data, 'utf-8');
    const frame = encodeFrame(payload, 0x01); // text frame
    try { socket.write(frame); } catch {}
  };

  ws.close = function() {
    ws.readyState = 3; // CLOSED
    try { socket.end(); } catch {}
  };

  ws.ping = function() {
    if (ws.readyState !== 1) return;
    try { socket.write(encodeFrame(Buffer.alloc(0), 0x09)); } catch {}
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const result = decodeFrame(buffer);
      if (!result) break;
      buffer = result.remaining;
      const { opcode, payload } = result;

      if (opcode === 0x01 || opcode === 0x02) { // text or binary
        ws.emit('message', payload.toString('utf-8'));
      } else if (opcode === 0x08) { // close
        ws.readyState = 3;
        ws.emit('close');
        socket.end();
        return;
      } else if (opcode === 0x09) { // ping
        try { socket.write(encodeFrame(payload, 0x0A)); } catch {} // pong
      } else if (opcode === 0x0A) { // pong
        ws.emit('pong');
      }
    }
  });

  socket.on('close', () => {
    ws.readyState = 3;
    ws.emit('close');
  });

  socket.on('error', (err) => {
    ws.readyState = 3;
    ws.emit('error', err);
  });

  return ws;
}

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0F;
  const masked = !!(buf[1] & 0x80);
  let payloadLen = buf[1] & 0x7F;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.slice(offset, offset + 4);
    offset += 4;
    const payload = buf.slice(offset, offset + payloadLen);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    return { opcode, payload, remaining: buf.slice(offset + payloadLen) };
  } else {
    if (buf.length < offset + payloadLen) return null;
    const payload = buf.slice(offset, offset + payloadLen);
    return { opcode, payload, remaining: buf.slice(offset + payloadLen) };
  }
}

// ── Session management commands ──

function handleCommand(ws, msg) {
  let cmd;
  try { cmd = JSON.parse(msg); } catch { return sendError(ws, null, 'invalid JSON'); }
  const { id } = cmd;

  switch (cmd.cmd) {
    case 'start': return cmdStart(ws, id, cmd);
    case 'attach': return cmdAttach(ws, id, cmd);
    case 'send': return cmdSend(ws, id, cmd);
    case 'stop': return cmdStop(ws, id, cmd);
    case 'status': return cmdStatus(ws, id, cmd);
    case 'rename': return cmdRename(ws, id, cmd);
    case 'read-history': return cmdReadHistory(ws, id, cmd);
    case 'subscribe-agent': return cmdSubscribeAgent(ws, id, cmd);
    case 'unsubscribe-agent': return cmdUnsubscribeAgent(ws, id, cmd);
    case 'write-inbox': return cmdWriteInbox(ws, id, cmd);
    case 'fs.read': return cmdFsRead(ws, id, cmd);
    case 'fs.write': return cmdFsWrite(ws, id, cmd);
    case 'fs.ls': return cmdFsLs(ws, id, cmd);
    case 'fs.find': return cmdFsFind(ws, id, cmd);
    case 'list': return cmdList(ws, id);
    case 'ping': return sendOk(ws, id, { pong: true });
    default: return sendError(ws, id, 'unknown command: ' + cmd.cmd);
  }
}

// ── Start a Claude session ──
function cmdStart(ws, id, cmd) {
  const { sid, args, cwd, message, resume } = cmd;
  if (!sid || !args || !cwd || !message) {
    return sendError(ws, id, 'start: missing required fields (sid, args, cwd, message)');
  }

  fs.mkdirSync(STREAMS_DIR, { recursive: true });

  const pipePath = path.join(STREAMS_DIR, sid + '.pipe');
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl');
  const stderrPath = jsonlPath + '.err';
  const pgidPath = path.join(STREAMS_DIR, sid + '.pgid');

  // Record offset before spawn (for resume — only stream new data)
  let offset = 0;
  if (resume) {
    try { offset = fs.statSync(jsonlPath).size; } catch { offset = 0; }
  }

  // Create FIFO
  try { fs.unlinkSync(pipePath); } catch {}
  try { execSync('mkfifo ' + JSON.stringify(pipePath)); } catch (err) {
    return sendError(ws, id, 'mkfifo failed: ' + err.message);
  }

  // Open files
  const pipeFd = fs.openSync(pipePath, fs.constants.O_RDWR);
  const outputFd = fs.openSync(jsonlPath, resume ? 'a' : 'w');
  const stderrFd = fs.openSync(stderrPath, resume ? 'a' : 'w');

  // Touch output file on resume so health checks see fresh mtime
  if (resume) {
    try { const now = new Date(); fs.utimesSync(jsonlPath, now, now); } catch {}
  }

  // Spawn Claude
  const proc = spawn(args[0] || 'claude', args.slice(1), {
    detached: true,
    stdio: [pipeFd, outputFd, stderrFd],
    cwd: cwd,
    env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
  });

  // Write initial message to FIFO
  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  });
  fs.writeSync(pipeFd, Buffer.from(payload + '\\n'));
  fs.closeSync(pipeFd);

  // Close fds in parent
  fs.closeSync(outputFd);
  fs.closeSync(stderrFd);

  // Save PID
  const pid = proc.pid;
  proc.unref();
  try { fs.writeFileSync(pgidPath, String(pid)); } catch {}

  logMsg('info', 'session started', { sid, pid, resume: !!resume });

  // Track session
  const sessionData = {
    proc,
    pipePath,
    jsonlPath,
    pgidPath,
    pid,
    offset,
    watchers: new Map(), // ws → watcher
    exitCode: null,
  };

  proc.on('exit', (code) => {
    sessionData.exitCode = code;
    logMsg('info', 'session process exited', { sid, pid, code });
    // Broadcast exit to all connected clients watching this session
    for (const client of sessionData.watchers.keys()) {
      sendEvent(client, 'exit', { sid, code: code ?? 1 });
    }
  });

  sessions.set(sid, sessionData);

  // Start watching JSONL for this client
  startWatching(ws, sid, offset);

  sendOk(ws, id, { pid, outputFile: jsonlPath, offset });
}

// ── File watching for JSONL streaming ──
function startWatching(ws, sid, fromOffset) {
  const session = sessions.get(sid);
  if (!session) return;

  // If already watching, stop first
  const existingWatcher = session.watchers.get(ws);
  if (existingWatcher) {
    existingWatcher.close();
  }

  let offset = fromOffset || 0;

  // Poll-based watcher (more reliable than fs.watch across filesystems)
  const pollInterval = setInterval(() => {
    try {
      const stat = fs.statSync(session.jsonlPath);
      if (stat.size > offset) {
        const fd = fs.openSync(session.jsonlPath, 'r');
        const bytesToRead = stat.size - offset;
        const buf = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buf, 0, bytesToRead, offset);
        fs.closeSync(fd);
        offset = stat.size;

        const text = buf.toString('utf-8');
        const lines = text.split('\\n');
        for (const line of lines) {
          if (line.trim()) {
            sendEvent(ws, 'jsonl', { sid, line });
          }
        }
      }
    } catch {}
  }, 100); // 100ms poll interval — low latency, minimal CPU

  const watcher = { close: () => clearInterval(pollInterval) };
  session.watchers.set(ws, watcher);
}

function stopWatching(ws, sid) {
  const session = sessions.get(sid);
  if (!session) return;
  const watcher = session.watchers.get(ws);
  if (watcher) {
    watcher.close();
    session.watchers.delete(ws);
  }
}

// ── Attach to existing session ──
function cmdAttach(ws, id, cmd) {
  const { sid, fromOffset } = cmd;
  if (!sid) return sendError(ws, id, 'attach: missing sid');

  let session = sessions.get(sid);

  if (!session) {
    // Try to discover from files
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl');
    const pgidPath = path.join(STREAMS_DIR, sid + '.pgid');
    const pipePath = path.join(STREAMS_DIR, sid + '.pipe');

    if (!fs.existsSync(jsonlPath)) {
      return sendError(ws, id, 'attach: session not found: ' + sid);
    }

    let pid = null;
    let alive = false;
    try {
      pid = parseInt(fs.readFileSync(pgidPath, 'utf-8').trim(), 10);
      process.kill(pid, 0); // check alive
      alive = true;
    } catch { pid = null; alive = false; }

    session = {
      proc: null,
      pipePath,
      jsonlPath,
      pgidPath,
      pid,
      offset: fromOffset || 0,
      watchers: new Map(),
      exitCode: alive ? null : 0,
    };
    sessions.set(sid, session);
  }

  const offset = fromOffset || 0;
  const alive = session.pid !== null && session.exitCode === null;

  startWatching(ws, sid, offset);

  sendOk(ws, id, {
    pid: session.pid,
    alive,
    outputFile: session.jsonlPath,
  });
}

// ── Send message ──
function cmdSend(ws, id, cmd) {
  const { sid, message } = cmd;
  if (!sid || !message) return sendError(ws, id, 'send: missing sid or message');

  const session = sessions.get(sid);
  if (!session) return sendError(ws, id, 'send: session not found: ' + sid);

  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  });

  try {
    const buf = Buffer.from(payload + '\\n');
    const fd = fs.openSync(session.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try {
      const written = fs.writeSync(fd, buf);
      if (written !== buf.length) {
        return sendOk(ws, id, { ok: false, reason: 'partial write' });
      }
    } finally {
      fs.closeSync(fd);
    }
    sendOk(ws, id, { ok: true });
  } catch (err) {
    const code = err.code;
    if (code === 'ENXIO' || code === 'EAGAIN') {
      sendOk(ws, id, { ok: false, reason: code });
    } else {
      sendError(ws, id, 'send failed: ' + err.message);
    }
  }
}

// ── Stop session ──
function cmdStop(ws, id, cmd) {
  const { sid } = cmd;
  if (!sid) return sendError(ws, id, 'stop: missing sid');

  const session = sessions.get(sid);
  if (!session || !session.pid) return sendOk(ws, id, { stopped: true });

  try {
    process.kill(session.pid, 'SIGINT');
    // Wait up to 5s for exit
    let checks = 0;
    const checkExit = () => {
      try { process.kill(session.pid, 0); } catch {
        sendOk(ws, id, { stopped: true });
        return;
      }
      checks++;
      if (checks >= 25) { // 5s
        try { process.kill(session.pid, 'SIGTERM'); } catch {}
        sendOk(ws, id, { stopped: true, forced: true });
        return;
      }
      setTimeout(checkExit, 200);
    };
    setTimeout(checkExit, 200);
  } catch {
    sendOk(ws, id, { stopped: true });
  }
}

// ── Status ──
function cmdStatus(ws, id, cmd) {
  const { sid } = cmd;
  if (!sid) return sendError(ws, id, 'status: missing sid');

  const session = sessions.get(sid);
  if (!session) return sendOk(ws, id, { exists: false });

  let alive = false;
  if (session.pid) {
    try { process.kill(session.pid, 0); alive = true; } catch {}
  }

  let mtime = null, size = 0;
  try {
    const stat = fs.statSync(session.jsonlPath);
    mtime = stat.mtime.toISOString();
    size = stat.size;
  } catch {}

  sendOk(ws, id, { exists: true, alive, pid: session.pid, mtime, size });
}

// ── Rename session files ──
function cmdRename(ws, id, cmd) {
  const { oldSid, newSid } = cmd;
  if (!oldSid || !newSid) return sendError(ws, id, 'rename: missing oldSid or newSid');
  if (oldSid === newSid) return sendOk(ws, id, { renamed: true });

  const session = sessions.get(oldSid);
  if (!session) return sendError(ws, id, 'rename: session not found: ' + oldSid);

  const oldBase = path.join(STREAMS_DIR, oldSid);
  const newBase = path.join(STREAMS_DIR, newSid);

  try {
    for (const ext of ['.jsonl', '.jsonl.err', '.pipe', '.pgid', '.log']) {
      try { fs.renameSync(oldBase + ext, newBase + ext); } catch {}
    }
    session.jsonlPath = newBase + '.jsonl';
    session.pipePath = newBase + '.pipe';
    session.pgidPath = newBase + '.pgid';

    sessions.delete(oldSid);
    sessions.set(newSid, session);

    sendOk(ws, id, { renamed: true });
    logMsg('info', 'session renamed', { oldSid, newSid });
  } catch (err) {
    sendError(ws, id, 'rename failed: ' + err.message);
  }
}

// ── Read history ──
function cmdReadHistory(ws, id, cmd) {
  const { sid, canonicalPath } = cmd;
  if (!sid) return sendError(ws, id, 'read-history: missing sid');

  try {
    // Read main JSONL
    let mainContent = '';
    const jsonlPath = canonicalPath || path.join(STREAMS_DIR, sid + '.jsonl');
    try { mainContent = fs.readFileSync(jsonlPath, 'utf-8'); } catch {}

    // Read subagents
    const subagents = {};
    const subagentDir = path.dirname(jsonlPath) + '/' + sid + '/subagents';
    try {
      const files = fs.readdirSync(subagentDir);
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          try {
            subagents[f] = fs.readFileSync(path.join(subagentDir, f), 'utf-8');
          } catch {}
        }
      }
    } catch {}

    sendOk(ws, id, { main: mainContent, subagents });
  } catch (err) {
    sendError(ws, id, 'read-history failed: ' + err.message);
  }
}

// ── Subscribe to subagent ──
function cmdSubscribeAgent(ws, id, cmd) {
  const { sid, agent, team, offsets } = cmd;
  if (!sid || !agent) return sendError(ws, id, 'subscribe-agent: missing sid or agent');

  const subKey = sid + ':' + agent;

  // Unsubscribe existing
  const existing = agentSubs.get(subKey);
  if (existing) {
    clearInterval(existing.timer);
    clearInterval(existing.rediscoverTimer);
    agentSubs.delete(subKey);
  }

  const sub = {
    files: new Map(), // filePath → { offset }
    timer: null,
    rediscoverTimer: null,
    ws,
    sid,
    agent,
    team,
  };

  // Discover agent JSONL files
  function discoverFiles() {
    try {
      // Look in session subagents dir
      const sessionDir = path.join(STREAMS_DIR, sid, 'subagents');
      try {
        const files = fs.readdirSync(sessionDir);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          // Match by agent name in filename
          if (f.toLowerCase().includes(agent.toLowerCase()) || f.includes(agent)) {
            const fullPath = path.join(sessionDir, f);
            if (!sub.files.has(fullPath)) {
              const startOffset = (offsets && offsets[f]) || 0;
              sub.files.set(fullPath, { offset: startOffset });
            }
          }
        }
      } catch {}

      // Also look in Claude canonical dir for the agent
      const homeDir = process.env.HOME || '/root';
      const claudeDir = path.join(homeDir, '.claude', 'projects');
      // We'd need the encoded CWD path — this is complex. For now, scan streams dir.
    } catch {}
  }

  // Poll for new data
  function pollData() {
    for (const [filePath, fileState] of sub.files) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > fileState.offset) {
          const fd = fs.openSync(filePath, 'r');
          const bytes = stat.size - fileState.offset;
          const buf = Buffer.alloc(bytes);
          fs.readSync(fd, buf, 0, bytes, fileState.offset);
          fs.closeSync(fd);
          fileState.offset = stat.size;

          const lines = buf.toString('utf-8').split('\\n').filter(l => l.trim());
          if (lines.length > 0) {
            sendEvent(ws, 'agent', {
              sid,
              agent,
              file: path.basename(filePath),
              lines,
            });
          }
        }
      } catch {}
    }
  }

  // Initial discovery + data send
  discoverFiles();
  pollData();

  // Start polling
  sub.timer = setInterval(pollData, AGENT_POLL_INTERVAL_MS);
  sub.rediscoverTimer = setInterval(discoverFiles, AGENT_REDISCOVER_INTERVAL_MS);

  agentSubs.set(subKey, sub);
  sendOk(ws, id, { subscribed: true, files: [...sub.files.keys()] });
}

// ── Unsubscribe from subagent ──
function cmdUnsubscribeAgent(ws, id, cmd) {
  const { sid, agent } = cmd;
  const subKey = sid + ':' + agent;
  const sub = agentSubs.get(subKey);
  if (sub) {
    clearInterval(sub.timer);
    clearInterval(sub.rediscoverTimer);
    agentSubs.delete(subKey);
  }
  sendOk(ws, id, { unsubscribed: true });
}

// ── Write to team inbox ──
function cmdWriteInbox(ws, id, cmd) {
  const { team, agent, from, text, summary } = cmd;
  if (!team || !agent || !text) return sendError(ws, id, 'write-inbox: missing fields');

  const homeDir = process.env.HOME || '/root';
  const inboxPath = path.join(homeDir, '.claude', 'teams', team, 'inboxes', agent + '.json');

  try {
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true });

    let inbox = [];
    try { inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf-8')); } catch {}
    if (!Array.isArray(inbox)) inbox = [];

    inbox.push({
      from: from || 'walnut',
      text,
      summary: summary || text.slice(0, 100),
      timestamp: new Date().toISOString(),
      read: false,
    });

    fs.writeFileSync(inboxPath, JSON.stringify(inbox, null, 2));
    sendOk(ws, id, { written: true });
  } catch (err) {
    sendError(ws, id, 'write-inbox failed: ' + err.message);
  }
}

// ── File system operations ──
function cmdFsRead(ws, id, cmd) {
  let filePath = cmd.path;
  const encoding = cmd.encoding;
  if (!filePath) return sendError(ws, id, 'fs.read: missing path');

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = (process.env.HOME || '/root') + filePath.slice(1);
  }

  try {
    const enc = encoding || 'base64';
    const data = fs.readFileSync(filePath);
    if (enc === 'base64') {
      sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64' });
    } else {
      sendOk(ws, id, { data: data.toString('utf-8'), encoding: 'utf-8' });
    }
  } catch (err) {
    sendError(ws, id, 'fs.read failed: ' + err.message);
  }
}

function cmdFsWrite(ws, id, cmd) {
  const { path: filePath, data, encoding } = cmd;
  if (!filePath || !data) return sendError(ws, id, 'fs.write: missing path or data');

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const enc = encoding || 'base64';
    const buf = enc === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf-8');
    fs.writeFileSync(filePath, buf);
    sendOk(ws, id, { written: true, size: buf.length });
  } catch (err) {
    sendError(ws, id, 'fs.write failed: ' + err.message);
  }
}

function cmdFsLs(ws, id, cmd) {
  let dirPath = cmd.path;
  if (!dirPath) return sendError(ws, id, 'fs.ls: missing path');

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (dirPath === '~' || dirPath.startsWith('~/')) {
    dirPath = (process.env.HOME || '/root') + dirPath.slice(1);
  }

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }));
    sendOk(ws, id, { entries: result, resolvedPath: dirPath });
  } catch (err) {
    sendError(ws, id, 'fs.ls failed: ' + err.message);
  }
}

function cmdFsFind(ws, id, cmd) {
  let basePath = cmd.path || '~/.claude/projects';
  const name = cmd.name;
  const maxDepth = cmd.maxDepth || 3;
  if (!name) return sendError(ws, id, 'fs.find: missing name');

  // Expand ~ to home directory
  if (basePath === '~' || basePath.startsWith('~/')) {
    basePath = (process.env.HOME || '/root') + basePath.slice(1);
  }

  try {
    const found = [];
    function walk(dir, depth) {
      if (depth > maxDepth || found.length >= 10) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isFile() && e.name.includes(name)) {
            found.push(full);
            if (found.length >= 10) return;
          } else if (e.isDirectory()) {
            walk(full, depth + 1);
          }
        }
      } catch {}
    }
    walk(basePath, 0);
    sendOk(ws, id, { files: found });
  } catch (err) {
    sendError(ws, id, 'fs.find failed: ' + err.message);
  }
}

// ── List all sessions ──
function cmdList(ws, id) {
  const result = [];

  // Scan streams dir for PGID files
  try {
    const files = fs.readdirSync(STREAMS_DIR);
    for (const f of files) {
      if (!f.endsWith('.pgid')) continue;
      const sid = f.replace('.pgid', '');
      try {
        const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, f), 'utf-8').trim(), 10);
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch {}

        let mtime = null, size = 0;
        try {
          const stat = fs.statSync(path.join(STREAMS_DIR, sid + '.jsonl'));
          mtime = stat.mtime.toISOString();
          size = stat.size;
        } catch {}

        result.push({ sid, pid, alive, mtime, size });
      } catch {}
    }
  } catch {}

  // Also include in-memory sessions not yet persisted
  for (const [sid, session] of sessions) {
    if (!result.find(r => r.sid === sid)) {
      let alive = false;
      if (session.pid) {
        try { process.kill(session.pid, 0); alive = true; } catch {}
      }
      result.push({
        sid,
        pid: session.pid,
        alive,
        mtime: null,
        size: 0,
      });
    }
  }

  sendOk(ws, id, { sessions: result });
}

// ── Protocol helpers ──
function sendOk(ws, id, data) {
  try { ws.send(JSON.stringify({ id, ok: true, ...data })); } catch {}
}

function sendError(ws, id, error) {
  logMsg('error', 'command error', { id, error });
  try { ws.send(JSON.stringify({ id, ok: false, error })); } catch {}
}

function sendEvent(ws, ev, data) {
  try { ws.send(JSON.stringify({ ev, ...data })); } catch {}
}

// ── Cleanup ──
function cleanup() {
  // Stop all watchers
  for (const [, session] of sessions) {
    for (const [, watcher] of session.watchers) {
      watcher.close();
    }
  }
  // Stop all agent subs
  for (const [, sub] of agentSubs) {
    clearInterval(sub.timer);
    clearInterval(sub.rediscoverTimer);
  }
  // Remove port/pid files
  try { fs.unlinkSync(PORT_FILE); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ── Main ──
const action = process.argv[2];

if (action === '--stop') {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    console.log('daemon stopped (pid=' + pid + ')');
  } catch {
    console.log('daemon not running');
  }
  process.exit(0);
}

if (action === '--status') {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    const port = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    console.log(JSON.stringify({ running: true, pid, port: parseInt(port, 10) }));
  } catch {
    console.log(JSON.stringify({ running: false }));
  }
  process.exit(0);
}

if (action === '--start') {
  // Check if already running
  try {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(existingPid, 0);
    const existingPort = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    console.log(existingPort); // Already running — return port
    process.exit(0);
  } catch {
    // Not running, continue to start
  }

  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.mkdirSync(STREAMS_DIR, { recursive: true });

  const httpServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('walnut-daemon ok');
  });

  const wss = createWsServer(httpServer);

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    resetIdleTimer();
    logMsg('info', 'client connected', { clients: wsClients.size });

    // Ping/pong keepalive
    const pingTimer = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
    }, PING_INTERVAL_MS);

    ws.on('message', (msg) => {
      resetIdleTimer();
      handleCommand(ws, typeof msg === 'string' ? msg : msg.toString());
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      clearInterval(pingTimer);

      // Clean up watchers for this client
      for (const [sid, session] of sessions) {
        stopWatching(ws, sid);
      }

      // Clean up agent subs for this client
      for (const [key, sub] of agentSubs) {
        if (sub.ws === ws) {
          clearInterval(sub.timer);
          clearInterval(sub.rediscoverTimer);
          agentSubs.delete(key);
        }
      }

      resetIdleTimer();
      logMsg('info', 'client disconnected', { clients: wsClients.size });
    });

    ws.on('error', (err) => {
      logMsg('error', 'ws error', { error: err.message });
    });
  });

  // Listen on random port (localhost only)
  httpServer.listen(0, '127.0.0.1', () => {
    const port = httpServer.address().port;
    fs.writeFileSync(PORT_FILE, String(port));
    fs.writeFileSync(PID_FILE, String(process.pid));
    console.log(port); // Print port for parent to capture
    logMsg('info', 'daemon started', { port, pid: process.pid });
    resetIdleTimer();
  });

  // Handle signals
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  // Detach from terminal (close stdin so SSH doesn't hold)
  if (process.stdin.isTTY === false) {
    process.stdin.resume();
    process.stdin.on('end', () => {}); // Don't exit on stdin close
  }
} else {
  console.error('Usage: node daemon.js --start | --stop | --status');
  process.exit(1);
}
`;
