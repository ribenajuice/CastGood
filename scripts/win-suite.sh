#!/usr/bin/env bash
# Run the whole hardware regression — all five aggregates — in one command.
#
# This is `scripts/win-test.sh` five times, in the order that works, with the
# preconditions checked first and one readable summary at the end. It exists
# because running them by hand on 2026-09-09 cost an hour to mistakes this
# script now makes impossible.
#
#   scripts/win-suite.sh --convert-device "<name>" --convert-file "<C:\...>" \
#                        --play-device    "<name>" --play-file    "<C:\...>"
#
# WHY TWO FILMS AND TWO TELEVISIONS, WHICH IS THE WHOLE POINT
# -----------------------------------------------------------
# The aggregates do not want the same film, and sending the wrong one costs a
# run rather than producing a useful failure.
#
#   --convert-file   A film the chosen television CANNOT play natively, so
#                    `m3` has a real conversion to grade. HEVC, 5.1, whatever
#                    that set refuses. Needs > 15 minutes.
#   --convert-device The set that must convert it. NOT a Chromecast Ultra for
#                    an HEVC film: the Ultra plays HEVC natively, so nothing
#                    converts and `m3` grades nothing.
#
#   --play-file      A film the chosen television plays UNTOUCHED — h264,
#                    stereo, mp4 — with a subtitle sidecar beside it. Needs
#                    >= 42 minutes for `m2`'s two 20-minute seeks, and ~10
#                    minutes of watchable film for `m1`'s position leg.
#   --play-device    Any set that plays it natively.
#
# ⚠️ On 2026-09-09 `m1` was given the 5.1 film on a Chromecast Ultra and exited
# 1 with `firstLaunchAttempts=0` — the profile caps that device at 2 channels
# (criterion 7j), so the film needed an audio conversion and `m1` does not
# prepare. Nothing was broken. The film was simply pointed at the wrong test,
# and an hour went with it. That is what `--convert-*` and `--play-*` prevent.
#
# WHAT RUNS, AND IN WHICH ORDER
# -----------------------------
#   m3      convert-device, convert-file   longest; run first
#   m1      play-device,    play-file
#   m2      play-device,    play-file
#   m3c     play-device,    play-file      needs the subtitle sidecar
#   volume  convert-device, play-file
#
# `m3` goes first because it is by far the longest and the most likely to be
# abandoned: finding out at minute 90 that the film was wrong is the failure
# mode this ordering exists to shorten.
#
# ONE SYNC, THEN NONE — AND THIS IS A CORRECTNESS PROPERTY, NOT A SPEED ONE
# -------------------------------------------------------------------------
# The tree is mirrored to Windows ONCE, before the first run, and every run
# after that uses `--no-sync`. So all five aggregates are guaranteed to have
# executed the SAME BUILD.
#
# Criterion 23j asks for four aggregates passing "with no assertion edited",
# which only means anything if they ran against one build. Running them
# one-by-one by hand does not guarantee that: any edit between two runs is
# picked up by the next `win-test.sh`, silently, because it syncs first. This
# script removes that possibility rather than asking anyone to remember it.
#
# THE EXIT CODE IS THE POINT (PRD 13c)
#   0  every aggregate passed
#   1  at least one assertion missed its target, and none was a non-run
#   2  at least one run could not happen at all — and 2 always wins
# A suite that could not reach a television must never look like a pass, so a
# single 2 anywhere makes the whole suite a 2 even if everything else passed.
#
#   --only a,b,c   run just these (m3,m1,m2,m3c,volume)
#   --keep-going   run the rest after a failure (default: stop at the first)
#   --summary FILE write the markdown summary here as well as printing it
#   --skip-preflight  run anyway; for when you know better than the checks
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"

COULD_NOT_RUN=2

log()  { printf '\033[36m[win-suite]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[win-suite] %s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31m[win-suite] %s\033[0m\n' "$*" >&2; exit "$COULD_NOT_RUN"; }

usage() {
  awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}" >&2
}

convert_device=""; convert_file=""
play_device="";    play_file=""
only=""; keep_going=0; summary_file=""; preflight=1

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --convert-device) [ $# -ge 2 ] || fail "--convert-device needs a name"; convert_device="$2"; shift 2 ;;
    --convert-file)   [ $# -ge 2 ] || fail "--convert-file needs a path";   convert_file="$2";   shift 2 ;;
    --play-device)    [ $# -ge 2 ] || fail "--play-device needs a name";    play_device="$2";    shift 2 ;;
    --play-file)      [ $# -ge 2 ] || fail "--play-file needs a path";      play_file="$2";      shift 2 ;;
    --only)           [ $# -ge 2 ] || fail "--only needs a list";           only="$2";           shift 2 ;;
    --summary)        [ $# -ge 2 ] || fail "--summary needs a file path";   summary_file="$2";   shift 2 ;;
    --keep-going)     keep_going=1; shift ;;
    --skip-preflight) preflight=0; shift ;;
    *) fail "unknown argument: $1  (try --help)" ;;
  esac
done

# No defaults for a device or a film, deliberately — PRD open question 3, and the
# same reason win-test.sh has none. A suite that guesses which television to drive
# is a suite that casts to somebody else's evening.
[ -n "$convert_device" ] || fail "--convert-device is required (try --help)"
[ -n "$convert_file"   ] || fail "--convert-file is required (try --help)"
[ -n "$play_device"    ] || fail "--play-device is required (try --help)"
[ -n "$play_file"      ] || fail "--play-file is required (try --help)"

# --- which aggregates, and what each one is handed --------------------------
all=(m3 m1 m2 m3c volume)
if [ -n "$only" ]; then
  IFS=',' read -r -a all <<< "$only"
fi

device_for() {
  case "$1" in
    m3|volume) printf '%s' "$convert_device" ;;
    *)         printf '%s' "$play_device" ;;
  esac
}
file_for() {
  case "$1" in
    m3) printf '%s' "$convert_file" ;;
    *)  printf '%s' "$play_file" ;;
  esac
}

# --- preflight ---------------------------------------------------------------
# Every check here is something that cost real time on 2026-09-09, and every
# failure is a 2 with a sentence rather than a red run an hour later.
win_to_wsl() {
  # "D:\DUMP\Movies\x.mkv" -> /mnt/d/DUMP/Movies/x.mkv, so the file can be stat'd
  # from here. Best effort: if it does not look like a Windows path, say nothing.
  local p="$1"
  case "$p" in
    [A-Za-z]:\\*|[A-Za-z]:/*)
      local drive="${p%%:*}"
      local rest="${p#*:}"
      rest="${rest//\\//}"
      printf '/mnt/%s%s' "$(printf '%s' "$drive" | tr '[:upper:]' '[:lower:]')" "$rest" ;;
    *) printf '' ;;
  esac
}

if [ "$preflight" = "1" ]; then
  log "preflight"

  [ -d "$DEST" ] || fail "$DEST does not exist — is this the right machine? (CASTGOOD_WIN_DIR overrides)"

  # Anything already running from C:\CastGood holds the media-server port, and a
  # selftest that cannot bind it exits 2 after doing nothing.
  if command -v tasklist.exe >/dev/null 2>&1 && tasklist.exe 2>/dev/null | grep -qi 'castgood'; then
    fail "CastGood is already running on Windows — it holds the media server port.
    Close it (or scripts/win-stop.sh) and run this again."
  fi

  for spec in "convert:$convert_file" "play:$play_file"; do
    kind="${spec%%:*}"; f="${spec#*:}"
    w="$(win_to_wsl "$f")"
    if [ -n "$w" ]; then
      [ -f "$w" ] || fail "--${kind}-file does not exist: $f
    (looked at $w)"
    else
      warn "--${kind}-file is not a Windows path, so it could not be checked here: $f"
    fi
  done

  # A film with a `(CastGood).mp4` sibling is already prepared, so `m3` finds it
  # ready and grades no conversion at all. Move the sibling aside — never delete
  # it; that is the cheap recovery, and it is why this is a refusal, not a hint.
  cw="$(win_to_wsl "$convert_file")"
  if [ -n "$cw" ]; then
    sibling="${cw%.*} (CastGood).mp4"
    if [ -e "$sibling" ]; then
      aside="$(dirname "$sibling")/_castgood-prepared-aside"
      fail "the convert film is already prepared, so m3 would grade nothing:
    $sibling
    Move it aside — never delete it; a prepared film is only disqualified while
    the sibling sits beside it, so a move is the whole cost of a wasted run:
      mkdir -p '$aside'
      mv '$sibling' '$aside/'"
    fi
    # Conversions are large and they accumulate. The v1 installer build died on
    # ENOSPC with C: at zero bytes after one evening of them.
    avail_kb="$(df -Pk "$(dirname "$cw")" 2>/dev/null | awk 'NR==2 {print $4}')" || avail_kb=""
    if [ -n "$avail_kb" ] && [ "$avail_kb" -lt 20971520 ]; then
      warn "only $((avail_kb / 1048576)) GB free where the convert film lives — a full run of m3 may not fit."
    fi
  fi

  log "preflight passed"
fi

# --- run ---------------------------------------------------------------------
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
declare -a names=() codes=() scores=() devices=()
worst=0
sync_arg=""   # empty for the first run, --no-sync for every one after it

for scenario in "${all[@]}"; do
  dev="$(device_for "$scenario")"
  fil="$(file_for "$scenario")"
  log "── $scenario · $dev ──"

  out="$(mktemp)"
  set +e
  # shellcheck disable=SC2086
  "$HERE/win-test.sh" $sync_arg --device "$dev" --file "$fil" --scenario "$scenario" 2>&1 | tee "$out"
  code="${PIPESTATUS[0]}"
  set -e
  sync_arg="--no-sync"

  score="$(grep -oE '[0-9]+/[0-9]+ promises met' "$out" | tail -1 | awk '{print $1}')"
  [ -n "$score" ] || score="—"
  fails="$(grep -cE '^  FAIL' "$out" || true)"

  names+=("$scenario"); codes+=("$code"); scores+=("$score"); devices+=("$dev")

  # 2 always wins: a run that never reached a television outranks any number of
  # passing assertions elsewhere.
  if [ "$code" = "2" ]; then worst=2
  elif [ "$code" != "0" ] && [ "$worst" != "2" ]; then worst=1
  fi

  rm -f "$out"

  if [ "$code" != "0" ] && [ "$keep_going" = "0" ]; then
    warn "$scenario exited $code — stopping. Use --keep-going to run the rest anyway."
    break
  fi
done

# --- summary -----------------------------------------------------------------
verdict_line() {
  case "$1" in
    0) printf 'passed' ;;
    1) printf '**FAILED** — an assertion missed' ;;
    2) printf '**COULD NOT RUN** — nothing was proved' ;;
    *) printf '**unexpected exit %s**' "$1" ;;
  esac
}

sum="$(mktemp)"
{
  printf '# CastGood hardware suite — %s\n\n' "$started_at"
  printf '| scenario | television | promises | verdict |\n'
  printf '| --- | --- | --- | --- |\n'
  for i in "${!names[@]}"; do
    printf '| `%s` | %s | %s | %s |\n' \
      "${names[$i]}" "${devices[$i]}" "${scores[$i]}" "$(verdict_line "${codes[$i]}")"
  done
  printf '\n'
  if [ "${#names[@]}" -lt "${#all[@]}" ]; then
    printf '⚠️ Stopped early: %d of %d aggregates ran.\n\n' "${#names[@]}" "${#all[@]}"
  fi
  case "$worst" in
    0) printf 'All %d passed, against one build.\n' "${#names[@]}" ;;
    1) printf 'At least one assertion missed its target. Nothing here could not run.\n' ;;
    2) printf '⚠️ At least one run could not happen. **A suite containing a 2 is a 2** — nothing was proved by the runs that did pass.\n' ;;
  esac
} > "$sum"

printf '\n'
cat "$sum"
if [ -n "$summary_file" ]; then
  cp "$sum" "$summary_file"
  log "summary written to $summary_file"
fi
rm -f "$sum"

exit "$worst"
