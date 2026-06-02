#!/usr/bin/env bash
#
# walnut-logs.sh — investigation toolkit for Walnut logs & sessions.
#
# Log layout (all under $LOG_DIR, default /tmp/open-walnut):
#   open-walnut-<YYYY-MM-DD>.log   structured JSON, one obj per line (PRIMARY — has time/traceId/reqId)
#   server.log                     human-readable mirror (HH:MM:SS LVL [subsystem] msg {json})
#   daemon-d-<pid>-<id>.log        per-daemon-instance JSON logs (remote/local session spawns)
#   sessions.json                  session registry
# Streams ($STREAMS_DIR, default /tmp/open-walnut-streams):
#   <sid>.jsonl / .jsonl.err / .pipe / .pgid   per-session CLI output (source of truth)
#
# Usage:
#   scripts/walnut-logs.sh session <sid>        full timeline for a session (enqueue→deliver→result)
#   scripts/walnut-logs.sh delivery [sid]       message enqueue→delivered latency table (all or one sid)
#   scripts/walnut-logs.sh slow [ms]            deliveries slower than <ms> (default 3000)
#   scripts/walnut-logs.sh req <reqId|traceId>  every log line carrying a request/trace id
#   scripts/walnut-logs.sh task <taskId>        every log line for a task
#   scripts/walnut-logs.sh daemon <sid>         which daemon log serves a sid + its lines
#   scripts/walnut-logs.sh jsonl <sid>          locate + tail a session's CLI .jsonl stream
#   scripts/walnut-logs.sh errors [n]           last n ERR/WARN lines (default 40)
#   scripts/walnut-logs.sh grep <pattern>       raw grep across today's JSON log
#   scripts/walnut-logs.sh tail [n]             follow the live JSON log (n lines back, default 40)
#
# No `-e`: this is an interactive query tool, and a grep that matches nothing
# (exit 1) is a normal "no results" outcome, not a fatal error — `-e` would
# abort the whole script and print nothing for a valid-but-empty query.
set -uo pipefail

LOG_DIR="${WALNUT_LOG_DIR:-/tmp/open-walnut}"
STREAMS_DIR="${WALNUT_STREAMS_DIR:-/tmp/open-walnut-streams}"
JSON_LOG="$LOG_DIR/open-walnut-$(date +%Y-%m-%d).log"

# Fall back to most recent dated log if today's doesn't exist yet.
if [[ ! -f "$JSON_LOG" ]]; then
  JSON_LOG="$(ls -t "$LOG_DIR"/open-walnut-*.log 2>/dev/null | head -1 || true)"
fi

die() { echo "error: $*" >&2; exit 1; }
need_log() { [[ -f "$JSON_LOG" ]] || die "no JSON log found in $LOG_DIR"; }

# Pretty-print selected fields from matching JSON lines: HH:MM:SS LVL [sub] message  {extras}
fmt() {
  jq -rc 'select(.time) |
    ((.time | sub("^.*T";"") | sub("\\..*$";""))) as $t |
    "\($t) \(.level[0:3]|ascii_upcase) [\(.subsystem // "?")] \(.message)" +
    ( [ to_entries[] | select(.key|test("^(time|level|subsystem|message)$")|not)
        | "\(.key)=\(.value|tostring)" ] | if length>0 then "  {"+join(" ")+"}" else "" end )'
}

cmd="${1:-}"; shift || true

case "$cmd" in
  session)
    sid="${1:?usage: session <sid>}"; need_log
    echo "── timeline for session $sid (from $JSON_LOG) ──"
    grep -aF "$sid" "$JSON_LOG" | fmt
    ;;

  delivery)
    need_log
    sid="${1:-}"
    echo "── enqueue→delivered latency (deliveryMs from 'message delivered' lines) ──"
    if [[ -n "$sid" ]]; then
      grep -aF "$sid" "$JSON_LOG" | grep -aF '"message delivered"' | \
        jq -rc '"\(.time|sub("^.*T";"")|sub("\\..*$";""))  path=\(.path)  deliveryMs=\(.deliveryMs)  count=\(.count)  msg=\(.messageId)  sid=\(.sessionId)"'
    else
      grep -aF '"message delivered"' "$JSON_LOG" | \
        jq -rc '"\(.time|sub("^.*T";"")|sub("\\..*$";""))  path=\(.path)  deliveryMs=\(.deliveryMs)  count=\(.count)  sid=\(.sessionId)"'
    fi
    ;;

  slow)
    need_log
    thresh="${1:-3000}"
    echo "── deliveries slower than ${thresh}ms ──"
    grep -aF '"message delivered"' "$JSON_LOG" | \
      jq -rc --argjson t "$thresh" 'select(.deliveryMs >= $t) |
        "\(.time|sub("^.*T";"")|sub("\\..*$";""))  deliveryMs=\(.deliveryMs)  path=\(.path)  sid=\(.sessionId)  msg=\(.messageId)"'
    ;;

  req)
    id="${1:?usage: req <reqId|traceId>}"; need_log
    echo "── lines carrying id $id ──"
    grep -aF "$id" "$JSON_LOG" | fmt
    ;;

  task)
    tid="${1:?usage: task <taskId>}"; need_log
    echo "── lines for task $tid ──"
    grep -aF "$tid" "$JSON_LOG" | fmt
    ;;

  daemon)
    sid="${1:?usage: daemon <sid>}"
    echo "── daemon logs serving $sid ──"
    for f in "$LOG_DIR"/daemon-d-*.log; do
      [[ -f "$f" ]] || continue
      if grep -aqF "$sid" "$f"; then
        echo; echo "### $f"
        grep -aF "$sid" "$f" | jq -rc '"\(.ts|sub("^.*T";"")|sub("\\..*$";""))  \(.msg)  \( {state:.newState,reason:.reason,pid:.pid}|tostring )"' 2>/dev/null \
          || grep -aF "$sid" "$f"
      fi
    done
    ;;

  jsonl)
    sid="${1:?usage: jsonl <sid>}"
    f="$STREAMS_DIR/$sid.jsonl"
    [[ -f "$f" ]] || die "no stream file at $f"
    echo "── $f ($(wc -l < "$f") lines, $(du -h "$f" | cut -f1)) — last 20 ──"
    tail -20 "$f"
    [[ -s "$STREAMS_DIR/$sid.jsonl.err" ]] && { echo "── stderr ($sid.jsonl.err) ──"; tail -20 "$STREAMS_DIR/$sid.jsonl.err"; }
    ;;

  errors)
    need_log; n="${1:-40}"
    echo "── last $n WARN/ERR lines ──"
    grep -aE '"level":"(warn|error)"' "$JSON_LOG" | tail -"$n" | fmt
    ;;

  grep)
    pat="${1:?usage: grep <pattern>}"; need_log
    grep -aF "$pat" "$JSON_LOG" | fmt
    ;;

  tail)
    need_log; n="${1:-40}"
    tail -n "$n" -F "$JSON_LOG" | fmt
    ;;

  *)
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
