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

## What Is Walnut

Personal AI butler: tasks + knowledge + AI sessions. **Tasks are the atom.** `Category → Project → Task → Subtask`. Event Bus connects everything. See [ARCHITECTURE.md](./ARCHITECTURE.md).

### Key Rules for Implementation

- `create_task type=task` requires category AND project to exist first
- Phase: `TODO` → … → `AGENT_COMPLETE` → … → `COMPLETE` (agent sets AGENT_COMPLETE, human marks COMPLETE)
- **NEVER force-kill Claude Code processes** — bypasses on-stop hook
- Sessions displayed in **TWO places**: `/sessions` page + home slide-out — update both
- Concurrency: `tasks.json`/`sessions.json` use in-process + cross-process file locks

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

### Frontend logging: `console.log` not `console.debug`

Browser logs are forwarded to the server log (`subsystem: "browser"`). `console.debug` is invisible to both Chrome's default filter and the log forwarder. **Always use `console.log`** in frontend code so logs appear in `/tmp/open-walnut/` for post-mortem debugging.
