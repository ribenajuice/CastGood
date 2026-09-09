#!/usr/bin/env bash
# Build the Windows installer: sync, run electron-builder on Windows, bring the
# .exe back into the WSL working copy at ~/CastGood/dist/.
#
# This is what "release" means in this project — there is no deploy. The installer
# is unsigned by decision (docs/DECISIONS.md); Windows SmartScreen warns once.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"
WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"
OUT_DIR="$SRC/dist/installer"

log()  { printf '\033[36m[win-build]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[win-build] %s\033[0m\n' "$*" >&2; exit 1; }

"$HERE/win-sync.sh" || fail "sync failed — fix that before building"

# Clear both output directories first. win-sync.sh excludes dist/, and electron-builder
# does not empty it either, so a previous version's .exe survives a version bump and
# gets copied back and reported alongside the new one — an easy way to hand someone a
# stale build. Starting empty means anything present afterwards came from this run.
shopt -s nullglob
for stale in "$DEST"/dist/installer/*.exe "$OUT_DIR"/*.exe; do
  rm -f "$stale"
done

log "building the NSIS installer on Windows (first run downloads electron-builder's toolchain)"
# Launched from /mnt/c so cmd.exe does not start in a UNC path; `cd /d` does the rest.
( cd /mnt/c && cmd.exe /d /c "cd /d $WIN_DEST && npm.cmd run build:win" ) \
  || fail "electron-builder failed on the Windows side. Reproduce it directly with:
    cd /mnt/c && cmd.exe /c \"cd /d $WIN_DEST && npm.cmd run build:win\""

installers=("$DEST"/dist/installer/*.exe)
[ ${#installers[@]} -gt 0 ] || fail "the build reported success but produced no .exe in $DEST/dist/installer"

mkdir -p "$OUT_DIR"
cp -f "${installers[@]}" "$OUT_DIR/"

log "installer(s) copied back to $OUT_DIR:"
for f in "${installers[@]}"; do
  printf '  %s (%s)\n' "$OUT_DIR/$(basename "$f")" "$(du -h "$f" | cut -f1)"
done
log "install it by double-clicking on Windows. SmartScreen: More info -> Run anyway (unsigned, by decision)."
