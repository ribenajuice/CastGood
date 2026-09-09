#!/usr/bin/env bash
# Run the headless selftest on Windows from a WSL shell, and read the verdict here.
#
# This is the second of the three ways a session verifies real behaviour
# (CLAUDE.md): the log, the selftest, and the founder. It drives a scripted
# scenario against a real Chromecast and prints one JSON verdict.
#
#   scripts/win-test.sh --device "<device name>" \
#                       --file "C:\path\to\Bluey - The Sign.mp4" \
#                       --scenario m1
#
#   --scenario discovery|cast|transport|position|m1   (m1 runs all four in order)
#              seek|skip|recover|reattach|takeover|sourcegone|finish|resume
#              m2                                    (M2: all eight, in order)
#              check|remux|prepared|convert|headstart|prepfail
#              m3                                    (M3: all six, in order)
#
# `headstart` has three runs and two of them assert opposite things, so the verdict names
# which one it was. Plain: the gate must open and the film must play. `--rate 0.7`: the
# conversion is too slow to head-start, so the gate must stay **shut** and the app must say
# the film plays when it is done. `--rate-after-gate 0.5`: full speed until the film is
# playing, then below real time — the only way to make the margin guard hold a film on a
# real television, which is the mechanism 10b rests on.
#
#   --outage socket|heartbeat|cable   which failure `recover` produces (default: socket)
#
# `--outage cable` IS THE ONE THAT NEEDS YOU. socket and heartbeat need nobody: they kill
# our own connection to the television, and the app finds out instantly because the close
# is local. A real cable pull is silent — nothing closes, things just stop answering — and
# it is the only thing that can prove 11d (this PC losing its network). So the run prints
# what to do, in plain language, and watches this PC's own network for you doing it:
#
#   scripts/win-test.sh --device "<device name>" --file "C:\...\Cars.mp4" \
#                       --scenario recover --outage cable
#
# Stand at the PC. It asks you to unplug the Ethernet, notices by itself, asks you to keep
# it out for ~35 s, then asks for it back and times the film coming back on its own. There
# is nothing to press and no key to hit. About two minutes, and it says how long it will
# wait for you. If the cable never comes out, the run exits 2 ("could not happen") rather
# than blaming the app — and if the PC has wifi as well and Windows simply fails over, it
# says so and tells you to disable the adapter instead. `--outage cable` only works with
# `--scenario recover`; `m1` and `m2` refuse it, because they run unattended.
#
# `m2` runs `takeover` **last**, on purpose. A television that will not be taken over from
# a second connection is a run that could not happen (exit 2) — the PRD anticipates it and
# sends you to human checklist item 4 — and anything after an abort never runs at all. Last,
# an expected abort costs you nothing else. `m2` still only exits 0 if all eight ran and
# every promise held.
#
# `seek` needs a file of at least ~42 minutes, or it exits 2 rather than grading a
# 20-minute jump inside a short one — and `m2` checks that before it casts anything, so a
# too-short file costs you a message rather than an evening. `sourcegone` deletes what it
# plays, so it works on a copy in the temp directory and never touches the file you name
# here. `reattach` closes and reopens the app mid-film: it asserts that the reopened media
# server rebinds the *remembered* port and that the television really comes back to it for
# bytes, which is the half of story 12 a buffer can otherwise hide for a minute.
#   --no-sync    skip the mirror to C:\CastGood (re-run the same code faster)
#   --raw        print the verdict exactly as it came back, no pretty-printing
#   --json FILE  also write the verdict JSON to FILE, on the WSL side
#
# Everything else is passed through to `npm run selftest` untouched — this script
# knows nothing about which arguments are required. There are no defaults for
# --device and --file on purpose (PRD open question 3).
#
# THE EXIT CODE IS THE POINT (PRD 13c)
#   0  every assertion passed
#   1  an assertion failed
#   2  the run could not happen at all — device not found, file missing, port busy
# This script exits with whatever the selftest exited with, and every failure of
# its own is a 2. A run that could not reach a device must never look like a pass.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"
WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"

COULD_NOT_RUN=2

log()  { printf '\033[36m[win-test]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[win-test] %s\033[0m\n' "$*" >&2; exit "$COULD_NOT_RUN"; }

usage() {
  # The whole header block, however long it is. It was a fixed line range until
  # 2026-08-21, which meant every edit to the header silently cut `--help` somewhere new —
  # it was already ending mid-sentence, three lines into a paragraph about `seek`.
  awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}" >&2
}

# --- Arguments ---------------------------------------------------------------
# Ours are consumed; the rest go to the selftest in the order they were given.
sync=1
raw=0
json_out=""
passthrough=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --no-sync) sync=0; shift ;;
    --raw)     raw=1; shift ;;
    --json)
      [ $# -ge 2 ] || fail "--json needs a file path"
      json_out="$2"; shift 2 ;;
    --file)
      # Translate a WSL path to the Windows path the selftest will actually stat.
      # Typing `/mnt/c/...` here is the natural thing to do from WSL and it always
      # fails, because the selftest runs on the Windows side where that path does
      # not exist — it reports "file not found" for a file that is plainly there.
      [ $# -ge 2 ] || fail "--file needs a path"
      file_arg="$2"
      case "$file_arg" in
        /*)
          if command -v wslpath >/dev/null 2>&1 && converted="$(wslpath -w "$file_arg" 2>/dev/null)"; then
            log "translated --file to the Windows path: $converted"
            file_arg="$converted"
          else
            fail "--file looks like a WSL path but could not be converted: $file_arg
    Pass the Windows path instead, e.g. 'C:\\Users\\You\\Desktop\\film.mp4'."
          fi ;;
      esac
      passthrough+=("--file" "$file_arg"); shift 2 ;;
    *) passthrough+=("$1"); shift ;;
  esac
done

[ ${#passthrough[@]} -gt 0 ] || { usage; fail "no arguments for the selftest — it needs at least --device, --file and --scenario"; }

# --- Preconditions, checked before anything touches a TV ---------------------
command -v cmd.exe >/dev/null 2>&1 || fail \
  "cmd.exe is not callable from WSL (interop off?). Check /proc/sys/fs/binfmt_misc/WSLInterop."
[ -d /mnt/c ] || fail "/mnt/c is not mounted — this script only makes sense inside WSL2."

if [ "$sync" = "1" ]; then
  "$HERE/win-sync.sh" >&2 || fail "sync failed — fix that before running the selftest"
else
  log "--no-sync: running whatever is already in $WIN_DEST"
fi

[ -d "$DEST/node_modules" ] || fail \
  "no node_modules in $DEST. Run: scripts/win-sync.sh"

# npm exits 1 for "Missing script", which is indistinguishable from an assertion
# failure once it has crossed back into WSL. Rule that out here, where it can be
# reported as what it is: a mirror that has not caught up.
grep -q '"selftest"' "$DEST/package.json" 2>/dev/null || fail \
  "the copy in $WIN_DEST has no 'selftest' npm script — it is out of date. Run: scripts/win-sync.sh"

# Two rules for every Windows command (CLAUDE.md):
#   1. never launch cmd.exe from a \\wsl.localhost\ path — it warns "UNC paths are
#      not supported" and lands in C:\Windows
#   2. work in C:\CastGood
# The sibling scripts do this with `cd /mnt/c` plus `cd /d C:\CastGood` inside a
# single quoted command string. That is not usable here: this script has to pass
# through a device name with spaces, and a quote embedded in that string reaches
# cmd.exe as a literal \" (verified — `echo \"a b\"` prints \"a b\"). So instead
# each argument is passed as its own argv entry, which WSL interop quotes for
# Windows correctly, and the working directory is set on the WSL side: cd'ing to
# /mnt/c/CastGood makes the Windows process start in C:\CastGood. Same two rules,
# arrived at from the other end. Verified below rather than assumed.
cwd_seen="$( cd "$DEST" && cmd.exe /d /c cd 2>/dev/null | tr -d '\r' )"
shopt -s nocasematch
[[ "$cwd_seen" == "$WIN_DEST" ]] || fail \
  "Windows commands would run in '${cwd_seen:-nowhere}', not $WIN_DEST — refusing to run."
shopt -u nocasematch

# --- Run ---------------------------------------------------------------------
verdict_file="$(mktemp -t castgood-selftest-XXXXXX.json)"
trap 'rm -f "$verdict_file"' EXIT

log "running the selftest on Windows ($WIN_DEST):"
log "  npm run selftest -- ${passthrough[*]}"
log "this drives a real device. Do not touch the TV while it runs."

# --silent keeps npm's own banner off stdout, so stdout is only the verdict JSON.
# stderr streams straight through to this terminal so progress is visible live.
status=0
( cd "$DEST" && cmd.exe /d /c npm.cmd run --silent selftest -- "${passthrough[@]}" ) \
  >"$verdict_file" || status=$?

# --- Verdict -----------------------------------------------------------------
if [ -n "$json_out" ]; then
  cp -f "$verdict_file" "$json_out"
  log "verdict written to $json_out"
fi

verdict_seen=0
if [ ! -s "$verdict_file" ]; then
  log "the selftest printed no verdict on stdout (exit $status)."
elif command -v jq >/dev/null 2>&1 && jq -e . >/dev/null 2>&1 <"$verdict_file"; then
  verdict_seen=1
  if [ "$raw" = "1" ]; then cat "$verdict_file"; else jq . "$verdict_file"; fi
elif grep -qE '^[[:space:]]*\{' "$verdict_file"; then
  # jq is not installed, or the JSON is one object among other lines.
  verdict_seen=1
  cat "$verdict_file"
else
  log "stdout was not JSON — printing it as it came back:"
  cat "$verdict_file"
fi

# 0 and 1 are verdicts and mean something only if a verdict was printed. Anything
# else is a run that did not happen — reported as 2, never as a pass or a failure
# the app is responsible for.
if [ "$verdict_seen" = "0" ] && { [ "$status" = "0" ] || [ "$status" = "1" ]; }; then
  log "exit $status but no verdict object — nothing was proved, so this is a 2."
  log "the engine log has the detail: scripts/win-logs.sh"
  status=2
fi

case "$status" in
  0) printf '\033[32m[win-test] PASS — every assertion met its target (exit 0)\033[0m\n' >&2 ;;
  1) printf '\033[31m[win-test] FAIL — an assertion missed its target (exit 1)\033[0m\n' >&2 ;;
  2) printf '\033[31m[win-test] COULD NOT RUN — no verdict was reached (exit 2). This is not a failure of the app; nothing was proved.\033[0m\n' >&2 ;;
  *) printf '\033[31m[win-test] unexpected exit %s from the selftest — treat as no verdict\033[0m\n' "$status" >&2 ;;
esac

# Deliberately silent about where the verdict was saved. This line used to assert it
# had been written next to the engine log; on the founder's first real run no file was
# written at all and the claim was simply false. The selftest itself now reports the
# path it actually wrote (or that it could not), which is the only honest source.

# Faithfully, whatever it was.
exit "$status"
