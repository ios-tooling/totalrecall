#!/bin/sh
# Forwards one Claude Code or Codex hook event to Total Recall.
#
#   totalrecall-hook.sh <Event> [agent]      (the hook's JSON payload arrives on stdin)
#
# Settings come from the environment or from ~/.config/totalrecall/env (mode 600):
#   TOTALRECALL_INGEST_TOKEN=...                      required; without it the script does nothing
#   TOTALRECALL_URL=https://total-recall.stream       optional; this is the default
#
# Only SessionStart waits for the server (it returns context to inject, 3 s at most).
# Every other event is sent in the background, so a slow or unreachable server never
# delays a prompt or a turn. A hook must never break the turn it rides on: every
# failure here is silent and the exit status is always 0. Needs curl 7.87 or later.

event="${1:-}"
agent="${2:-claude}"
[ -n "$event" ] || exit 0

config="${TOTALRECALL_CONFIG:-$HOME/.config/totalrecall/env}"
# shellcheck disable=SC1090
[ -r "$config" ] && . "$config"
url="${TOTALRECALL_URL:-https://total-recall.stream}"
token="${TOTALRECALL_INGEST_TOKEN:-}"
payload="$(cat)"

# Codex expects JSON on stdout from Stop even when there is nothing to say.
quiet_exit() {
  [ "$agent" = "codex" ] && [ "$event" = "Stop" ] && printf '{}\n'
  exit 0
}
[ -n "$url" ] && [ -n "$token" ] || quiet_exit

# First string value of a top-level key; hook payload values are plain ids and paths.
field() {
  printf '%s' "$payload" | tr '\n' ' ' | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}
session="$(field session_id)"
[ -n "$session" ] || quiet_exit
cwd="$(field cwd)"
[ -n "$cwd" ] || cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

repo="$(git -C "$cwd" config --get remote.origin.url 2>/dev/null)"
[ -n "$repo" ] || repo="$cwd"

# The machine tag DevCenter writes; cloud containers have no name worth keeping.
machine="$(cat "$HOME/.claude/machine-tag" 2>/dev/null | head -n 1)"
if [ -z "$machine" ]; then
  if [ -n "${CLAUDE_CODE_REMOTE:-}" ]; then machine="cloud"; else machine="$(hostname -s 2>/dev/null || hostname)"; fi
fi
machine_name="$(scutil --get ComputerName 2>/dev/null || hostname)"

post() { # post <max seconds> [extra curl arguments...]
  limit="$1"
  shift
  printf '%s' "$payload" | curl -sS --max-time "$limit" -X POST "${url%/}/v1/events" \
    --url-query "event=$event" --url-query "agent=$agent" --url-query "machine=$machine" \
    --url-query "machineName=$machine_name" --url-query "repo=$repo" "$@" \
    -H "Authorization: Bearer $token" -H "content-type: application/json" --data-binary @- 2>/dev/null
}

json_string() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

case "$event" in
  SessionStart)
    # The server answers in the hook's own output format; print it only if it is one.
    reply="$(post 3 --url-query "format=hook")"
    case "$reply" in '{"hookSpecificOutput"'*) printf '%s\n' "$reply" ;; esac
    ;;
  UserPromptSubmit)
    # The turn id is made here, so the agent can be told it without waiting on the network.
    turn="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "$$-$(date +%s)")"
    (post 10 --url-query "turn=$turn" >/dev/null 2>&1 &)
    printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Total Recall captured this turn. Optional update_work enrichment: sessionKey `%s`, turnID `%s`, agentName `%s`, repoURL `%s`."}}\n' \
      "$(json_string "$session")" "$turn" "$(json_string "$agent")" "$(json_string "$repo")"
    ;;
  PreToolUse | PostToolUse | PostToolUseFailure)
    # One heartbeat a minute per session is plenty; an interrupted tool always goes through.
    stamp="${TMPDIR:-/tmp}/totalrecall-heartbeat-$(printf '%s' "$session" | tr -c 'A-Za-z0-9_-' '_')"
    if printf '%s' "$payload" | grep -q '"is_interrupt"[[:space:]]*:[[:space:]]*true'; then
      :
    elif [ -n "$(find "$stamp" -mmin -1 2>/dev/null)" ]; then
      exit 0
    fi
    : >"$stamp" 2>/dev/null
    (post 10 >/dev/null 2>&1 &)
    ;;
  Stop | StopFailure | Interrupt)
    # The working-tree check runs in the background too: git can be slow in a large checkout.
    (
      if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        if [ -n "$(git -C "$cwd" status --porcelain 2>/dev/null | head -n 1)" ]; then dirty=1; else dirty=0; fi
        post 10 --url-query "dirty=$dirty" >/dev/null 2>&1
      else
        post 10 >/dev/null 2>&1
      fi
    ) >/dev/null 2>&1 &
    quiet_exit
    ;;
  *)
    (post 10 >/dev/null 2>&1 &)
    ;;
esac
exit 0
