#!/usr/bin/env bash
# Read the Windows-side engine log from WSL. "The eyes."
#
# The app runs on Windows; you are in WSL. The engine writes one JSON object per
# event to %LOCALAPPDATA%\CastGood\logs\engine-<date>.jsonl, and that path is
# readable from here. This is how a session verifies what actually happened —
# state transitions, cast messages, ffmpeg progress — without seeing the screen.
#
#   scripts/win-logs.sh            follow today's log
#   scripts/win-logs.sh --path     print the log directory and exit
#   scripts/win-logs.sh --raw      follow without pretty-printing
#
# The Windows user name is derived, never hardcoded.
set -euo pipefail

mode="${1:-follow}"

fail() { printf '\033[31m[win-logs] %s\033[0m\n' "$*" >&2; exit 1; }

command -v cmd.exe >/dev/null 2>&1 || fail "cmd.exe is not callable — is WSL interop enabled?"

# Ask Windows where %LOCALAPPDATA% is rather than guessing the user name.
# Run cmd.exe from /mnt/c: called from ~/CastGood (a \\wsl.localhost\ path) it prints
# "UNC paths are not supported" to stdout, which is non-empty, so the check below
# passes and wslpath then dies on the garbage under `set -e`.
win_local_appdata="$( cd /mnt/c && cmd.exe /d /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r' )"
case "$win_local_appdata" in
  *:\\*) : ;;
  *) fail "could not read %LOCALAPPDATA% from Windows (got: ${win_local_appdata:-empty})" ;;
esac

log_dir="$(wslpath -u "$win_local_appdata")/CastGood/logs"

if [ "$mode" = "--path" ]; then
  printf '%s\n' "$log_dir"
  exit 0
fi

[ -d "$log_dir" ] || fail "$log_dir does not exist yet — run the app once (scripts/win-run.sh)"

latest="$(ls -1t "$log_dir"/engine-*.jsonl 2>/dev/null | head -n1 || true)"
[ -n "$latest" ] || fail "no engine-*.jsonl in $log_dir yet — run the app once (scripts/win-run.sh)"

printf '\033[36m[win-logs]\033[0m following %s\n' "$latest"

if [ "$mode" = "--raw" ] || ! command -v jq >/dev/null 2>&1; then
  exec tail -f -n 50 "$latest"
fi

# One line per event: monotonic ms, level, event name, then the rest of the fields.
exec tail -f -n 50 "$latest" | jq -r --unbuffered \
  '"\(.mono | tostring | .[0:9]) \(.level | ascii_upcase) \(.event) \(del(.t,.mono,.seq,.level,.event) | tojson)"'
