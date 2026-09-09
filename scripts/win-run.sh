#!/usr/bin/env bash
# Run CastGood on Windows from a WSL shell: sync, then start the dev loop there.
#
# The app never runs in WSL. This is the command that puts a window on the screen.
# Vite and Electron both run on the Windows side; their stdout/stderr stream back
# into this terminal, so a session in WSL sees the app's output live. For what the
# engine did, read the JSONL log: scripts/win-logs.sh
#
# Ctrl-C here stops the Windows-side processes. If this script is killed
# non-interactively (a timeout, a closed terminal), they survive — run
# scripts/win-stop.sh to clean up.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"
WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"

log()  { printf '\033[36m[win-run]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[win-run] %s\033[0m\n' "$*" >&2; exit 1; }

"$HERE/win-sync.sh" || fail "sync failed — fix that before trying to run"

[ -d "$DEST/node_modules/electron" ] || fail \
  "Electron is not installed on the Windows side ($DEST/node_modules/electron missing).
  Run: scripts/win-sync.sh"

log "starting the dev loop on Windows ($WIN_DEST). Ctrl-C to stop."
log "a window should appear on the Windows desktop; nothing will appear in WSL."
log "to see what the engine did, in another shell: scripts/win-logs.sh"

# Two rules for every Windows command:
#   1. launch cmd.exe from a real Windows directory — started from \\wsl.localhost\
#      it warns "UNC paths are not supported" and defaults to C:\Windows
#   2. `cd /d C:\CastGood` first — that is what the mirror exists for
cd /mnt/c
exec cmd.exe /d /c "cd /d $WIN_DEST && npm.cmd run dev"
