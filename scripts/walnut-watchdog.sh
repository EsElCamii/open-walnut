#!/usr/bin/env bash
# Open Walnut watchdog — health-checks the server on port 3456 and restarts if down.
# Invoked periodically by a LaunchAgent (see scripts/com.openwalnut.watchdog.plist).
# Exits 0 quickly when server is healthy, so it's cheap to run every 30s.

set -u

PORT="${WALNUT_PORT:-3456}"
WALNUT_DIR="${WALNUT_DIR:-$HOME/workplace/myCode/walnut}"
# Wedge detection: if the port is bound but /api/config keeps failing for N
# consecutive ticks (~N × 30s), the process is hung (event loop starved, deadlock,
# GC stuck, etc.). SIGKILL and restart. Default: 3 ticks ≈ 90s grace.
WEDGE_THRESHOLD="${WALNUT_WEDGE_THRESHOLD:-3}"
WEDGE_STATE_FILE="${WEDGE_STATE_FILE:-/tmp/open-walnut/wedge-count}"
# Node default heap is ~4GB — walnut OOMs ("Reached heap limit") within minutes
# with 2500+ tasks + sessions + memory index. Default to 32GB on this 48GB Mac,
# leaving ~16GB for the OS + everything else. Override with WALNUT_NODE_MAX_OLD_SPACE_MB.
NODE_MAX_OLD_SPACE_MB="${WALNUT_NODE_MAX_OLD_SPACE_MB:-32768}"
LOG_DIR="${WALNUT_LOG_DIR:-/tmp/open-walnut}"
LOG_FILE="$LOG_DIR/watchdog.log"
SERVER_LOG="$LOG_DIR/server.log"
HEALTH_URL="http://localhost:${PORT}/api/config"

# launchd gives us a near-empty PATH — enough for curl/lsof/zsh in this wrapper
# script. The spawned walnut itself inherits the user's full PATH via zsh
# (see the spawn block below).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

# Fast health check: 2s connect timeout, 3s total. Silent no-op when healthy.
if curl -sf -m 3 --connect-timeout 2 "$HEALTH_URL" >/dev/null 2>&1; then
  # Healthy — reset wedge counter and exit.
  [ -f "$WEDGE_STATE_FILE" ] && rm -f "$WEDGE_STATE_FILE"
  exit 0
fi

log "health check failed (${HEALTH_URL})"

if [ ! -f "$WALNUT_DIR/dist/cli.js" ]; then
  log "ERROR: $WALNUT_DIR/dist/cli.js not found. Run 'npm run build' first."
  exit 1
fi

# --- Wedge detection ---------------------------------------------------------
# If the port is bound but health failed, the process may be: (a) mid-startup
# (first 10-30s after spawn), or (b) wedged (event loop blocked, deadlock).
# Track consecutive failures; only force-kill once we've crossed the threshold.
bound_pid=""
if bound_pid=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1) && [ -n "$bound_pid" ]; then
  wedge_count=0
  [ -r "$WEDGE_STATE_FILE" ] && wedge_count=$(cat "$WEDGE_STATE_FILE" 2>/dev/null || echo 0)
  wedge_count=$((wedge_count + 1))
  mkdir -p "$(dirname "$WEDGE_STATE_FILE")"
  echo "$wedge_count" > "$WEDGE_STATE_FILE"

  if [ "$wedge_count" -lt "$WEDGE_THRESHOLD" ]; then
    log "port $PORT bound by PID $bound_pid but not responding (${wedge_count}/${WEDGE_THRESHOLD} — leaving alone, likely mid-startup)"
    exit 0
  fi

  log "WEDGED: port $PORT bound by PID $bound_pid, health failed ${wedge_count}× — SIGKILL and restart"
  kill -9 "$bound_pid" 2>/dev/null || true
  rm -f "$WEDGE_STATE_FILE"
  # Wait for port to actually free before spawning.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    log "ERROR: port $PORT still bound 10s after SIGKILL — bailing"
    exit 1
  fi
fi

log "starting server"

# --- Spawn walnut with full user shell environment ---------------------------
# LaunchAgent-spawned processes get a near-empty env. Walnut needs the user's
# real env for several things:
#   - AWS_BEARER_TOKEN_BEDROCK / ANTHROPIC_*  (provider auth)
#   - PATH containing ~/.local/bin / homebrew / etc.   (so `claude`, tools resolve)
#   - any user-defined exports added later
#
# We get that by running walnut inside a `zsh -c` that sources the user's
# login rcs, then `exec`s node. This way we don't maintain an allow-list;
# whatever is in the user's shell "just works".
#
# Optional override: ~/.open-walnut/watchdog.env is sourced AFTER .zshrc, so
# it can add/override vars without touching shell config. Common uses:
#   WALNUT_CLAUDE_DEBUG=0        # opt out of `claude -p --debug` (on by default)
#   CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose   # full fidelity in ~/.claude/debug/*
if command -v zsh >/dev/null 2>&1; then
  log "spawning via zsh (inherits user shell env)"
  (
    cd "$WALNUT_DIR" || exit 1
    nohup zsh -c '
      [ -r ~/.zshenv ] && source ~/.zshenv >/dev/null 2>&1
      [ -r ~/.zshrc ]  && source ~/.zshrc  >/dev/null 2>&1
      if [ -r ~/.open-walnut/watchdog.env ]; then
        set -a
        source ~/.open-walnut/watchdog.env
        set +a
      fi
      exec node --max-old-space-size='"$NODE_MAX_OLD_SPACE_MB"' dist/cli.js web --port '"$PORT"'
    ' >> "$SERVER_LOG" 2>&1 < /dev/null &
  )
else
  log "WARN: zsh not found — falling back to bare node spawn (minimal env)"
  (
    cd "$WALNUT_DIR" || exit 1
    nohup node --max-old-space-size="$NODE_MAX_OLD_SPACE_MB" dist/cli.js web --port "$PORT" >> "$SERVER_LOG" 2>&1 < /dev/null &
  )
fi

# Give the server a chance to bind, then log outcome.
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  sleep 1
  if curl -sf -m 2 --connect-timeout 1 "$HEALTH_URL" >/dev/null 2>&1; then
    log "server is up on port $PORT"
    exit 0
  fi
done

log "WARN: server did not respond within 15s — check $SERVER_LOG"
exit 0
