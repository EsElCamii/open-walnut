# Open Walnut — Personal Intelligent Butler

> **References**: [ARCHITECTURE.md](./ARCHITECTURE.md) | [src/core/AGENTS.md](./src/core/AGENTS.md) | [src/agent/AGENTS.md](./src/agent/AGENTS.md) | [web/src/AGENTS.md](./web/src/AGENTS.md) | [tests/AGENTS.md](./tests/AGENTS.md) | [src/logging/AGENTS.md](./src/logging/AGENTS.md)

## CRITICAL: Open Source Repository

**PUBLIC repo. Every commit is visible to the internet.**

No company-internal names, personal info, internal URLs, credentials, or internal processes. Generic descriptions only. Internal plugins go in `~/.open-walnut/plugins/` (never committed). **When in doubt, leave it out.**

## Multi-Agent Safety

- **NEVER** delete/revert other agents' changes or switch branches unless asked
- No `git stash`, no `git worktree` ops unless explicitly requested
- On "push": `git pull --rebase` OK. On "commit": scope to your changes only
- If build fails, retry — another agent may be mid-commit
- Bug investigations: read npm dep source + all related code before concluding
- Code style: brief comments for tricky logic; files under ~500 LOC

## Production Server Safety

**Port 3456 = PRODUCTION. NEVER kill, restart, or interfere.**

```bash
npm run dev:prod        # Build all → restart 3456 with latest code
npm run dev:ephemeral   # Ephemeral server (random port, temp data, auto-cleans)
```

### Watchdog (auto-restart on crash)

A macOS LaunchAgent (`com.openwalnut.watchdog`) health-checks `http://localhost:3456/api/config` every 30s and restarts the server if it's down. It's a no-op when the server is already healthy, so it won't interfere with manual `dev:prod` runs.

```bash
bash scripts/install-watchdog.sh install|uninstall|status
```

- Scripts: `scripts/walnut-watchdog.sh`, `scripts/com.openwalnut.watchdog.plist`
- Logs: `/tmp/open-walnut/watchdog.log` (watchdog), `/tmp/open-walnut/server.log` (auto-started server)
- Restart command: `zsh -c 'source ~/.zshrc && exec node dist/cli.js web --port 3456'` — spawned via zsh so walnut inherits the user's full shell env (PATH for `claude` / homebrew, AWS_BEARER_TOKEN_BEDROCK, ANTHROPIC_*, etc.). LaunchAgent's minimal env would otherwise break provider auth and CLI spawning.
- Override env without touching `.zshrc`: put KEY=VALUE lines in `~/.open-walnut/watchdog.env` (sourced after `.zshrc`).
- No rebuild on restart — assumes `dist/` is fresh. Run `npm run build` after source changes.

## What Is Walnut

Personal AI butler: tasks + knowledge + AI sessions. **Tasks are the atom.** `Category → Project → Task → Subtask`. Event Bus connects everything. See [ARCHITECTURE.md](./ARCHITECTURE.md).

### Key Rules for Implementation

- `create_task type=task` requires category AND project to exist first
- Phase: `TODO` → … → `AGENT_COMPLETE` → … → `COMPLETE` (agent sets AGENT_COMPLETE, human marks COMPLETE)
- **NEVER force-kill Claude Code processes** — bypasses on-stop hook
- Sessions displayed in **TWO places**: `/sessions` page + home slide-out — update both
- Concurrency: `tasks.json`/`sessions.json` use in-process + cross-process file locks

### Remote Session Daemon (resilience model)

**Topology:** walnut (Mac) ←ssh tunnel→ daemon (remote bun binary) ←spawn→ `claude -p` CLI. Goal: tunnel/daemon crashes don't lose sessions.

**Remote files:** `/tmp/open-walnut/sessions.json` (registry), `/tmp/open-walnut-streams/<sid>.{pipe,jsonl,pgid}`. JSONL is source of truth.

**CLI lifecycle:** `claude -p` exits 0 after each turn with `type=result` as last JSONL line — NOT long-running. Next send spawns new CLI with `--resume <sid>`.

**Daemon restart:** old `cleanup()` leaves CLI alive. New daemon reconciles sessions.json then scans `.pgid` files — scan MUST skip sids already adopted (`if (sessions.has(sid)) continue`). All death paths funnel into `reapSession()` in `daemon-core.ts`; it calls `isTurnCompleteExit()` to normalize code to 0 when JSONL tail shows clean turn completion (otherwise every turn-end shows "exit -1" in UI).

**Keep in sync:** `daemon-standalone.ts` (bun binary) + `daemon-source.ts` (JS fallback). Build: `bash scripts/build-daemon.sh`.

**Auto-deploy (use this):** `DaemonConnection` compares local `.version` vs remote `binary --version`; if differs, gzips + chunks binary into 1MB pieces, each via separate SSH connection (bypasses corp proxy that kills >5MB transfers), retries 2x per chunk, falls back to 44KB source deploy if chunked binary fails. Just `npm run build && bash scripts/build-daemon.sh && npm run dev:prod` — next UI send to that host auto-upgrades (old CLI processes survive via Phase C).

**Never scp manually** — corp SSH proxy (WSSH) kills large transfers. That's exactly what the chunked auto-deploy solves.

### Subsystem Map

| Subsystem | Entry point | Details |
|---|---|---|
| Agent loop & tools | `src/agent/` | [src/agent/AGENTS.md](./src/agent/AGENTS.md) |
| Sessions (local + SSH) | `src/providers/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Memory & search | `src/core/memory-*.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Event bus | `src/core/event-bus.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Subagents | `src/providers/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Cron | `src/core/cron/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Plugins | `src/core/integration-*.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Web GUI | `src/web/`, `web/src/` | [web/src/AGENTS.md](./web/src/AGENTS.md) |
| Chat history | `src/core/chat-history.ts` | [src/core/AGENTS.md](./src/core/AGENTS.md) |
| Usage tracking | `src/core/usage/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Git sync | `src/integrations/git-sync.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |

## Development

```bash
npm run build                 # Build server → dist/
cd web && npx vite build      # Build React SPA
cd web && npx vite            # Frontend hot reload (:5173, proxies to :3456)
npm test                      # All tests (parallel)
```

## E2E-First Development

**Before writing ANY code, design E2E verification first.**

- Bug fix: Playwright repro → fix → verify same flow → commit
- Feature: define E2E scenarios → implement → build → Playwright verify → commit
- **NEVER** commit UI changes without Playwright verification
- **NEVER** use `page.goto()` — use real UI clicks (SPA navigation)
- Use `/verify` after implementation

## Testing

Every feature needs 1+ real E2E test through `startServer({ port: 0, dev: true })`. Only mock the Claude CLI. See [tests/AGENTS.md](./tests/AGENTS.md).

## Conventions

Plans: architecture diagrams first → UX scenarios → pseudocode. No detailed implementation code in plans.

### Frontend logging: `import { log } from '@/utils/log'`

Use the structured logger (`log.info('subsystem', 'message', { sessionId, taskId })`) — never raw `console.log`. IDs must be **full, never truncated** so `grep <sessionId>` traces across browser + server. The logger routes through `console.log`/`warn`/`error` which the browser-logger monkey-patch forwards to `/tmp/open-walnut/`. Never use `console.debug` (invisible to forwarder).

## Debugging the Claude Code CLI (stuck / silent sessions)

When a session goes `idle` with no output, gets stuck mid-turn, or the CLI appears hung, check **Claude Code's own trace log**. Walnut passes `--debug` to every `claude -p` spawn by default, so this log is always available.

```bash
WALNUT_CLAUDE_DEBUG=0 npm run dev:prod    # opt out if you need to
```

The flag is added in `src/providers/claude-code-session.ts`. Works for both local and remote (daemon) sessions; args are forwarded through the daemon unchanged.

**Where logs land:**

| Session type | Path |
|---|---|
| Local | `~/.claude/debug/<claude-session-id>.txt` |
| Remote (daemon on clouddev etc.) | `~/.claude/debug/<claude-session-id>.txt` **on the remote host** |

A `latest` symlink in the same dir always points at the most recent file.

```bash
tail -F ~/.claude/debug/latest                         # follow local
ssh clouddev tail -F '~/.claude/debug/latest'          # follow remote
```

**Verbosity knobs** (also env vars — export before `npm run dev:prod`; for remote, set them where the daemon was started):

- `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` — include high-volume diagnostics (statusLine, shell, cwd, stdout/stderr). Default is `debug`, which filters those out.
- `CLAUDE_CODE_DEBUG_LOGS_DIR=/some/path` — override the `~/.claude/debug/` directory.
- `OTEL_LOG_TOOL_DETAILS=1` — capture full tool input/output in OTEL spans (separate from the `--debug` file).

**CLI flags** the fork supports (in case you want to invoke `claude` manually to repro):

- `--debug` / `-d` — enable debug mode (what Walnut injects)
- `--debug-file <path>` — write to a specific file (implicitly enables debug)
- `--debug-to-stderr` / `-d2e` — write debug to stderr instead of a file

The implementation lives in the fork at `~/workplace/myCode/claude-code-fork/claude-code-source-code/src/utils/debug.ts` — `logForDebugging()` is called throughout the CLI. All flags are already compiled into `fork-2.1.88`; no rebuild required.

### The "malware reminder" on every file read

If you're seeing `<system-reminder>Whenever you read a file, you should consider whether it would be considered malware…</system-reminder>` appended to every `Read` tool result, that's **not Walnut** — it's `@anthropic-ai/claude-agent-sdk`'s `CYBER_RISK_MITIGATION_REMINDER`. The SDK injects it unless the active main-loop model is in a hardcoded exempt set. Upstream only lists `claude-opus-4-6`; newer models (4.7, Sonnet, …) get the reminder on every read, eating context.

We maintain a `patch-package` patch at `patches/@anthropic-ai+claude-agent-sdk+<version>.patch` that **disables the reminder for all models** — it rewrites the ternary `X4z()?j4z:""` in the minified bundle to just `""`, so no file read ever appends the reminder regardless of main-loop model. It reapplies automatically on `npm install` via `postinstall`. When bumping the SDK version: re-apply the edit to `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (grep for `considered malware` to locate the template literal, then find and rewrite the ternary that conditionally appends it) and regenerate with `npx patch-package @anthropic-ai/claude-agent-sdk`.
