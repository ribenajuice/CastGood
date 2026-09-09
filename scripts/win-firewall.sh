#!/usr/bin/env bash
# Inspect, add or remove CastGood's Windows Firewall rule, from WSL.
#
# The installer (build/installer.nsh) is what normally adds this rule. This
# script exists because that is otherwise invisible from WSL: it answers "did the
# rule actually land?" — the difference between a discovery bug and a blocked
# socket — and it can repair the rule without a reinstall.
#
#   scripts/win-firewall.sh            check (default): are the rules there?
#   scripts/win-firewall.sh --add      add them (Windows shows one UAC prompt)
#   scripts/win-firewall.sh --remove   remove them (one UAC prompt)
#   scripts/win-firewall.sh --add --program "C:\path\to\CastGood.exe"
#
# Exit codes: 0 the rules are present (or the action succeeded), 1 they are not,
# 2 the question could not be answered.
#
# build/installer.nsh is the source of truth for the rule; the constants below
# must match it. Firewall rules are machine-wide, so --add and --remove need
# administrator consent — checking does not.
set -euo pipefail

# Keep in step with build/installer.nsh and src/engine/config.ts (MEDIA_SERVER).
RULE_MDNS='CastGood (mDNS discovery)'
RULE_MEDIA='CastGood (media server)'
MEDIA_PORTS='8010-8029'

action="check"
program=""

log()  { printf '\033[36m[win-firewall]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[win-firewall] %s\033[0m\n' "$*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check)  action="check"; shift ;;
    --add)    action="add"; shift ;;
    --remove) action="remove"; shift ;;
    --program)
      [ $# -ge 2 ] || fail "--program needs a Windows path to CastGood.exe"
      program="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

command -v powershell.exe >/dev/null 2>&1 || fail "powershell.exe is not callable from WSL"
command -v cmd.exe >/dev/null 2>&1 || fail "cmd.exe is not callable from WSL"
[ -d /mnt/c ] || fail "/mnt/c is not mounted — this script only makes sense inside WSL2."

# Ask Windows for its own paths rather than guessing the user name. cmd.exe is
# launched from /mnt/c: from a \\wsl.localhost\ path it warns "UNC paths are not
# supported" and lands in C:\Windows.
win_var() { ( cd /mnt/c && cmd.exe /d /c "echo %$1%" 2>/dev/null | tr -d '\r' ); }

# --- check -------------------------------------------------------------------
if [ "$action" = "check" ]; then
  # Also prints the network profile: the rule is private-only by design, so a home
  # wifi that Windows has classified Public is blocked even with the rule present.
  out="$( cd /mnt/c && powershell.exe -NoProfile -NonInteractive -Command "
    \$ErrorActionPreference = 'Stop'
    foreach (\$name in @('$RULE_MDNS','$RULE_MEDIA')) {
      \$rule = Get-NetFirewallRule -DisplayName \$name -ErrorAction SilentlyContinue
      if (\$null -eq \$rule) { Write-Output \"MISSING|\$name\"; continue }
      \$app  = \$rule | Get-NetFirewallApplicationFilter
      \$port = \$rule | Get-NetFirewallPortFilter
      \$addr = \$rule | Get-NetFirewallAddressFilter
      Write-Output \"FOUND|\$name|enabled=\$(\$rule.Enabled)|profile=\$(\$rule.Profile)|dir=\$(\$rule.Direction)|action=\$(\$rule.Action)|program=\$(\$app.Program)|proto=\$(\$port.Protocol)|port=\$(\$port.LocalPort)|remote=\$(\$addr.RemoteAddress)\"
    }
    foreach (\$p in Get-NetConnectionProfile) { Write-Output \"NETWORK|\$(\$p.Name)|\$(\$p.NetworkCategory)\" }
  " 2>&1 | tr -d '\r' )" || fail "could not read the firewall rules:
$out"

  missing=0
  while IFS= read -r line; do
    case "$line" in
      FOUND\|*)   printf '  \033[32m✓\033[0m %s\n' "${line#FOUND|}" ;;
      MISSING\|*) printf '  \033[31m✗ missing:\033[0m %s\n' "${line#MISSING|}"; missing=1 ;;
      NETWORK\|*) printf '  network: %s\n' "${line#NETWORK|}" ;;
      *) [ -n "$line" ] && printf '  %s\n' "$line" ;;
    esac
  done <<<"$out"

  if [ "$missing" = "1" ]; then
    log "at least one rule is missing. Add it with: scripts/win-firewall.sh --add"
    log "(or reinstall — the installer adds it, unless /NOFIREWALL was used or the UAC prompt was declined)"
    exit 1
  fi
  log "both rules are present. If a network above is not 'Private', the rule does not apply to it."
  exit 0
fi

# --- add / remove ------------------------------------------------------------
# Written to a .cmd on the Windows side and run once through UAC: one prompt for
# the whole batch, and no quoting to mangle on the way through interop.
# The scripts start with `fltmc` as an elevation probe, because netsh returns 1
# both for "no rules match" and for "access denied" (verified), and a marker file
# is how this script learns the batch really did what it was asked.
win_temp="$(win_var TEMP)"
case "$win_temp" in *:\\*) : ;; *) fail "could not read %TEMP% from Windows (got: ${win_temp:-empty})" ;; esac
temp_dir="$(wslpath -u "$win_temp")"
[ -d "$temp_dir" ] || fail "$temp_dir does not exist"

script_wsl="$temp_dir/castgood-firewall.cmd"
marker_wsl="$temp_dir/castgood-firewall.ok"
script_win="$win_temp\\castgood-firewall.cmd"
rm -f "$marker_wsl"

if [ "$action" = "add" ]; then
  if [ -z "$program" ]; then
    win_lad="$(win_var LOCALAPPDATA)"
    case "$win_lad" in *:\\*) : ;; *) fail "could not read %LOCALAPPDATA% from Windows" ;; esac
    program="$win_lad\\Programs\\CastGood\\CastGood.exe"
  fi
  program_wsl="$(wslpath -u "$program" 2>/dev/null || echo '')"
  [ -n "$program_wsl" ] && [ -f "$program_wsl" ] || fail \
    "no CastGood.exe at $program — install CastGood first, or pass --program with the real path.
  A rule pointing at an executable that is not there allows nothing."

  {
    printf '@echo off\r\n'
    printf 'fltmc >nul 2>&1 || exit /b 1\r\n'
    printf 'netsh advfirewall firewall delete rule name="%s" >nul 2>&1\r\n' "$RULE_MDNS"
    printf 'netsh advfirewall firewall delete rule name="%s" >nul 2>&1\r\n' "$RULE_MEDIA"
    printf 'netsh advfirewall firewall add rule name="%s" dir=in action=allow program="%s" enable=yes profile=private protocol=UDP localport=5353 remoteip=LocalSubnet description="Lets CastGood find Chromecast devices on your home network." || exit /b 1\r\n' "$RULE_MDNS" "$program"
    printf 'netsh advfirewall firewall add rule name="%s" dir=in action=allow program="%s" enable=yes profile=private protocol=TCP localport=%s remoteip=LocalSubnet description="Lets your TV play video files from this PC." || exit /b 1\r\n' "$RULE_MEDIA" "$program" "$MEDIA_PORTS"
    printf 'echo ok> "%%~dp0castgood-firewall.ok"\r\n'
    printf 'exit /b 0\r\n'
  } >"$script_wsl"
  log "adding the rules for $program (private networks, LocalSubnet, inbound only)"
else
  {
    printf '@echo off\r\n'
    printf 'fltmc >nul 2>&1 || exit /b 1\r\n'
    printf 'netsh advfirewall firewall delete rule name="%s" >nul 2>&1\r\n' "$RULE_MDNS"
    printf 'netsh advfirewall firewall delete rule name="%s" >nul 2>&1\r\n' "$RULE_MEDIA"
    printf 'echo ok> "%%~dp0castgood-firewall.ok"\r\n'
    printf 'exit /b 0\r\n'
  } >"$script_wsl"
  log "removing CastGood's firewall rules"
fi

log "Windows will show a UAC prompt (Windows Command Processor) — approve it there."
( cd /mnt/c && powershell.exe -NoProfile -NonInteractive -Command \
    "Start-Process -FilePath '$script_win' -Verb RunAs -Wait -WindowStyle Hidden" ) \
  >/dev/null 2>&1 || true

rm -f "$script_wsl"

if [ -f "$marker_wsl" ]; then
  rm -f "$marker_wsl"
  log "done. Confirm with: scripts/win-firewall.sh --check"
  exit 0
fi

log "nothing changed — the UAC prompt was declined, or netsh refused."
exit 1
