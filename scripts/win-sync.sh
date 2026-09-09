#!/usr/bin/env bash
# Mirror the WSL working copy to the Windows runner copy at C:\CastGood.
#
# WSL2 is where code is edited and unit-tested. Windows is the only place the
# product ever runs — mDNS multicast and the TV's inbound TCP connection both
# fight WSL2's NAT, and Windows processes cannot use a \\wsl.localhost\ path as a
# working directory. Hence a mirror, and hence two node_modules trees: Electron
# is a Windows binary, esbuild/rollup/vitest are Linux ones.
#
# Only this script writes to C:\CastGood. It uses --delete, so the two copies
# cannot diverge; the Windows side is derived and disposable.
#
# Safe to re-run. Sub-second when nothing changed.
set -euo pipefail

SRC="${CASTGOOD_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"
LOCK_HASH_FILE="$DEST/.package-lock.sha256"

WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"

log()  { printf '\033[36m[win-sync]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[win-sync] %s\033[0m\n' "$*" >&2; exit 1; }

# Every Windows command starts with `cd /d C:\CastGood`, and cmd.exe itself is
# launched from a real Windows directory: started from a \\wsl.localhost\ path it
# prints "UNC paths are not supported" and silently defaults to C:\Windows.
win_cmd() { ( cd /mnt/c && cmd.exe /d /c "cd /d $WIN_DEST && $1" ); }

# --- Preconditions -----------------------------------------------------------
[ -f "$SRC/package.json" ] || fail "no package.json in $SRC — is CASTGOOD_SRC right?"

command -v rsync >/dev/null 2>&1 || fail "rsync is not installed. Run: sudo apt install rsync"

if [ ! -d /mnt/c ]; then
  fail "/mnt/c is not mounted. This script only makes sense inside WSL2 with the C: drive mounted."
fi

command -v cmd.exe >/dev/null 2>&1 || fail \
  "cmd.exe is not callable from WSL (interop off?). Check /proc/sys/fs/binfmt_misc/WSLInterop."

mkdir -p "$DEST" || fail "cannot create $DEST"

# Running these scripts out of the Windows mirror instead of the WSL working copy makes
# SRC and DEST the same directory, and the sync becomes a silent no-op: everything looks
# fine and you test whatever was last copied over. That has already cost one real
# hardware run, which reported on code that had been superseded.
if [ "$(readlink -f "$SRC")" = "$(readlink -f "$DEST")" ]; then
  fail "refusing to mirror $SRC onto itself.
    You are running from the Windows mirror ($DEST), so there is nothing to sync and
    you would be testing whatever was last copied there — not your current work.
    Run the script from the WSL working copy instead, e.g.:
      cd ~/CastGood && scripts/$(basename "${0}") ..."
fi

# --- Mirror ------------------------------------------------------------------
# node_modules: two platform-specific trees, never shared.
# .git:         the WSL copy is canonical; the runner never needs history.
# dist:         build output, produced independently on each side.
# .fixture:     SPIKE-1's HLS segments — hundreds of megabytes, made once on the Windows
#               side by ffmpeg and never in the source tree. Without this exclusion
#               `--delete` removes it on every sync, and the spike then refuses to run
#               against a fixture it has just been told to make. THROWAWAY: this line goes
#               with src/engine/spike/.
# resources/bin: the bundled ffmpeg.exe and ffprobe.exe — ~200 MB of Windows binaries,
#               fetched and SHA-256 verified by scripts/fetch-ffmpeg.mjs against the pin in
#               build/ffmpeg-pin.json. Each side fetches its own copy. Pushing them through
#               rsync would add ~200 MB to every win-run.sh, and `--delete` would remove
#               whatever the Windows side had fetched every time WSL had not fetched it —
#               so the installer would build without an encoder in it. Never in git either.
log "mirroring $SRC -> $DEST"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'coverage/' \
  --exclude '.package-lock.sha256' \
  --exclude '.fixture/' \
  --exclude 'resources/bin/' \
  "$SRC/" "$DEST/"

# --- Install on the Windows side, only when the lockfile actually changed -----
LOCK="$SRC/package-lock.json"
[ -f "$LOCK" ] || fail "package-lock.json is missing — run 'npm install' in WSL first"

NEW_HASH="$(sha256sum "$LOCK" | cut -d' ' -f1)"
OLD_HASH="$(cat "$LOCK_HASH_FILE" 2>/dev/null || echo none)"

if [ ! -d "$DEST/node_modules" ] || [ "$NEW_HASH" != "$OLD_HASH" ]; then
  if [ ! -d "$DEST/node_modules" ]; then
    log "no Windows node_modules yet — running npm ci (this downloads Electron, give it a minute)"
  else
    log "package-lock.json changed — running npm ci on the Windows side"
  fi
  if ! win_cmd "npm.cmd ci"; then
    fail "npm ci failed on the Windows side. Reproduce it by hand:
    cd /mnt/c && cmd.exe /c \"cd /d $WIN_DEST && npm.cmd ci\"
  Check that Node and npm exist on Windows as well as in WSL:
    cd /mnt/c && cmd.exe /c \"node -v && npm.cmd -v\""
  fi
  printf '%s\n' "$NEW_HASH" >"$LOCK_HASH_FILE"
  log "Windows dependencies installed"
else
  log "dependencies unchanged — skipping npm ci"
fi

# Electron's binary arrives via a postinstall download, which npm can skip quietly
# (cache state, a blocked network, ignore-scripts). Without it there is no app to
# run and the failure is confusing, so check for it explicitly and repair it.
if [ ! -f "$DEST/node_modules/electron/dist/electron.exe" ]; then
  log "Electron's Windows binary is missing — fetching it (~350 MB, one time)"
  win_cmd "node.exe node_modules\\electron\\install.js" \
    || fail "could not download Electron's binary. Check the network, then retry."
  [ -f "$DEST/node_modules/electron/dist/electron.exe" ] \
    || fail "electron.exe still missing at $DEST/node_modules/electron/dist/ after install.js"
  log "Electron binary in place"
fi

log "$WIN_DEST is up to date"
