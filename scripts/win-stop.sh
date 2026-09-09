#!/usr/bin/env bash
# Stop anything CastGood left running on Windows.
#
# Why this exists: Ctrl-C in an interactive terminal propagates into cmd.exe and
# stops the dev loop cleanly, but a *non-interactive* session (an agent running
# `timeout 60 scripts/win-run.sh`, a killed terminal) does not — Electron and Vite
# keep running on the Windows side with no window to close them from.
#
# Only processes whose path or command line is under C:\CastGood are touched, so
# this can never kill VS Code, Slack, or any other Electron app on the machine.
set -euo pipefail

WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"

log()  { printf '\033[36m[win-stop]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[win-stop] %s\033[0m\n' "$*" >&2; exit 1; }

command -v powershell.exe >/dev/null 2>&1 || fail "powershell.exe is not callable from WSL"

cd /mnt/c
killed="$(powershell.exe -NoProfile -NonInteractive -Command "
  \$targets = Get-CimInstance Win32_Process |
    Where-Object { \$_.Name -in 'electron.exe','node.exe' } |
    Where-Object { \$_.ExecutablePath -like '$WIN_DEST\\*' -or \$_.CommandLine -like '*$WIN_DEST*' }
  \$targets | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }
  (\$targets | Measure-Object).Count
" 2>/dev/null | tr -d '\r' | tail -n1)"

if [ "${killed:-0}" = "0" ]; then
  log "nothing was running from $WIN_DEST"
else
  log "stopped $killed process(es) running from $WIN_DEST"
fi
