#!/usr/bin/env bash
# "Deploy" for CastGood means: build the Windows installer.
#
# There is no server, no cloud account, and nothing running anywhere but the
# founder's PC (docs/DECISIONS.md — "Release means a Windows installer exists;
# delete the AWS scaffolding"). This script exists so /deploy and /ship keep
# meaning something honest rather than pointing at infrastructure that will never
# exist.
#
#   scripts/deploy.sh          build the installer into dist/installer/
#   scripts/deploy.sh --tag    …and tag the commit so the release workflow can
#                              attach the .exe to a GitHub Release
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"

log()  { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }

"$HERE/win-build.sh" || fail "the installer did not build — nothing to release"

VERSION="$(node -p "require('$SRC/package.json').version")"
log "built CastGood $VERSION"

if [ "${1:-}" = "--tag" ]; then
  command -v git >/dev/null 2>&1 || fail "git is not installed"
  [ -z "$(git -C "$SRC" status --porcelain)" ] || fail "working tree is dirty — commit first"

  BRANCH="$(git -C "$SRC" rev-parse --abbrev-ref HEAD)"
  [ "$BRANCH" = "main" ] || fail "releases are tagged from main; you are on $BRANCH"

  git -C "$SRC" tag -a "v$VERSION" -m "CastGood $VERSION"
  git -C "$SRC" push origin "v$VERSION"
  log "tagged v$VERSION and pushed. The release workflow attaches the installer and ffmpeg's GPL source."
else
  log "installer is in dist/installer/. Re-run with --tag to publish a GitHub Release."
fi

log "install it by double-clicking on the Windows side."
log "Unsigned by decision: SmartScreen shows 'Windows protected your PC' once ->"
log "More info -> Run anyway."
